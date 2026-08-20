import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init.js";
import { buildProject } from "../src/build.js";
import { checkProject } from "../src/project.js";
import { testProject } from "../src/test-command.js";
import { runCli } from "../src/cli.js";

const temporaryDirectory = async (): Promise<string> => mkdtemp(join(tmpdir(), "piarium-extension-cli-test-"));

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

test("init templates cover shell, editor, view, and language workbench seams", async () => {
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
  assert.doesNotMatch(surface, /@piarium\/ui|@\/components/);

  await initProject({
    directory: join(root, "editor"),
    id: "dev.example.editor",
    name: "Custom Editor",
    template: "editor",
  });
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
  const checked = await checkProject(language.directory);
  assert.deepEqual(checked.missingFiles, ["dist/host.cjs"]);
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

const mkdirSource = async (root: string): Promise<void> => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "host.js"), `export default { activate(context) { context.effect(() => undefined); } };\n`);
  await writeFile(join(root, "src", "main.js"), `export default { activate(context) { context.onDispose(() => undefined); } };\n`);
  await writeFile(join(root, "src", "isolated.js"), `export default { activate(context) { context.effect(() => undefined); } };\n`);
};
