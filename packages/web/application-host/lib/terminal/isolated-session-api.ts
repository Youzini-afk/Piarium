import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createTerminalRuntime } from "./runtime.js";
import type { TerminalSessionApi } from "./session-api.js";

type Runtime = ReturnType<typeof createTerminalRuntime>;

/**
 * In-process terminal session API that uses the same runtime as HTTP/WS.
 * Tests and Host assembly use this when a listening server is not required.
 */
export function createIsolatedTerminalSessionApi(
  overrides: Record<string, unknown> = {},
): Runtime & TerminalSessionApi {
  const app = overrides.app ?? {
    get() {},
    post() {},
    delete() {},
  };
  const server = overrides.server ?? new EventEmitter();
  return createTerminalRuntime({
    app,
    server,
    fs,
    path,
    uiAuthController: null,
    buildAugmentedPath: () => process.env.PATH || "",
    searchPathFor: () => null,
    isExecutable: () => false,
    isRequestOriginAllowed: async () => true,
    rejectWebSocketUpgrade() {},
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30_000,
    TERMINAL_INPUT_WS_REBIND_WINDOW_MS: 1_000,
    TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: 3,
    ...overrides,
  } as Parameters<typeof createTerminalRuntime>[0]);
}
