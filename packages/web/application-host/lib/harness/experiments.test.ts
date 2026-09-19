import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it as vitestIt } from "vitest";
import { createKernelClient, type KernelClient } from "../kernel/kernel-client.js";
import { createExperimentService, type ExperimentCaller } from "./experiments.js";
import { createResourceService } from "./resources.js";
import { createSourceService } from "./sources.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const kernelPath = process.env.PIARIUM_TEST_KERNEL_PATH
  ?? path.join(repositoryRoot, "kernel/target/release", process.platform === "win32" ? "piarium-kernel.exe" : "piarium-kernel");
const buildVersion = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")).version as string;
const available = await fs.stat(kernelPath).then(() => true).catch(() => false);
if (!available && process.env.PIARIUM_REQUIRE_RELEASE_KERNEL === "1") {
  throw new Error("Experiment acceptance requires the release kernel");
}
const it = vitestIt.skipIf(!available);

const clients: KernelClient[] = [];
const roots: string[] = [];
const pause = (ms = 25) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "piarium-experiment-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const storageRoot = path.join(root, "storage");
  const client = createKernelClient({
    hostId: "experiment-test", storageRoot, kernelPath, buildVersion, allowCargoDevRunner: false,
  });
  clients.push(client);
  await client.start();
  const errors: Error[] = [];
  const onError = (error: Error) => errors.push(error);
  const resources = createResourceService({ client, onError });
  const sources = createSourceService({ client });
  const experiments = createExperimentService({
    client,
    resources,
    sources,
    resolveWorkspaceRoot: async () => workspace,
    onError,
  });
  const caller: ExperimentCaller = {
    workspaceId: "ws",
    executionWorkspaceId: "ws",
    sessionId: "s-1",
    threadId: "t-1",
    runId: "r-1",
  };
  return { root, workspace, client, resources, sources, experiments, caller, errors };
}

const node = (...script: string[]) => ({
  command: process.execPath,
  args: ["-e", script.join(";")],
  env: { ELECTRON_RUN_AS_NODE: "1" },
});

