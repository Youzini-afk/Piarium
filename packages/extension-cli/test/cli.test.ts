import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePiariumExtensionManifest, type PiariumExtensionStaticContribution } from "@piarium/extension-contract";
import { initProject } from "../src/init.js";
import { buildProject } from "../src/build.js";
import { checkProject } from "../src/project.js";
import { runShellCompositionSmoke, testProject } from "../src/test-command.js";
import { runCli } from "../src/cli.js";
import { defineShellMount, defineSurfaceExtension } from "@piarium/extension-sdk";

const temporaryDirectory = async (): Promise<string> => mkdtemp(join(tmpdir(), "piarium-extension-cli-test-"));

const exchangeProtocolFrame = async (script: string, message: unknown): Promise<Record<string, unknown>> => {
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
      child.kill();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`Protocol fixture did not respond: ${script}`))), 5_000);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      if (!settled) finish(() => reject(new Error(`Protocol fixture exited before responding (${code ?? "unknown"}): ${script}`)));
    });
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("utf8"));
      if (!match) return;
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      finish(() => resolve(JSON.parse(buffer.subarray(start, start + length).toString("utf8")) as Record<string, unknown>));
    });
    child.stdin.write(Buffer.concat([
      Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8"),
      payload,
    ]));
  });
  return response;
};

test("init writes a standalone managed Surface template and refuses overwrite", async () => {
  const root = await temporaryDirectory();
  const project = join(root, "sample");
  await initProject({ directory: project, id: "dev.example.sample", name: "Sample Extension" });
  const files = await readdir(project);
  assert.deepEqual(files.sort(), ["README.md", "package.json", "piarium.extension.json", "src", "tsconfig.json"]);
  await assert.rejects(
    initProject({ directory: project, id: "dev.example.other", name: "Other" }),
    /non-empty target directory/,
  );
});

