import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  createRequest,
  type ResponseEnvelope,
  type WireEnvelope,
} from "@piarium/protocol";
import { HostController } from "../src/host-controller.js";
import { MemoryHostTransport } from "../src/transport.js";

function isResponse(envelope: WireEnvelope, id: string): envelope is ResponseEnvelope {
  return envelope.kind === "response" && envelope.id === id;
}

test("session.resolve reads the selected Pi SDK header without opening or rewriting a session", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-session-resolve-"));
  const cwd = join(root, "workspace");
  const validFile = join(root, "valid.jsonl");
  const invalidFile = join(root, "invalid.jsonl");
  const emptyCwdFile = join(root, "empty-cwd.jsonl");
  const missingFile = join(root, "missing.jsonl");
  const validContent = `${JSON.stringify({
    cwd,
    id: "session-valid",
    timestamp: "2026-08-19T00:00:00.000Z",
    type: "session",
    version: 3,
  })}\n${JSON.stringify({
    id: "entry-1",
    message: { content: "hello", role: "user", timestamp: 1 },
    parentId: null,
    timestamp: "2026-08-19T00:00:01.000Z",
    type: "message",
  })}\n`;
  const invalidContent = "not json\n";
  const emptyCwdContent = `${JSON.stringify({
    cwd: "   ",
    id: "session-empty-cwd",
    timestamp: "2026-08-19T00:00:00.000Z",
    type: "session",
    version: 3,
  })}\n`;
  await writeFile(validFile, validContent, "utf8");
  await writeFile(invalidFile, invalidContent, "utf8");
  await writeFile(emptyCwdFile, emptyCwdContent, "utf8");

  const transport = new MemoryHostTransport();
  const controller = new HostController({ agentDir: join(root, "agent"), transport });
  controller.start();
  try {
    transport.receive(createRequest("valid", "session.resolve", { sessionFile: validFile }));
    const valid = await transport.waitFor((entry) => isResponse(entry, "valid"));
    assert.ok(valid.kind === "response" && valid.ok);
    assert.deepEqual(valid.result, {
      cwd: resolve(cwd),
      sessionFile: resolve(validFile),
      sessionId: "session-valid",
    });

    transport.receive(createRequest("entries", "session.entries.read", {
      cwd,
      scope: "branch",
      sessionFile: validFile,
      sessionId: "session-valid",
    }));
    const entries = await transport.waitFor((entry) => isResponse(entry, "entries"));
    assert.ok(entries.kind === "response" && entries.ok);
    assert.deepEqual(entries.result, {
      entries: [{
        id: "entry-1",
        message: { content: "hello", role: "user", timestamp: 1 },
        parentId: null,
        timestamp: "2026-08-19T00:00:01.000Z",
        type: "message",
      }],
      leafId: "entry-1",
      scope: "branch",
      sessionId: "session-valid",
    });

    transport.receive(createRequest("missing", "session.resolve", { sessionFile: missingFile }));
    const missing = await transport.waitFor((entry) => isResponse(entry, "missing"));
    assert.ok(missing.kind === "response" && !missing.ok);
    assert.equal(missing.error.code, "session_not_found");

    transport.receive(createRequest("invalid", "session.resolve", { sessionFile: invalidFile }));
    const invalid = await transport.waitFor((entry) => isResponse(entry, "invalid"));
    assert.ok(invalid.kind === "response" && !invalid.ok);
    assert.equal(invalid.error.code, "invalid_session_file");

    transport.receive(createRequest("empty-cwd", "session.resolve", {
      sessionFile: emptyCwdFile,
    }));
    const emptyCwd = await transport.waitFor((entry) => isResponse(entry, "empty-cwd"));
    assert.ok(emptyCwd.kind === "response" && !emptyCwd.ok);
    assert.equal(emptyCwd.error.code, "invalid_session_file");

    assert.equal(await readFile(validFile, "utf8"), validContent);
    assert.equal(await readFile(invalidFile, "utf8"), invalidContent);
    assert.equal(await readFile(emptyCwdFile, "utf8"), emptyCwdContent);
    assert.equal(
      transport.sent.some((entry) => entry.kind === "event" && entry.event === "session.snapshot"),
      false,
    );
  } finally {
    await controller.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("session.resolve loads the session reader from the selected external Pi package root", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-session-resolve-sdk-"));
  const packageRoot = join(root, "selected-sdk");
  const coreDir = join(packageRoot, "dist", "core");
  const sessionFile = join(root, "selected.jsonl");
  const selectedCwd = join(root, "selected-workspace");
  await mkdir(coreDir, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    main: "./dist/index.js",
    name: "@earendil-works/pi-coding-agent",
    type: "module",
  }), "utf8");
  await writeFile(join(packageRoot, "dist", "index.js"), "export {};\n", "utf8");
  await writeFile(
    join(coreDir, "session-manager.js"),
    `export function loadEntriesFromFile() {
      return [{ type: "session", id: "selected-sdk-session", cwd: ${JSON.stringify(selectedCwd)} }];
    }\n`,
    "utf8",
  );
  await writeFile(sessionFile, "selected sdk owns this parse\n", "utf8");

  const transport = new MemoryHostTransport();
  const controller = new HostController({
    agentDir: join(root, "agent"),
    packageRoot,
    transport,
  });
  controller.start();
  try {
    transport.receive(createRequest("selected", "session.resolve", { sessionFile }));
    const response = await transport.waitFor((entry) => isResponse(entry, "selected"));
    assert.ok(response.kind === "response" && response.ok);
    assert.deepEqual(response.result, {
      cwd: resolve(selectedCwd),
      sessionFile: resolve(sessionFile),
      sessionId: "selected-sdk-session",
    });
    assert.equal(await readFile(sessionFile, "utf8"), "selected sdk owns this parse\n");
  } finally {
    await controller.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
