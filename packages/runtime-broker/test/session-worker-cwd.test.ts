import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { PiRuntimeBroker } from "../src/runtime-broker.js";

const HOST_ENTRY = resolve(import.meta.dirname, "../../pi-host/src/main.ts");

interface CwdRecord {
  factoryCwd: string;
  label: string;
  pid: number;
}

async function installCwdExtension(workspace: string, label: string, logFile: string): Promise<void> {
  const extensionDir = join(workspace, ".pi", "extensions");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(extensionDir, "factory-cwd.ts"),
    `import { appendFileSync } from "node:fs";
    export default function extension(pi: any) {
      const record = { factoryCwd: process.cwd(), label: ${JSON.stringify(label)}, pid: process.pid };
      appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(record) + "\\n", "utf8");
      pi.registerCommand("record-factory-cwd", {
        description: "Record the extension factory cwd",
        handler: async () => pi.appendEntry("piarium.test.factory-cwd", record),
      });
    }\n`,
    "utf8",
  );
}

async function readCwdRecords(logFile: string): Promise<CwdRecord[]> {
  let content: string;
  try {
    content = await readFile(logFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CwdRecord);
}

function createBroker(options: {
  agentDir: string;
  catalogCwd: string;
}): PiRuntimeBroker {
  return new PiRuntimeBroker({
    agentDir: options.agentDir,
    client: {
      clientName: "session-worker-cwd-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    cwd: options.catalogCwd,
    execArgv: ["--import", import.meta.resolve("tsx")],
    hostEntry: HOST_ENTRY,
    projectTrustOverride: true,
  });
}

async function writeSessionHeader(
  sessionFile: string,
  input: { cwd: string; sessionId: string },
): Promise<void> {
  await writeFile(
    sessionFile,
    `${JSON.stringify({
      cwd: input.cwd,
      id: input.sessionId,
      timestamp: "2026-08-19T00:00:00.000Z",
      type: "session",
      version: 3,
    })}\n`,
    "utf8",
  );
}

test("session workers use project cwd while the reused catalog worker keeps broker cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-worker-cwd-create-"));
  const agentDir = join(root, "agent");
  const catalogCwd = join(root, "catalog");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const logFile = join(root, "factory-cwd.jsonl");
  await mkdir(catalogCwd, { recursive: true });
  await installCwdExtension(workspaceA, "a", logFile);
  await installCwdExtension(workspaceB, "b", logFile);
  const broker = createBroker({ agentDir, catalogCwd });

  try {
    await broker.warmup();
    assert.equal(broker.workerCount, 1);
    assert.ok((await broker.listCommandsForWorkspace(workspaceA)).some(
      (command) => command.name === "record-factory-cwd",
    ));
    assert.ok((await broker.listCommandsForWorkspace(workspaceB)).some(
      (command) => command.name === "record-factory-cwd",
    ));
    assert.equal(broker.workerCount, 1, "workspace switches reuse the catalog worker");
    const catalogRecords = await readCwdRecords(logFile);
    assert.ok(catalogRecords.some((record) => record.label === "a"));
    assert.ok(catalogRecords.some((record) => record.label === "b"));
    assert.ok(catalogRecords.every((record) => record.factoryCwd === resolve(catalogCwd)));

    await writeFile(logFile, "", "utf8");
    const createdA = await broker.createSession(workspaceA);
    const createdB = await broker.createSession(workspaceB);
    assert.equal(createdA.cwd, resolve(workspaceA));
    assert.equal(createdB.cwd, resolve(workspaceB));
    assert.equal(broker.workerCount, 3);
    assert.ok(createdA.sessionFile);
    await broker.openSession({ sessionFile: createdA.sessionFile, sessionId: createdA.sessionId });
    assert.equal(broker.workerCount, 3, "reopening an active session reuses its worker");

    const sessionRecords = await readCwdRecords(logFile);
    assert.ok(sessionRecords.some(
      (record) => record.label === "a" && record.factoryCwd === resolve(workspaceA),
    ));
    assert.ok(sessionRecords.some(
      (record) => record.label === "b" && record.factoryCwd === resolve(workspaceB),
    ));
    assert.equal(
      sessionRecords.some((record) => record.factoryCwd === resolve(catalogCwd)),
      false,
    );
  } finally {
    await broker.dispose();
    assert.equal(broker.workerCount, 0);
    await rm(root, { force: true, recursive: true });
  }
});