test("init templates cover shell, editor, view, language, debug, and test workbench seams", async () => {
  const root = await temporaryDirectory();
  const shell = await initProject({
    directory: join(root, "shell"),
    id: "dev.example.shell",
    name: "Vanilla Shell",
    template: "shell",
  });
  assert.equal(shell.template, "shell");
  const surface = await readFile(join(shell.directory, "src/surface.ts"), "utf8");
  assert.match(surface, /defineShellMount/);
  assert.match(surface, /PIARIUM_WORKBENCH_REPLACEMENT_TARGETS/);
  assert.match(surface, /mount\.workbench\.mountReplacement/);
  assert.match(surface, /mount\.workbench\.mountSlot/);
  assert.doesNotMatch(surface, /@piarium\/ui|@\/components/);
  const shellManifest = JSON.parse(await readFile(join(shell.directory, "piarium.extension.json"), "utf8"));
  assert.doesNotThrow(() => parsePiariumExtensionManifest(shellManifest));
  assert.equal(shellManifest.contributions?.[0]?.kind, "shell");

  const editor = await initProject({
    directory: join(root, "editor"),
    id: "dev.example.editor",
    name: "Custom Editor",
    template: "editor",
  });
  const editorSource = await readFile(join(editor.directory, "src/surface.ts"), "utf8");
  assert.match(editorSource, /mount\.props\.document\.applyEdits/);
  assert.match(editorSource, /case "invalid-range"/);
  assert.match(editorSource, /case "overlapping-ranges"/);
  assert.match(editorSource, /case "unsupported"/);
  assert.match(editorSource, /case "stale"/);
  assert.doesNotMatch(editorSource, /replaceContent/);
  assert.match(editorSource, /mount\.props\.document\.save/);
  assert.match(editorSource, /languageIds:\s*\["markdown"\]/);
  assert.doesNotMatch(editorSource, /workbench\.editor\.actions|@piarium\/ui/);
  await initProject({
    directory: join(root, "view"),
    id: "dev.example.view",
    name: "Sidebar View",
    template: "view",
  });
  const language = await initProject({
    directory: join(root, "language"),
    id: "dev.example.language",
    name: "Markdown Language",
    template: "language",
  });
  const host = await readFile(join(language.directory, "src/host.ts"), "utf8");
  assert.match(host, /defineLanguageProvider/);
  assert.match(host, /context\.assets\.path\("runtime\/language-server\.mjs"\)/);
  const languageRuntime = join(language.directory, "runtime/language-server.mjs");
  await readFile(languageRuntime, "utf8");
  const languageInitialize = await exchangeProtocolFrame(languageRuntime, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  assert.equal(languageInitialize.jsonrpc, "2.0");
  assert.equal(languageInitialize.id, 1);
  const languagePackage = JSON.parse(await readFile(join(language.directory, "package.json"), "utf8")) as { files?: string[] };
  assert.ok(languagePackage.files?.includes("runtime"));
  const checked = await checkProject(language.directory);
  assert.deepEqual(checked.missingFiles, ["dist/host.cjs"]);

  const debug = await initProject({
    directory: join(root, "debug"),
    id: "dev.example.debug",
    name: "Node Debug",
    template: "debug",
  });
  const debugHost = await readFile(join(debug.directory, "src/host.ts"), "utf8");
  assert.match(debugHost, /defineDebugAdapter/);
  assert.match(debugHost, /context\.assets\.path\("runtime\/debug-adapter\.mjs"\)/);
  const debugRuntime = join(debug.directory, "runtime/debug-adapter.mjs");
  await readFile(debugRuntime, "utf8");
  const debugInitialize = await exchangeProtocolFrame(debugRuntime, {
    seq: 1,
    type: "request",
    command: "initialize",
    arguments: { clientID: "test" },
  });
  assert.equal(debugInitialize.type, "response");
  assert.equal(debugInitialize.request_seq, 1);
  assert.equal(debugInitialize.success, true);
  const debugManifest = await readFile(join(debug.directory, "piarium.extension.json"), "utf8");
  assert.match(debugManifest, /workspace\.debug/);

  const tests = await initProject({
    directory: join(root, "test"),
    id: "dev.example.test",
    name: "Node Tests",
    template: "test",
  });
  const testHost = await readFile(join(tests.directory, "src/host.ts"), "utf8");
  assert.match(testHost, /defineTestProvider/);
  assert.match(testHost, /kind:\s*"node-test"/);
  assert.doesNotMatch(testHost, /test-adapter\.mjs/);
  const testManifest = await readFile(join(tests.directory, "piarium.extension.json"), "utf8");
  assert.match(testManifest, /workspace\.test/);
});

test("shell composition smoke invokes replacement, slot, and disposer behavior", async () => {
  const descriptor: PiariumExtensionStaticContribution = {
    contractVersion: 1,
    data: {
      contract: "piarium-workbench-shell/v1",
      seams: { web: { replacementTargets: ["workbench.editor"], slots: ["workbench.primary-sidebar.views"] } },
    },
    entrypoint: "dev.example.shell-smoke.surface",
    id: "dev.example.shell-smoke.shell",
    kind: "shell",
    replacement: { target: "workbench.shell" },
    supports: ["web"],
  };
  const manifest = parsePiariumExtensionManifest({
    schemaVersion: 1,
    id: "dev.example.shell-smoke",
    version: "1.0.0",
    engines: { piarium: "*" },
    entrypoints: {
      surfaces: [{
        file: "dist/surface.cjs",
        id: "dev.example.shell-smoke.surface",
        mode: "managed",
        supports: ["web"],
      }],
    },
    contributions: [descriptor],
  });
  const { entrypoint: descriptorEntrypoint, ...dynamicDescriptor } = descriptor;
  void descriptorEntrypoint;
  await runShellCompositionSmoke(manifest, {
    default: defineSurfaceExtension((context) => {
      context.contribute(dynamicDescriptor, defineShellMount(async (container, mount) => {
        const replacement = await mount.workbench.mountReplacement({
          container,
          target: "workbench.editor",
        });
        const slot = await mount.workbench.mountSlot({
          container,
          slot: "workbench.primary-sidebar.views",
        });
        return async () => {
          await slot.dispose();
          await replacement.dispose();
          container.replaceChildren();
        };
      }));
    }),
  });
});


test("check reports a valid contract and missing published output", async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "dev.example.check", version: "1.0.0" }));
  await writeFile(join(root, "piarium.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dev.example.check",
    version: "1.0.0",
    engines: { piarium: "*" },
    entrypoints: {
      surfaces: [{ id: "main", file: "dist/main.cjs", mode: "managed", supports: ["web"] }],
    },
  }));
  const result = await checkProject(root);
  assert.deepEqual(result.missingFiles, ["dist/main.cjs"]);
});

