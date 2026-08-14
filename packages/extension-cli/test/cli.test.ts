import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { initProject } from "../src/init.js";
import { buildProject } from "../src/build.js";
import { checkProject } from "../src/project.js";
import { testProject } from "../src/test-command.js";

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
      ],
    },
  }));
  await mkdirSource(root);
  const built = await buildProject(root);
  assert.deepEqual(built.outputs.map((output) => output.file), ["dist/host.cjs", "dist/main.cjs", "dist/isolated.js"]);
  const tested = await testProject(root);
  assert.deepEqual(tested.surfaces.map((surface) => surface.result), ["passed", "passed"]);
  assert.equal(tested.host, "passed");
});

const mkdirSource = async (root: string): Promise<void> => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "host.js"), `export default { activate(context) { context.effect(() => undefined); } };\n`);
  await writeFile(join(root, "src", "main.js"), `export default { activate(context) { context.onDispose(() => undefined); } };\n`);
  await writeFile(join(root, "src", "isolated.js"), `export default { activate(context) { context.effect(() => undefined); } };\n`);
};