test("session.open resolves every cwd source before starting the session worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-worker-cwd-open-"));
  const agentDir = join(root, "agent");
  const catalogCwd = join(root, "catalog");
  const headerCwd = join(root, "header-cwd");
  const resolvedCwd = join(root, "resolved-cwd");
  const explicitCwd = join(root, "explicit-cwd");
  const staleCwd = join(root, "stale-cwd");
  const authoritativeCwd = join(root, "authoritative-cwd");
  const logFile = join(root, "factory-cwd.jsonl");
  await mkdir(catalogCwd, { recursive: true });
  await installCwdExtension(headerCwd, "header", logFile);
  await installCwdExtension(resolvedCwd, "resolved", logFile);
  await installCwdExtension(explicitCwd, "explicit", logFile);
  await installCwdExtension(staleCwd, "stale", logFile);
  await installCwdExtension(authoritativeCwd, "authoritative", logFile);
  const broker = createBroker({ agentDir, catalogCwd });

  try {
    const known = await broker.createSession(headerCwd, "Known cwd session");
    assert.ok(known.sessionFile);
    await writeSessionHeader(known.sessionFile, {
      cwd: headerCwd,
      sessionId: known.sessionId,
    });
    await broker.closeSession(known.sessionId);
    await writeFile(logFile, "", "utf8");
    const openedKnown = await broker.openSession({ sessionId: known.sessionId });
    assert.equal(openedKnown.cwd, resolve(headerCwd));
    const knownRecords = await readCwdRecords(logFile);
    assert.ok(knownRecords.length > 0);
    assert.ok(knownRecords.every(
      (record) => record.factoryCwd === resolve(headerCwd),
    ));
    await broker.closeSession(openedKnown.sessionId);

    const externalSessionFile = join(catalogCwd, "external-session.jsonl");
    await writeSessionHeader(externalSessionFile, {
      cwd: resolvedCwd,
      sessionId: "external-session",
    });
    await writeFile(logFile, "", "utf8");
    const openedResolved = await broker.openSession({
      sessionFile: "external-session.jsonl",
      sessionId: "conflicting-session-id",
    });
    assert.equal(openedResolved.cwd, resolve(resolvedCwd));
    assert.equal(openedResolved.sessionId, "external-session");
    const resolvedRecords = await readCwdRecords(logFile);
    assert.ok(resolvedRecords.length > 0);
    assert.ok(resolvedRecords.every(
      (record) => record.factoryCwd === resolve(resolvedCwd),
    ));
    await broker.closeSession(openedResolved.sessionId);

    const explicitSessionFile = join(root, "explicit-session.jsonl");
    await writeSessionHeader(explicitSessionFile, {
      cwd: headerCwd,
      sessionId: "explicit-session",
    });
    await writeFile(logFile, "", "utf8");
    const openedExplicit = await broker.openSession({
      cwd: explicitCwd,
      sessionFile: explicitSessionFile,
    });
    assert.equal(openedExplicit.cwd, resolve(explicitCwd));
    const explicitRecords = await readCwdRecords(logFile);
    assert.ok(explicitRecords.length > 0);
    assert.ok(explicitRecords.every(
      (record) => record.factoryCwd === resolve(explicitCwd),
    ));
    await broker.closeSession(openedExplicit.sessionId);

    const relativeCwd = join(catalogCwd, "relative-project");
    await installCwdExtension(relativeCwd, "relative", logFile);
    const relativeSessionFile = join(catalogCwd, "relative-session.jsonl");
    await writeSessionHeader(relativeSessionFile, {
      cwd: "relative-project",
      sessionId: "relative-session",
    });
    await writeFile(logFile, "", "utf8");
    const openedRelative = await broker.openSession({ sessionFile: relativeSessionFile });
    assert.equal(openedRelative.cwd, resolve(relativeCwd));
    const relativeRecords = await readCwdRecords(logFile);
    assert.ok(relativeRecords.length > 0);
    assert.ok(relativeRecords.every(
      (record) => record.factoryCwd === resolve(relativeCwd),
    ));
    await broker.closeSession(openedRelative.sessionId);

    const stale = await broker.createSession(staleCwd, "Stale cwd session");
    assert.ok(stale.sessionFile);
    await writeSessionHeader(stale.sessionFile, {
      cwd: staleCwd,
      sessionId: stale.sessionId,
    });
    await broker.closeSession(stale.sessionId);
    const staleContent = await readFile(stale.sessionFile, "utf8");
    const [headerLine, ...remainingLines] = staleContent.split("\n");
    assert.ok(headerLine);
    const staleHeader = JSON.parse(headerLine) as Record<string, unknown>;
    staleHeader.cwd = authoritativeCwd;
    await writeFile(
      stale.sessionFile,
      [JSON.stringify(staleHeader), ...remainingLines].join("\n"),
      "utf8",
    );
    await rm(staleCwd, { force: true, recursive: true });
    await writeFile(logFile, "", "utf8");
    const reopenedStale = await broker.openSession({ sessionId: stale.sessionId });
    assert.equal(reopenedStale.cwd, resolve(authoritativeCwd));
    assert.deepEqual(broker.activeSessionIds, [stale.sessionId]);
    assert.equal(broker.workerCount, 2, "only catalog and the header-resolved session worker remain");
    const staleRecords = await readCwdRecords(logFile);
    assert.ok(staleRecords.length > 0);
    assert.ok(staleRecords.every(
      (record) => record.label === "authoritative"
        && record.factoryCwd === resolve(authoritativeCwd),
    ));
  } finally {
    await broker.dispose();
    assert.equal(broker.workerCount, 0);
    await rm(root, { force: true, recursive: true });
  }
});

test("a missing child cwd leaves no failed session worker behind", async () => {
  const root = await mkdtemp(join(tmpdir(), "piarium-worker-cwd-missing-"));
  const catalogCwd = join(root, "catalog");
  const missingCwd = join(root, "missing");
  await mkdir(catalogCwd, { recursive: true });
  const broker = createBroker({ agentDir: join(root, "agent"), catalogCwd });
  try {
    await assert.rejects(broker.createSession(missingCwd));
    assert.equal(broker.workerCount, 0);
    assert.deepEqual(broker.activeSessionIds, []);
  } finally {
    await broker.dispose();
    await rm(root, { force: true, recursive: true });
  }
});