test("build uses the manifest output path and test exercises lifecycle cleanup", async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "dev.example.lifecycle",
    type: "module",
    version: "1.0.0",
    piarium: { build: { entrypoints: {
      host: { source: "src/host.js" },
      isolated: { source: "src/isolated.js" },
      main: { source: "src/main.js" },
    } } },
  }));
  await writeFile(join(root, "piarium.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dev.example.lifecycle",
    version: "1.0.0",
    engines: { piarium: "*" },
    entrypoints: {
      host: { file: "dist/host.cjs", mode: "brokered" },
      surfaces: [
        { id: "main", file: "dist/main.cjs", mode: "managed", supports: ["web"] },
        { id: "isolated", file: "dist/isolated.js", mode: "isolated", isolation: "worker", supports: ["web"] },
        { id: "declarative", mode: "declarative", supports: ["web"] },
      ],
    },
    contributions: [{
      contractVersion: 1,
      data: { contract: "dev.example.static/v1" },
      entrypoint: "declarative",
      id: "dev.example.lifecycle.static",
      kind: "panel",
      supports: ["web"],
    }],
  }));
  await mkdirSource(root);
  const built = await buildProject(root);
  assert.deepEqual(built.outputs.map((output) => output.file), ["dist/host.cjs", "dist/main.cjs", "dist/isolated.js"]);
  const tested = await testProject(root);
  assert.deepEqual(tested.surfaces.map((surface) => surface.result), ["passed", "passed", "passed"]);
  assert.equal(tested.host, "passed");
});

test("CLI output modes preserve validation and emit script-safe results", async () => {
  const root = await temporaryDirectory();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "dev.example.output", version: "1.0.0" }));
  await writeFile(join(root, "piarium.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dev.example.output",
    version: "1.0.0",
    engines: { piarium: "*" },
  }));

  const jsonLines: string[] = [];
  const jsonErrors: string[] = [];
  const jsonExit = await runCli(["check", root, "--json"], {
    error: (...values) => jsonErrors.push(values.join(" ")),
    log: (...values) => jsonLines.push(values.join(" ")),
  });
  assert.equal(jsonExit, 0);
  assert.equal(jsonErrors.length, 0);
  assert.equal(jsonLines.length, 1);
  assert.deepEqual(JSON.parse(jsonLines[0] as string), {
    command: "check",
    extensionId: "dev.example.output",
    incompatibleContributions: [],
    missingFiles: [],
    ok: true,
    referencedFiles: [],
    version: "1.0.0",
  });

  const quietLines: string[] = [];
  assert.equal(await runCli(["check", root, "--quiet"], {
    error: () => undefined,
    log: (...values) => quietLines.push(values.join(" ")),
  }), 0);
  assert.deepEqual(quietLines, ["ok dev.example.output@1.0.0 files:0"]);

  const failureLines: string[] = [];
  const failureErrors: string[] = [];
  assert.equal(await runCli(["check", join(root, "missing"), "--json"], {
    error: (...values) => failureErrors.push(values.join(" ")),
    log: (...values) => failureLines.push(values.join(" ")),
  }), 1);
  assert.equal(failureErrors.length, 0);
  assert.equal(failureLines.length, 1);
  const failure = JSON.parse(failureLines[0] as string) as { command: string; errors: string[]; ok: boolean };
  assert.equal(failure.command, "check");
  assert.equal(failure.ok, false);
  assert.match(failure.errors[0] as string, /does not exist/);

  await writeFile(join(root, "piarium.extension.json"), JSON.stringify({
    schemaVersion: 2,
    id: "dev.example.output",
    version: "1.0.0",
    engines: { piarium: "not-a-semver-range" },
  }));
  const quietFailureLines: string[] = [];
  const quietFailureErrors: string[] = [];
  assert.equal(await runCli(["check", root, "--quiet"], {
    error: (...values) => quietFailureErrors.push(values.join(" ")),
    log: (...values) => quietFailureLines.push(values.join(" ")),
  }), 1);
  assert.equal(quietFailureLines.length, 0);
  assert.equal(quietFailureErrors.length, 1);
  assert.doesNotMatch(quietFailureErrors[0] as string, /[\r\n]/);
  assert.equal(
    quietFailureErrors[0],
    "error 2 issues: schemaVersion must be 1; engines.piarium must be a valid SemVer range",
  );
});

