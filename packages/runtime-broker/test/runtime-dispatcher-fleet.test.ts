import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRuntimeDispatchContext,
  dispatchRuntimeRequest,
  PiRuntimeBroker,
  RuntimeDispatchError,
} from "../src/index.js";

describe("runtime dispatcher Fleet actions", () => {
  it("routes closed fleet.action payloads and rejects unknown fields", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const broker = {
      requestForSession: async (sessionId: string, method: string, params: unknown) => {
        calls.push({ method, params });
        assert.equal(sessionId, "session-1");
        return {
          message: "Started printf",
          providerId: "pi-background-tasks",
          snapshot: { entries: [], omitted: 0, providers: [], totalActive: 0 },
          success: true,
        };
      },
    } as unknown as PiRuntimeBroker;

    await dispatchRuntimeRequest(broker, "fleet.action", {
      action: "run",
      input: {
        command: "printf ok",
        isAgent: false,
        name: "printf",
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      },
      providerId: "pi-background-tasks",
      sessionId: "session-1",
    });

    assert.deepEqual(calls, [{
      method: "fleet.action",
      params: {
        action: "run",
        input: {
          command: "printf ok",
          isAgent: false,
          name: "printf",
          notifyOnCompletion: true,
          triggerOnCompletion: true,
        },
        providerId: "pi-background-tasks",
        sessionId: "session-1",
      },
    }]);

    await assert.rejects(
      () => dispatchRuntimeRequest(broker, "fleet.action", {
        action: "logs",
        cwd: "C:\\workspace",
        entryKey: "task-1",
        providerId: "pi-background-tasks",
        sessionId: "session-1",
      }, createRuntimeDispatchContext()),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeDispatchError);
        assert.equal(error.code, "invalid_params");
        assert.match(error.message, /Unknown fleet.action field cwd/);
        return true;
      },
    );
  });
});
