import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRuntimeDispatchContext,
  dispatchRuntimeRequest,
  PiRuntimeBroker,
  RuntimeDispatchError,
} from "../src/index.js";

describe("runtime dispatcher configuration text authorities", () => {
  it("routes closed authority payloads and authority watch targets", async () => {
    const calls: Array<{ method: string; params: unknown; target: unknown }> = [];
    const snapshot = {
      authority: "aft-user" as const,
      content: "{\n  // AFT\n}\n",
      exists: false,
      format: "jsonc" as const,
      path: "C:\\Users\\owner\\.config\\cortexkit\\aft.jsonc",
      projectTrusted: true,
      revision: "revision-1",
    };
    const broker = {
      requestForWorkspace: async (cwd: string, method: string, params: unknown) => {
        calls.push({ method, params, target: { cwd } });
        return snapshot;
      },
      unwatchConfig: async () => ({ unwatched: true }),
      watchConfig: async (target: unknown, watchTarget: unknown) => {
        calls.push({ method: "config.watch", params: watchTarget, target });
        return { target: watchTarget, watchId: "watch-1" };
      },
    } as unknown as PiRuntimeBroker;

    assert.equal(
      (await dispatchRuntimeRequest(broker, "config.text.authority.get", {
        authority: "aft-user",
        cwd: "C:\\workspace",
      })).path,
      snapshot.path,
    );
    await dispatchRuntimeRequest(broker, "config.text.authority.update", {
      authority: "aft-user",
      content: "{\n  // AFT\n  \"enabled\": true,\n}\n",
      cwd: "C:\\workspace",
      expectedRevision: "revision-0",
    });
    const context = createRuntimeDispatchContext();
    const subscription = await dispatchRuntimeRequest(
      broker,
      "config.watch",
      {
        cwd: "C:\\workspace",
        target: { authority: "aft-user", kind: "text-authority" },
      },
      context,
    );

    assert.equal(subscription.watchId, "watch-1");
    assert.deepEqual(calls, [
      {
        method: "config.text.authority.get",
        params: { authority: "aft-user" },
        target: { cwd: "C:\\workspace" },
      },
      {
        method: "config.text.authority.update",
        params: {
          authority: "aft-user",
          content: "{\n  // AFT\n  \"enabled\": true,\n}\n",
          expectedRevision: "revision-0",
        },
        target: { cwd: "C:\\workspace" },
      },
      {
        method: "config.watch",
        params: { authority: "aft-user", kind: "text-authority" },
        target: { cwd: "C:\\workspace" },
      },
    ]);
  });

  it("routes the Hermes Memory user authority without accepting arbitrary paths", async () => {
    const calls: Array<{ method: string; params: unknown; target: unknown }> = [];
    const snapshot = {
      authority: "hermes-memory-user" as const,
      content: "{\n  \"reviewEnabled\": true\n}\n",
      exists: true,
      format: "json" as const,
      path: "C:\\Users\\owner\\.pi\\agent\\hermes-memory-config.json",
      projectTrusted: false,
      revision: "revision-1",
    };
    const broker = {
      requestForWorkspace: async (cwd: string, method: string, params: unknown) => {
        calls.push({ method, params, target: { cwd } });
        return snapshot;
      },
    } as unknown as PiRuntimeBroker;

    assert.equal(
      (await dispatchRuntimeRequest(broker, "config.text.authority.get", {
        authority: "hermes-memory-user",
        cwd: "C:\\workspace",
      })).path,
      snapshot.path,
    );
    assert.deepEqual(calls, [
      {
        method: "config.text.authority.get",
        params: { authority: "hermes-memory-user" },
        target: { cwd: "C:\\workspace" },
      },
    ]);

    await assert.rejects(
      dispatchRuntimeRequest(broker, "config.text.authority.get", {
        authority: "C:\\arbitrary.json",
        cwd: "C:\\workspace",
      }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeDispatchError);
        assert.equal(error.code, "invalid_params");
        return true;
      },
    );
  });

  it("rejects renderer-selected authority names", async () => {
    const broker = {} as PiRuntimeBroker;
    await assert.rejects(
      dispatchRuntimeRequest(broker, "config.text.authority.get", {
        authority: "C:\\arbitrary.json",
        cwd: "C:\\workspace",
      }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeDispatchError);
        assert.equal(error.code, "invalid_params");
        return true;
      },
    );
  });
});
