import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PIARIUM_PROTOCOL_VERSION } from "@piarium/protocol";

const HOST_ENTRY = fileURLToPath(new URL("../dist/host-bootstrap.js", import.meta.url));

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function packageDirFromResolvedEntry(entryUrl) {
  let current = dirname(fileURLToPath(entryUrl));
  while (true) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Package directory was not found for ${entryUrl}`);
    }
    current = parent;
  }
}

function workspacePiPackageRoot() {
  return packageDirFromResolvedEntry(import.meta.resolve("@earendil-works/pi-coding-agent"));
}

async function materializeIncompletePiFixture(root) {
  const packageRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      type: "module",
      version: "0.84.1",
      exports: { ".": "./index.js" },
    }),
  );
  await writeFile(
    join(packageRoot, "index.js"),
    `export const VERSION = "0.84.1";
export function getAgentDir() { return process.env.PI_CODING_AGENT_DIR ?? ""; }
await import("@earendil-works/pi-ai");
`,
  );
  return packageRoot;
}

async function runHostSession(args, work) {
  const child = spawn(process.execPath, [HOST_ENTRY, "--stdio", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  const envelopes = [];
  const waiters = new Set();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  lines.on("line", (line) => {
    envelopes.push(JSON.parse(line));
    for (const wake of waiters) wake();
  });

  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const waitFor = async (predicate, message) => {
    const existing = envelopes.find(predicate);
    if (existing) return existing;
    return withTimeout(
      new Promise((resolve, reject) => {
        const wake = () => {
          const envelope = envelopes.find(predicate);
          if (!envelope) return;
          waiters.delete(wake);
          resolve(envelope);
        };
        waiters.add(wake);
        void exited.then((result) => {
          if (!envelopes.find(predicate)) {
            reject(new Error(`${message}\nHost exited (${JSON.stringify(result)})\n${stderr}`));
          }
        });
      }),
      15_000,
      `${message}\nHost stderr:\n${stderr}`,
    );
  };

  try {
    return await work({ child, exited, stderr: () => stderr, waitFor });
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

test("compiled host handshakes and shuts down over stdio", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "piarium-dist-host-"));
  try {
    await runHostSession(["--agent-dir", agentDir], async ({ child, exited, stderr, waitFor }) => {
      await waitFor(
        (envelope) => envelope.kind === "event" && envelope.event === "host.ready",
        "Compiled host did not become ready",
      );
      child.stdin.write(
        `${JSON.stringify({
          id: "handshake",
          kind: "request",
          method: "host.handshake",
          params: {
            clientName: "dist-smoke-test",
            clientVersion: "0.0.0",
            mode: "test",
            protocolVersions: [PIARIUM_PROTOCOL_VERSION],
          },
          v: PIARIUM_PROTOCOL_VERSION,
        })}\n`,
      );
      const handshake = await waitFor(
        (envelope) => envelope.kind === "response" && envelope.id === "handshake",
        "Compiled host did not answer the handshake",
      );
      assert.equal(handshake.ok, true);
      assert.equal(handshake.result.protocolVersion, PIARIUM_PROTOCOL_VERSION);

      child.stdin.write(
        `${JSON.stringify({
          id: "shutdown",
          kind: "request",
          method: "host.shutdown",
          params: {},
          v: PIARIUM_PROTOCOL_VERSION,
        })}\n`,
      );
      const shutdown = await waitFor(
        (envelope) => envelope.kind === "response" && envelope.id === "shutdown",
        "Compiled host did not acknowledge shutdown",
      );
      assert.equal(shutdown.ok, true);
      child.stdin.end();
      const result = await withTimeout(exited, 10_000, `Compiled host did not exit\n${stderr()}`);
      assert.deepEqual(result, { code: 0, signal: null });
    });
  } finally {
    await rm(agentDir, { force: true, recursive: true });
  }
});

test("external Pi package root starts the host and creates a session", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-external-host-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  try {
    await mkdir(cwd, { recursive: true });
    const packageRoot = workspacePiPackageRoot();
    assert.notEqual(packageRoot, fileURLToPath(new URL("..", import.meta.url)));
    await runHostSession(
      [
        "--agent-dir",
        agentDir,
        "--package-root",
        packageRoot,
        "--runtime-source",
        "custom",
        "--trust-project",
      ],
      async ({ child, waitFor }) => {
        await waitFor(
          (envelope) => envelope.kind === "event" && envelope.event === "host.ready",
          "External host did not become ready",
        );
        child.stdin.write(
          `${JSON.stringify({
            id: "handshake",
            kind: "request",
            method: "host.handshake",
            params: {
              clientName: "external-runtime-test",
              clientVersion: "0.0.0",
              mode: "test",
              protocolVersions: [PIARIUM_PROTOCOL_VERSION],
            },
            v: PIARIUM_PROTOCOL_VERSION,
          })}\n`,
        );
        const handshake = await waitFor(
          (envelope) => envelope.kind === "response" && envelope.id === "handshake",
          "External host did not answer the handshake",
        );
        assert.equal(handshake.ok, true);
        assert.equal(handshake.result.runtime.source, "custom");
        assert.equal(handshake.result.runtime.packageRoot, packageRoot);
        assert.equal(handshake.result.runtime.piVersion, "0.84.1");
        assert.notEqual(handshake.result.runtime.source, "bundled");

        child.stdin.write(
          `${JSON.stringify({
            id: "create",
            kind: "request",
            method: "session.create",
            params: { cwd },
            v: PIARIUM_PROTOCOL_VERSION,
          })}\n`,
        );
        const created = await waitFor(
          (envelope) => envelope.kind === "response" && envelope.id === "create",
          "External host did not create a session",
        );
        assert.equal(created.ok, true);
        assert.equal(created.result.cwd, cwd);

        child.stdin.write(
          `${JSON.stringify({
            id: "shutdown",
            kind: "request",
            method: "host.shutdown",
            params: {},
            v: PIARIUM_PROTOCOL_VERSION,
          })}\n`,
        );
        await waitFor(
          (envelope) => envelope.kind === "response" && envelope.id === "shutdown",
          "External host did not acknowledge shutdown",
        );
      },
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("external load failure names the missing Pi SDK module", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-external-missing-"));
  try {
    const packageRoot = await materializeIncompletePiFixture(root);
    const child = spawn(
      process.execPath,
      [
        HOST_ENTRY,
        "--stdio",
        "--package-root",
        packageRoot,
        "--runtime-source",
        "custom",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = await withTimeout(
      new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
      15_000,
      `Host did not exit after a missing SDK module\n${stderr}`,
    );
    assert.notEqual(exited.code, 0);
    assert.match(stderr, /@earendil-works\/pi-ai/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
