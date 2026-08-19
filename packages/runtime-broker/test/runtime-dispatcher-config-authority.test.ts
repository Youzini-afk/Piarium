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
      authority: "pi-lens-project" as const,
      content: "{}\n",
      exists: false,
      format: "json" as const,
      path: "C:\\workspace\\.pi-lens.json",
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
        authority: "pi-lens-project",
        cwd: "C:\\workspace",
      })).path,
      snapshot.path,
    );
    await dispatchRuntimeRequest(broker, "config.text.authority.update", {
      authority: "pi-lens-global",
      content: "{\"enabled\":true}\n",
      cwd: "C:\\workspace",
      expectedRevision: "revision-0",
    });
    const context = createRuntimeDispatchContext();
    const subscription = await dispatchRuntimeRequest(
      broker,
      "config.watch",
      {
        cwd: "C:\\workspace",
        target: { authority: "pi-lens-project", kind: "text-authority" },
      },
      context,
    );

    assert.equal(subscription.watchId, "watch-1");
    assert.deepEqual(calls, [
      {
        method: "config.text.authority.get",
        params: { authority: "pi-lens-project" },
        target: { cwd: "C:\\workspace" },
      },
      {
        method: "config.text.authority.update",
        params: {
          authority: "pi-lens-global",
          content: "{\"enabled\":true}\n",
          expectedRevision: "revision-0",
        },
        target: { cwd: "C:\\workspace" },
      },
      {
        method: "config.watch",
        params: { authority: "pi-lens-project", kind: "text-authority" },
        target: { cwd: "C:\\workspace" },
      },
    ]);
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
