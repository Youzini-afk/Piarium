import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FleetProviderRegistry } from "../src/fleet/registry.js";
import type {
  FleetProviderAdapter,
  PiFleetProviderActionRequest,
  PiFleetProviderActionResult,
  PiFleetProviderResult,
} from "../src/fleet/types.js";

const providerResult = (
  id: string,
  state: PiFleetProviderResult["provider"]["state"],
  entries: PiFleetProviderResult["entries"] = [],
): PiFleetProviderResult => ({
  entries,
  omitted: id === "alpha" ? 1 : 0,
  provider: { id, label: id, state },
  totalActive: entries.filter((entry) => entry.state === "running").length,
});

const runningEntry = (providerId: string, key: string) => ({
  actions: [],
  key,
  kind: "background-task" as const,
  name: key,
  providerId,
  startedAt: 1,
  state: "running" as const,
});

class FakeAdapter implements FleetProviderAdapter {
  readonly id: string;
  readonly #status: () => Promise<PiFleetProviderResult>;
  readonly #action: ((request: PiFleetProviderActionRequest) => Promise<PiFleetProviderActionResult>) | undefined;
  started: string[] = [];
  ended = 0;

  constructor(
    id: string,
    status: () => Promise<PiFleetProviderResult>,
    action?: (request: PiFleetProviderActionRequest) => Promise<PiFleetProviderActionResult>,
  ) {
    this.id = id;
    this.#status = status;
    this.#action = action;
  }

  attach(): () => void {
    return () => undefined;
  }

  startSession(sessionId: string): void {
    this.started.push(sessionId);
  }

  endSession(): void {
    this.ended += 1;
  }

  status(): Promise<PiFleetProviderResult> {
    return this.#status();
  }

  action(request: PiFleetProviderActionRequest): Promise<PiFleetProviderActionResult> {
    if (!this.#action) throw new Error("action not implemented");
    return this.#action(request);
  }
}

describe("Fleet provider registry", () => {
  it("aggregates independent providers and keeps a healthy provider when another fails", async () => {
    const registry = new FleetProviderRegistry([
      new FakeAdapter("alpha", async () => providerResult("alpha", "active", [runningEntry("alpha", "a-1")])),
      new FakeAdapter("beta", async () => {
        throw new Error("beta exploded");
      }),
    ]);
    const snapshot = await registry.status("session-a");
    assert.equal(snapshot.providers[0]?.state, "active");
    assert.equal(snapshot.providers[1]?.state, "degraded");
    assert.match(snapshot.providers[1]?.issue ?? "", /beta exploded/);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0]?.key, "a-1");
    assert.equal(snapshot.omitted, 1);
    assert.equal(snapshot.totalActive, 1);
  });

  it("dispatches an action only to the named provider and refreshes the snapshot", async () => {
    let betaCalled = false;
    const registry = new FleetProviderRegistry([
      new FakeAdapter("alpha", async () => providerResult("alpha", "active"), async () => ({
        message: "alpha-run",
        success: true,
      })),
      new FakeAdapter("beta", async () => providerResult("beta", "active"), async () => {
        betaCalled = true;
        return { message: "beta-run", success: true };
      }),
    ]);
    const result = await registry.action({
      action: "run",
      providerId: "alpha",
      sessionId: "session-a",
    });
    assert.equal(result.success, true);
    assert.equal(result.providerId, "alpha");
    assert.equal(result.message, "alpha-run");
    assert.equal(betaCalled, false);
    assert.equal(result.snapshot.providers.length, 2);
  });

  it("returns healthy provider data when another provider never replies", async () => {
    const registry = new FleetProviderRegistry([
      new FakeAdapter("alpha", async () => providerResult("alpha", "active", [runningEntry("alpha", "a-1")])),
      new FakeAdapter("beta", () => new Promise(() => undefined)),
    ], { readDeadlineMs: 40 });
    const snapshot = await registry.status("session-a");
    assert.equal(snapshot.providers[0]?.state, "active");
    assert.equal(snapshot.entries[0]?.key, "a-1");
    assert.equal(snapshot.providers[1]?.state, "degraded");
    assert.match(snapshot.providers[1]?.issue ?? "", /timed out/);
  });

  it("does not keep a completed action pending on an unrelated mute provider", async () => {
    const registry = new FleetProviderRegistry([
      new FakeAdapter("alpha", async () => providerResult("alpha", "active"), async () => ({
        message: "alpha-run",
        success: true,
      })),
      new FakeAdapter("beta", () => new Promise(() => undefined)),
    ], { readDeadlineMs: 40 });
    const result = await registry.action({
      action: "run",
      providerId: "alpha",
      sessionId: "session-a",
    });
    assert.equal(result.success, true);
    assert.equal(result.message, "alpha-run");
    assert.equal(result.snapshot.providers.find((provider) => provider.id === "beta")?.state, "degraded");
  });
});
