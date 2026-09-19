import type { Message } from "@earendil-works/pi-ai";
import type { Zone2StatusResult } from "@piarium/protocol";
import type { ContextModelRequest } from "./context-request-boundary.js";
import type { HostServicesBridge } from "./host-services-bridge.js";

/**
 * Per-request team-status injection (D-300 §9.3.7). Runs inside the context
 * request boundary once per dispatched model request — covering first input,
 * tool-loop continuations, wait returns, message wakes, and post-compaction
 * rebuilds without any polling.
 *
 * The Host prepares a delta against this observer's committed cursor and
 * returns it uncommitted; `confirm` acknowledges only after the request that
 * carried the rows was actually dispatched. Injection is request-scoped — it
 * is not persisted into session history — so a compaction drops the cursor's
 * receipts and the next request honestly rebuilds a full table.
 *
 * The status service is best-effort: when it is unavailable or nothing
 * changed, the request proceeds untouched.
 */
export function createThreadStatusInjector(
  bridge: HostServicesBridge,
): (request: ContextModelRequest) => Promise<{ request?: ContextModelRequest; confirm?(): void } | undefined> {
  return async (request) => {
    let result: Zone2StatusResult;
    try {
      result = await bridge.request<"zone2.status">("zone2.status", {}, { timeoutMs: 1_000 });
    } catch {
      return undefined;
    }
    const content = result.content;
    if (!content) return undefined;
    const observationRef = result.observationRef;
    const trailer = {
      role: "user",
      content: [{ type: "text", text: content }],
      timestamp: Date.now(),
    } as Message;
    return {
      request: {
        ...request,
        context: { ...request.context, messages: [...request.context.messages, trailer] },
      },
      ...(observationRef === undefined ? {} : {
        confirm: () => {
          void bridge.request<"zone2.statusDelivered">("zone2.statusDelivered", { observationRef }, { timeoutMs: 2_000 })
            .catch(() => undefined);
        },
      }),
    };
  };
}
