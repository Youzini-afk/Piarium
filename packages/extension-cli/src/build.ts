import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import type {
  PiariumExtensionHostEntrypoint,
  PiariumExtensionSurfaceEntrypoint,
} from "@piarium/extension-contract";
import { entrypointSourcePath, entrypointTargetPath, loadProject } from "./project.js";
import type { BuildOutput, BuildResult, LoadedExtensionProject } from "./types.js";

interface EsbuildBuildOptions {
  absWorkingDir: string;
  bundle: boolean;
  entryPoints: string[];
  format: "cjs" | "esm";
  metafile: boolean;
  outfile: string;
  platform: "browser" | "node";
  sourcemap: false;
  target: string[];
}

interface EsbuildResult {
  metafile?: unknown;
}

interface EsbuildModule {
  build(options: EsbuildBuildOptions): Promise<EsbuildResult>;
}

const require = createRequire(import.meta.url);

const loadEsbuild = async (): Promise<EsbuildModule> => {
  let module: Partial<EsbuildModule>;
  try {
    module = require("esbuild") as Partial<EsbuildModule>;
  } catch {
    const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    module = await load("esbuild") as Partial<EsbuildModule>;
  }
  if (typeof module.build !== "function") throw new Error("The esbuild dependency is not available; install @piarium/extension-cli dependencies first.");
  return module as EsbuildModule;
};

const logical = (project: LoadedExtensionProject, file: string): string => relative(project.directory, file).split("\\").join("/");

const samePath = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const targetFormat = (project: LoadedExtensionProject, target: string): "cjs" | "esm" => {
  const extension = extname(target).toLowerCase();
  if (extension === ".cjs") return "cjs";
  if (extension === ".mjs") return "esm";
  return project.packageJson.type === "module" ? "esm" : "cjs";
};

const buildEntrypoint = async (
  project: LoadedExtensionProject,
  esbuild: EsbuildModule,
  entrypoint: PiariumExtensionHostEntrypoint | PiariumExtensionSurfaceEntrypoint,
  id: string,
  kind: "host" | "surface",
): Promise<BuildOutput> => {
  if (!entrypoint.file) throw new Error(`Entrypoint ${id} is executable but does not declare a file`);
  const source = entrypointSourcePath(project, id, entrypoint.file);
  const target = entrypointTargetPath(project, entrypoint.file);
  try {
    await access(source);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      throw new Error(`Source file for ${kind} entrypoint ${id} is missing: ${logical(project, source)}. Add it or update package.json piarium.build.entrypoints.${id}.source.`);
    }
    throw error;
  }
  const format = targetFormat(project, entrypoint.file);
  const outputDirectory = target.slice(0, Math.max(target.lastIndexOf("\\"), target.lastIndexOf("/")));
  if (outputDirectory) await mkdir(outputDirectory, { recursive: true });

  const temporaryRoot = samePath(source, target) ? await mkdtemp(join(tmpdir(), "piarium-extension-cli-")) : undefined;
  const temporaryOutput = temporaryRoot ? join(temporaryRoot, `bundle${extname(target) || ".js"}`) : target;
  try {
    const result = await esbuild.build({
      absWorkingDir: project.directory,
      bundle: true,
      entryPoints: [source],
      format,
      metafile: true,
      outfile: temporaryOutput,
      platform: kind === "host" ? "node" : "browser",
      sourcemap: false,
      target: kind === "host" ? ["node22"] : ["es2022"],
    });
    if (!result.metafile) throw new Error(`esbuild returned no metadata for ${kind} entrypoint ${id}`);
    if (temporaryOutput !== target) {
      const bytes = await readFile(temporaryOutput);
      await writeFile(target, bytes);
    }
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { force: true, recursive: true });
  }
  return { entrypointId: id, file: logical(project, target), kind, mode: kind === "host" ? "node" : "browser" };
};

export const buildProject = async (directory = "."): Promise<BuildResult> => {
  const project = await loadProject(directory);
  const esbuild = await loadEsbuild();
  const outputs: BuildOutput[] = [];
  const host = project.manifest.entrypoints?.host;
  if (host) outputs.push(await buildEntrypoint(project, esbuild, host, "host", "host"));
  for (const surface of project.manifest.entrypoints?.surfaces ?? []) {
    if (surface.mode === "declarative") continue;
    outputs.push(await buildEntrypoint(project, esbuild, surface, surface.id, "surface"));
  }
  return { outputs, project };
};
