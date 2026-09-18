import type { HostEvent, HostEventData } from "@piarium/protocol";
import type { SessionHost } from "../src/session-host.js";

export type HarnessEmit = <E extends HostEvent>(event: E, data: HostEventData<E>) => void;

/**
 * Answers the `harness.request` events a standalone SessionHost emits so a
 * tool call does not stall on the 30s bridge timeout. Methods without a
 * registered handler get an explicit error result instead of a silent wait —
 * a new bridge dependency must be declared by the test that exercises it.
 */
export const createHarnessEmit = (
  handlers: Record<string, (params: unknown) => unknown>,
): { emit: HarnessEmit; bind: (host: SessionHost) => void } => {
  let host: SessionHost | undefined;
  const emit: HarnessEmit = (event, data) => {
    if (event !== "harness.request" || !data || typeof data !== "object") return;
    const request = data as { requestId: string; method: string; params: unknown };
    const handler = handlers[request.method];
    queueMicrotask(() => {
      if (!host) return;
      host.respondHarness(
        host.sessionId ?? "",
        request.requestId,
        handler
          ? { ok: true, result: handler(request.params) }
          : {
            ok: false,
            error: {
              code: "unavailable",
              message: `no test handler for harness method ${request.method}`,
            },
          },
      );
    });
  };
  return {
    emit,
    bind: (sessionHost) => {
      host = sessionHost;
    },
  };
};

/**
 * Mirrors the Host-side `permission.inspect` result: the inspection params
 * plus the workspace binding fields a real Host fills in. Tests run outside a
 * workspace authority, so both ids stay null.
 */
export const permissionInspectResult = (params: unknown): Record<string, unknown> => ({
  ...(params as Record<string, unknown>),
  executionWorkspaceId: null,
  owningWorkspaceId: null,
});
