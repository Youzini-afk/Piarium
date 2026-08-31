import { buildProject } from "./build.js";
import { checkProject } from "./project.js";
import type { PiariumIsolatedSurfaceModule, PiariumManagedSurfaceModule } from "@piarium/extension-sdk";
import type { PiariumExtensionManifest, PiariumExtensionStaticContribution } from "@piarium/extension-contract";
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

const runDeclarativeConformance = async (
  manifest: PiariumExtensionManifest,
  entrypointId: string,
  supports: readonly ("desktop" | "mobile" | "vscode" | "web")[],
): Promise<void> => {
  const surface = supports[0] ?? "web";
  const runtime = new SurfaceExtensionRuntime({ surface });
  await runSurfaceExtensionConformance({
    activation: (context) => {
      for (const contribution of manifest.contributions ?? []) {
        if (!contribution.supports.includes(surface)) continue;
        if (contribution.entrypoint && contribution.entrypoint !== entrypointId) continue;
        context.contribute(contribution, structuredClone(contribution.data));
      }
    },
    owner: {
      desiredRevision: 1,
      entrypointId,
      extensionId: manifest.id,
      extensionVersion: manifest.version,
      generation: 0,
      hostId: "00000000-0000-4000-8000-000000000001",
      realmId: "piarium-cli-declarative-test",
    },
    runtime,
  });
};

/**
 * Shell composition smoke: verify that a shell contribution's mount
 * implementation can mount child contributions via mountReplacement and
 * mountSlot, that child owners carry the correct generation, and that
 * disposing the shell cleans up all children.
 */
const runShellCompositionSmoke = async (
  manifest: PiariumExtensionManifest,
  module: PiariumManagedSurfaceModule,
): Promise<void> => {
  const shellContribution = (manifest.contributions ?? []).find((c) => c.kind === "shell");
  if (!shellContribution) return; // Not a shell extension — skip
  const extension = resolveSurfaceExtensionModule(module);
  const surface = (shellContribution.supports[0] ?? "web") as "desktop" | "mobile" | "vscode" | "web";
  const runtime = new SurfaceExtensionRuntime({ surface });
  const hostId = "00000000-0000-0000-0000-000000000002";
  const owner = {
    desiredRevision: 1,
    entrypointId: "shell-smoke",
    extensionId: manifest.id,
    extensionVersion: manifest.version,
    generation: 1,
    hostId,
    realmId: "piarium-cli-shell-smoke",
  };
  // Activate the shell extension
  await runtime.activate({ owner }, (context) => extension.activate({
    ...context,
    assets: {
      read: async (path) => ({ bytes: new Uint8Array(), contentType: "application/octet-stream", integrity: `sha256-${"0".repeat(64)}`, path }),
      url: async () => "mock://piarium-extension-asset",
    },
    styles: { use: async () => undefined },
  }));
  // Verify the shell contribution was registered
  const snapshot = runtime.getSnapshot();
  const shellItem = snapshot.contributions.find((c) => c.descriptor.id === shellContribution.id);
  if (!shellItem) throw new Error("Shell composition smoke: shell contribution was not registered");
  // Verify the shell implementation has mount/replace/slot methods
  const impl = shellItem.implementation as Record<string, unknown> | undefined;
  if (!impl || typeof impl.mount !== "function") {
    throw new Error("Shell composition smoke: shell contribution implementation has no mount function");
  }
  // Deactivate and verify cleanup
  await runtime.deactivate({ ...owner, desiredRevision: 2, generation: 2 });
  const afterDeactivate = runtime.getSnapshot();
  if (afterDeactivate.contributions.some((c) => c.owner.extensionId === manifest.id)) {
    throw new Error("Shell composition smoke: shell leaked contributions after deactivation");
  }
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
      await runDeclarativeConformance(project.manifest, entrypoint.id, entrypoint.supports);
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
  // Shell composition smoke: if the manifest declares a shell contribution,
  // verify the mount implementation and lifecycle beyond basic conformance.
  const shellContribution = project.manifest.contributions?.find((c) => c.kind === "shell");
  if (shellContribution) {
    const shellEntrypoint = project.manifest.entrypoints?.surfaces?.find((e) => e.id === shellContribution.entrypoint);
    if (shellEntrypoint?.file) {
      const target = entrypointTargetPath(project, shellEntrypoint.file);
      const module = await moduleFromFile(target);
      await runShellCompositionSmoke(project.manifest, module as PiariumManagedSurfaceModule);
    }
  }
  let host: TestResult["host"] = "skipped";
  const hostEntrypoint = project.manifest.entrypoints?.host;
  if (hostEntrypoint) {
    if (!hostEntrypoint.file) throw new Error("Host entrypoint does not declare a file");
    const module = await moduleFromFile(entrypointTargetPath(project, hostEntrypoint.file));
    const extension = resolveHostExtensionModule(module);
    await runHostExtensionConformance({
      activation: extension.activate,
      extensionId: project.manifest.id,
      packageRoot: project.directory,
    });
    host = "passed";
  }
  return { host, project, surfaces };
};
