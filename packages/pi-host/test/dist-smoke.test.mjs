import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOST_ENTRY = fileURLToPath(new URL("../dist/main.js", import.meta.url));

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

test("compiled host handshakes and shuts down over stdio", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "piarium-dist-host-"));
  const child = spawn(process.execPath, [HOST_ENTRY, "--stdio", "--agent-dir", agentDir], {
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

  const waitFor = async (predicate, message) => {
    const existing = envelopes.find(predicate);
    if (existing) return existing;
    return withTimeout(
      new Promise((resolve) => {
        const wake = () => {
          const envelope = envelopes.find(predicate);
          if (!envelope) return;
          waiters.delete(wake);
          resolve(envelope);
        };
        waiters.add(wake);
      }),
      10_000,
      `${message}\nHost stderr:\n${stderr}`,
    );
  };

  try {
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
          protocolVersions: [1],
        },
        v: 1,
      })}\n`,
    );
    const handshake = await waitFor(
      (envelope) => envelope.kind === "response" && envelope.id === "handshake",
      "Compiled host did not answer the handshake",
    );
    assert.equal(handshake.ok, true);
    assert.equal(handshake.result.protocolVersion, 1);

    const exited = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    child.stdin.write(
      `${JSON.stringify({
        id: "shutdown",
        kind: "request",
        method: "host.shutdown",
        params: {},
        v: 1,
      })}\n`,
    );
    const shutdown = await waitFor(
      (envelope) => envelope.kind === "response" && envelope.id === "shutdown",
      "Compiled host did not acknowledge shutdown",
    );
    assert.equal(shutdown.ok, true);
    child.stdin.end();
    const result = await withTimeout(exited, 10_000, `Compiled host did not exit\n${stderr}`);
    assert.deepEqual(result, { code: 0, signal: null });
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await rm(agentDir, { force: true, recursive: true });
  }
});