test("check reports incompatible contributions for unknown contract version", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-cli-incompat-"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "dev.example.incompat",
    version: "1.0.0",
  }));
  await writeFile(join(root, "piarium.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dev.example.incompat",
    version: "1.0.0",
    engines: { piarium: ">=0.2.0" },
    contributions: [{
      id: "dev.example.incompat.view",
      kind: "view",
      contractVersion: 99,
      data: {},
      supports: ["web"],
    }],
  }));

  const jsonLines: string[] = [];
  const jsonErrors: string[] = [];
  const exit = await runCli(["check", root, "--json"], {
    error: (...values) => jsonErrors.push(values.join(" ")),
    log: (...values) => jsonLines.push(values.join(" ")),
  });
  assert.equal(exit, 1);
  assert.equal(jsonErrors.length, 0);
  const result = JSON.parse(jsonLines[0] as string) as {
    incompatibleContributions: Array<{ id: string; kind: string; contractVersion: number }>;
    ok: boolean;
  };
  assert.equal(result.ok, false);
  assert.equal(result.incompatibleContributions.length, 1);
  assert.equal(result.incompatibleContributions[0]!.kind, "view");
  assert.equal(result.incompatibleContributions[0]!.contractVersion, 99);
  assert.equal(result.incompatibleContributions[0]!.id, "dev.example.incompat.view");
});

test("check reports when validation errors for shell and transition-scene", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-cli-when-"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "dev.example.when",
    version: "1.0.0",
  }));
  await writeFile(join(root, "piarium.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: "dev.example.when",
    version: "1.0.0",
    engines: { piarium: ">=0.2.0" },
    contributions: [
      {
        id: "dev.example.when.shell",
        kind: "shell",
        contractVersion: 1,
        data: {
          contract: "piarium-workbench-shell/v1",
          seams: { web: { replacementTargets: ["workbench.editor"], slots: [] } },
        },
        supports: ["web"],
        replacement: { target: "workbench.shell" },
        when: { op: "defined", key: "editorIsOpen" },
      },
      {
        id: "dev.example.when.view",
        kind: "view",
        contractVersion: 1,
        data: {},
        supports: ["web"],
        when: { op: "defined", key: "editorIsOpen" },
      },
    ],
  }));

  const jsonLines: string[] = [];
  const jsonErrors: string[] = [];
  const exit = await runCli(["check", root, "--json"], {
    error: (...values) => jsonErrors.push(values.join(" ")),
    log: (...values) => jsonLines.push(values.join(" ")),
  });
  assert.equal(exit, 1);
  const result = JSON.parse(jsonLines[0] as string) as {
    errors: string[];
    ok: boolean;
  };
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("when") && e.includes("shell")));
});

const mkdirSource = async (root: string): Promise<void> => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "host.js"), `export default { activate(context) { context.effect(() => undefined); } };\n`);
  await writeFile(join(root, "src", "main.js"), `export default { activate(context) { context.onDispose(() => undefined); } };\n`);
  await writeFile(join(root, "src", "isolated.js"), `export default { activate(context) { context.effect(() => undefined); } };\n`);
};
