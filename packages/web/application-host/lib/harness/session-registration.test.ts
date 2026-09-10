import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessActorIdentity, PiSettingsSnapshot } from "@piarium/protocol";
import { createHarnessServiceHost, type HarnessSessionContext } from "./service-host.js";
import { createHarnessSessionRegistration } from "./session-registration.js";
import { createHarnessRouter } from "./router.js";
import { registerHarnessServices } from "./harness-services.js";

const actor: HarnessActorIdentity = { authorityInstanceId: "host", sessionId: "session", workerId: "worker", workerGeneration: 1 };
const snapshot: PiSettingsSnapshot = { global: {}, globalRevision: "g1", project: {}, projectRevision: "p1", projectTrusted: false };
const context = (identity = actor): HarnessSessionContext => ({ actor: identity, workspaceId: "workspace", workspaceRoot: "D:/workspace", grantedCapabilities: ["read.output", "process.shell"] });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
};
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture(readSettings: (ctx: HarnessSessionContext) => Promise<PiSettingsSnapshot>) {
  const dropInputContexts = vi.fn();
  const host = createHarnessServiceHost({
    search: async () => ({ status: "empty", generation: undefined }), resolveWorkspaceRoot: async () => "D:/workspace",
    discoveredShells: {}, dropAgentInputContexts: dropInputContexts,
  });
  cleanup.push(() => host.dispose());
  const registrations = createHarnessSessionRegistration({ host, readSettings });
  cleanup.push(() => registrations.dispose());
  return { host, registrations, dropInputContexts };
}

describe("asynchronous Harness registration", () => {
  it("lets the first public request wait for its exact actor registration", async () => {
    const settings = deferred<PiSettingsSnapshot>();
    const { host, registrations, dropInputContexts } = fixture(async () => settings.promise);
    const responses: unknown[] = [];
    const router = createHarnessRouter({ respond: async (_sessionId, _requestId, result) => { responses.push(result); }, resolveActor: registrations.resolveActor });
    cleanup.push(() => router.dispose());
    registerHarnessServices(router, host);
    const registered = registrations.register(context());
    const request = router.processEvent({ actor, kind: "host", envelope: { kind: "event", event: "harness.request", data: { requestId: "first", method: "output.store", params: { text: "hello" } } } });
    await Promise.resolve();
    expect(responses).toHaveLength(0);
    settings.resolve(snapshot);
    await Promise.all([registered, request]);
    expect(responses).toEqual([expect.objectContaining({ ok: true, result: expect.objectContaining({ total: 5 }) })]);
    // A prompt may already have captured its draft before the first snapshot.
    expect(dropInputContexts).not.toHaveBeenCalled();
  });

  it("does not register a dropped actor when its settings arrive late", async () => {
    const settings = deferred<PiSettingsSnapshot>();
    const { host, registrations } = fixture(async () => settings.promise);
    const registered = registrations.register(context());
    registrations.dropSession(actor.sessionId, actor);
    await registered;
    settings.resolve(snapshot);
    await Promise.resolve();
    expect(host.hasActor(actor)).toBe(false);
    expect(await registrations.resolveActor(actor)).toBeNull();
  });

  it("does not coalesce settings across worker generations or drop the new actor on an old exit", async () => {
    const oldSettings = deferred<PiSettingsSnapshot>();
    const newSettings = deferred<PiSettingsSnapshot>();
    const { host, registrations } = fixture(async (ctx) => ctx.actor.workerGeneration === 1 ? oldSettings.promise : newSettings.promise);
    const oldRegistered = registrations.register(context());
    const next = { ...actor, workerGeneration: 2 };
    const newRegistered = registrations.register(context(next));
    registrations.dropSession(actor.sessionId, actor);
    oldSettings.resolve(snapshot);
    await oldRegistered;
    expect(await registrations.resolveActor(actor)).toBeNull();
    newSettings.resolve(snapshot);
    await newRegistered;
    expect(host.hasActor(next)).toBe(true);
    expect((await registrations.resolveActor(next))?.workerGeneration).toBe(2);
  });

  it("reports unavailable shell settings without inventing the auto configuration", async () => {
    const { host, registrations } = fixture(async () => { throw new Error("settings unavailable"); });
    await registrations.register(context());
    expect(host.hasActor(actor)).toBe(true);
    expect(host.getInterpreter(actor.sessionId)).toEqual({ unavailable: expect.objectContaining({ reason: "Shell settings are unavailable" }) });
  });

  it("cancels a caller's wait without cancelling another request's initialization", async () => {
    const settings = deferred<PiSettingsSnapshot>();
    const { registrations } = fixture(async () => settings.promise);
    const registered = registrations.register(context());
    const controller = new AbortController();
    const waiting = registrations.resolveActor(actor, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    settings.resolve(snapshot);
    await registered;
    expect(await registrations.resolveActor(actor)).not.toBeNull();
  });
});
