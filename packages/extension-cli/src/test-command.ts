import { buildProject } from "./build.js";
import { checkProject } from "./project.js";
import type { PiariumIsolatedSurfaceModule, PiariumManagedSurfaceModule } from "@piarium/extension-sdk";
import {
  resolveHostExtensionModule,
  resolveIsolatedExtensionModule,
  resolveSurfaceExtensionModule,
} from "@piarium/extension-sdk";
import { SurfaceExtensionRuntime } from "@piarium/extension-surface";
import {
  runHostExtensionConformance,
  runIsolatedExtensionConformance,
  runSurfaceExtensionConformance,
} from "@piarium/extension-sdk/testing";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { entrypointTargetPath } from "./project.js";
import type { TestResult } from "./types.js";

const require = createRequire(import.meta.url);

const moduleFromFile = async (path: string): Promise<Record<string, unknown>> => {
  if (path.toLowerCase().endsWith(".cjs")) return require(path) as Record<string, unknown>;
  const loaded = await import(pathToFileURL(path).href) as Record<string, unknown>;
  return loaded;
};

const runSurfaceConformance = async (
  projectId: string,
  version: string,
  entrypointId: string,
  supports: readonly ("desktop" | "mobile" | "vscode" | "web")[],
  mode: "managed" | "isolated" | "native",
  module: PiariumManagedSurfaceModule,
): Promise<void> => {
  if (mode === "isolated") return;
  const extension = resolveSurfaceExtensionModule(module);
  const surface = supports[0] ?? "web";
  const runtime = new SurfaceExtensionRuntime({ surface });
  const hostId = "00000000-0000-4000-8000-000000000001";
  await runSurfaceExtensionConformance({
    activation: (context) => extension.activate({
      ...context,
      assets: {
        read: async (path) => ({ bytes: new Uint8Array(), contentType: "application/octet-stream", integrity: `sha256-${"0".repeat(64)}`, path }),
        url: async () => "mock://piarium-extension-asset",
      },
      styles: { use: async () => undefined },
    }),
    owner: {
      desiredRevision: 1,
      entrypointId,
      extensionId: projectId,
      extensionVersion: version,
      generation: 0,
      hostId,
      realmId: "piarium-cli-test",
    },
    runtime,
  });
};

export const testProject = async (directory = "."): Promise<TestResult> => {
  await checkProject(directory);
  const built = await buildProject(directory);
  const checked = await checkProject(directory);
  if (checked.missingFiles.length > 0) {
    throw new Error(`Build did not produce manifest entrypoint files: ${checked.missingFiles.join(", ")}`);
  }
  const project = built.project;
  const surfaces: TestResult["surfaces"] = [];
  for (const entrypoint of project.manifest.entrypoints?.surfaces ?? []) {
    if (entrypoint.mode === "declarative") {
      surfaces.push({ entrypointId: entrypoint.id, mode: entrypoint.mode, result: "passed" });
      continue;
    }
    if (!entrypoint.file) throw new Error(`Surface entrypoint ${entrypoint.id} does not declare a file`);
    const target = entrypointTargetPath(project, entrypoint.file);
    if (entrypoint.mode === "isolated") {
      const extension = resolveIsolatedExtensionModule(
        await moduleFromFile(target) as PiariumIsolatedSurfaceModule,
      );
      await runIsolatedExtensionConformance({ activation: extension.activate });
    } else {
      const module = await moduleFromFile(target);
      await runSurfaceConformance(
        project.manifest.id,
        project.manifest.version,
        entrypoint.id,
        entrypoint.supports,
        entrypoint.mode,
        module as PiariumManagedSurfaceModule,
      );
    }
    surfaces.push({
      entrypointId: entrypoint.id,
      mode: entrypoint.mode,
      result: "passed",
    });
  }
  let host: TestResult["host"] = "skipped";
  const hostEntrypoint = project.manifest.entrypoints?.host;
  if (hostEntrypoint) {
    if (!hostEntrypoint.file) throw new Error("Host entrypoint does not declare a file");
    const module = await moduleFromFile(entrypointTargetPath(project, hostEntrypoint.file));
    const extension = resolveHostExtensionModule(module);
    await runHostExtensionConformance({ activation: extension.activate, extensionId: project.manifest.id });
    host = "passed";
  }
  return { host, project, surfaces };
};