describe("experiment service on the real kernel", () => {
  it("runs a local attempt to completion, collects streams and output files, and dedupes the request", async () => {
    const f = await fixture();
    const spec = node(
      "require('node:fs').writeFileSync('result.txt','answer=42')",
      "process.stdout.write('stdout-marker')",
      "process.stderr.write('stderr-marker')",
    );
    const submitted = await f.experiments.submit(f.caller, {
      requestId: "req-complete-1",
      title: "quick check",
      ...spec,
      outputPaths: ["result.txt"],
    });
    assert.equal(submitted.spec.state, "active");
    assert.match(submitted.attempt.attemptId, /^attempt-req-complete-1/);

    // A retry with the same requestId returns the recorded attempt — no second job.
    const retry = await f.experiments.submit(f.caller, { requestId: "req-complete-1", ...spec, outputPaths: ["result.txt"] });
    assert.equal(retry.attempt.attemptId, submitted.attempt.attemptId);

    const waited = await f.experiments.wait(f.caller, submitted.attempt.attemptId, 30_000);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.attempt.state, "completed");
    assert.equal(waited.attempt.exitCode, 0);
    assert.equal(waited.attempt.collection, "done");

    const detail = await f.experiments.get(f.caller, submitted.attempt.attemptId);
    assert.equal(detail.job?.backend, "local");
    assert.ok(detail.job?.backendJobId);
    assert.equal(detail.job?.state, "released");
    assert.ok(detail.artifacts.some((a) => a.name === "stdout" && a.state === "available" && a.objectHash));
    assert.ok(detail.artifacts.some((a) => a.name === "result.txt" && a.state === "available" && a.objectHash));

    const out = await f.experiments.logs(f.caller, { attemptId: submitted.attempt.attemptId, stream: "stdout" });
    assert.equal(out.origin, "artifact");
    assert.equal(out.eof, true);
    assert.match(out.text, /stdout-marker/);
    const err = await f.experiments.logs(f.caller, { attemptId: submitted.attempt.attemptId, stream: "stderr" });
    assert.match(err.text, /stderr-marker/);

    // specId reuse launches a second attempt under the same pinned spec.
    const second = await f.experiments.submit(f.caller, { specId: submitted.spec.specId });
    assert.equal(second.attempt.specId, submitted.spec.specId);
    assert.notEqual(second.attempt.attemptId, submitted.attempt.attemptId);
    const secondWait = await f.experiments.wait(f.caller, second.attempt.attemptId, 30_000);
    assert.equal(secondWait.attempt.state, "completed");

    const listed = await f.experiments.list(f.caller, { specId: submitted.spec.specId });
    assert.equal(listed.attempts.length, 2);
    assert.deepEqual(f.errors, []);
  });

  it("cancels a running attempt and keeps the outcome distinct from collection", async () => {
    const f = await fixture();
    const submitted = await f.experiments.submit(f.caller, node("setInterval(()=>{},1000)"));
    const attemptId = submitted.attempt.attemptId;
    const deadline = Date.now() + 15_000;
    let view = submitted.attempt;
    while (view.state !== "running" && Date.now() < deadline) {
      await pause();
      view = (await f.experiments.get(f.caller, attemptId)).attempt;
    }
    assert.equal(view.state, "running");

    const cancelled = await f.experiments.cancel(f.caller, attemptId);
    assert.ok(cancelled.state === "stopping" || cancelled.state === "cancelled");
    const waited = await f.experiments.wait(f.caller, attemptId, 30_000);
    assert.equal(waited.attempt.state, "cancelled");

    // collect stays honest after cancellation — artifacts are still readable.
    const collected = await f.experiments.collect(f.caller, attemptId);
    assert.equal(collected.attempt.state, "cancelled");
    assert.ok(collected.attempt.collection === "done" || collected.attempt.collection === "none");
    assert.deepEqual(f.errors, []);
  });

  it("queues an attempt that exceeds confirmed capacity and releases the commitment when it drains", async () => {
    const f = await fixture();
    const impossible = await f.experiments.submit(f.caller, {
      ...node("process.stdout.write('never')"),
      resources: { cpuCores: 1_000_000 },
    });
    assert.equal(impossible.attempt.state, "queued");
    assert.ok(impossible.attempt.queueReason);

    // The queue is a visible resource fact, separate from confirmed commitments.
    const whileQueued = await f.resources.list(f.caller.workspaceId);
    const queuedMachine = whileQueued.machines.find((machine) => machine.machineId === "local");
    assert.ok(queuedMachine);
    assert.equal(queuedMachine.queued.length, 1);
    assert.equal(queuedMachine.queued[0]!.attemptId, impossible.attempt.attemptId);
    assert.match(queuedMachine.queued[0]!.reason ?? "", /cpuCores|insufficient/i);
    assert.match(whileQueued.text, /1 queued/);

    // Cancelling the queued attempt releases nothing it never held and ends it.
    const cancelled = await f.experiments.cancel(f.caller, impossible.attempt.attemptId);
    assert.equal(cancelled.state, "cancelled");

    const overview = await f.resources.list(f.caller.workspaceId);
    const local = overview.machines.find((machine) => machine.machineId === "local");
    assert.ok(local);
    assert.equal(local.state, "available");
    assert.ok((local.capacity?.cpuCores ?? 0) > 0);
    assert.equal(local.queued.length, 0);
    assert.ok(overview.text.length > 0);
    assert.deepEqual(f.errors, []);
  });

  it("reattaches a running attempt after the supervising service restarts", async () => {
    const f = await fixture();
    // ~1.5s job: the first service instance goes away while it runs.
    const submitted = await f.experiments.submit(f.caller, node(
      "setTimeout(()=>{process.stdout.write('late-exit')},1500)",
    ));
    const attemptId = submitted.attempt.attemptId;
    const deadline = Date.now() + 15_000;
    let view = submitted.attempt;
    while (view.state !== "running" && Date.now() < deadline) {
      await pause();
      view = (await f.experiments.get(f.caller, attemptId)).attempt;
    }
    assert.equal(view.state, "running");

    // A fresh service instance over the same kernel reconciles the attempt and
    // rebuilds the poller — its wait resolves when the process actually exits.
    const errors: Error[] = [];
    const restarted = createExperimentService({
      client: f.client,
      resources: f.resources,
      sources: f.sources,
      resolveWorkspaceRoot: async () => f.workspace,
      onError: (error) => errors.push(error),
    });
    const waited = await restarted.wait(f.caller, attemptId, 30_000);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.attempt.state, "completed");
    const logs = await restarted.logs(f.caller, { attemptId });
    assert.match(logs.text, /late-exit/);
  });

  it("registers sources, resolves them as inputs, and rejects retired or malformed locators", async () => {
    const f = await fixture();
    const registered = await f.sources.register(f.caller.workspaceId, {
      kind: "dataset",
      label: "fixtures",
      path: "data/fixtures",
      note: "baseline inputs",
    }, { sessionId: "s-1", threadId: "t-1", runId: "r-1" });
    assert.equal(registered.state, "available");

    const listed = await f.sources.list(f.caller.workspaceId, { kind: "dataset" });
    assert.equal(listed.sources.length, 1);
    assert.equal(listed.sources[0]!.sourceId, registered.sourceId);

    await assert.rejects(
      f.sources.register(f.caller.workspaceId, { kind: "dataset" }),
      /locator|uri|path|objectHash/i,
    );

    // A registered sourceId is a valid experiment input.
    const submitted = await f.experiments.submit(f.caller, {
      ...node("process.stdout.write('with-input')"),
      inputs: [{ sourceId: registered.sourceId, role: "training data" }],
    });
    const waited = await f.experiments.wait(f.caller, submitted.attempt.attemptId, 30_000);
    assert.equal(waited.attempt.state, "completed");
    const detail = await f.experiments.get(f.caller, submitted.attempt.attemptId);
    assert.equal(detail.spec?.inputs[0]?.sourceId, registered.sourceId);

    // A bogus object hash is rejected at submit, not at run time.
    await assert.rejects(
      f.experiments.submit(f.caller, { ...node("process.stdout.write('x')"), inputs: [{ objectHash: "md5-deadbeef" }] }),
      /sha256/i,
    );
    // An unknown source is rejected as well.
    await assert.rejects(
      f.experiments.submit(f.caller, { ...node("process.stdout.write('x')"), inputs: [{ sourceId: "src-missing" }] }),
      /unknown|retired/i,
    );
    assert.deepEqual(f.errors, []);
  });
});
