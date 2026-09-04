import {
  HARNESS_METHOD_CAPABILITY,
  isHarnessMethod,
  type HarnessActorContext,
  type HarnessActorIdentity,
  type HarnessError,
  type HarnessMethod,
  type HarnessRequestData,
  type HarnessServiceMap,
  buildHarnessRespondParams,
  HARNESS_MAX_REQUEST_TIMEOUT_MS,
} from "@piarium/protocol";
import { HarnessServiceError } from "./service-error.js";

export { buildHarnessRespondParams };

export interface HarnessServiceContext {
  actor: HarnessActorContext;
  sessionId: HarnessActorContext["sessionId"];
  workspaceId: HarnessActorContext["workspaceId"];
  signal: AbortSignal;
}

export interface HarnessService<M extends HarnessMethod> {
  handle(
    params: HarnessServiceMap[M]["params"],
    ctx: HarnessServiceContext,
  ): Promise<HarnessServiceMap[M]["result"]>;
}

export interface HarnessRouterOptions {
  respond: (sessionId: string, requestId: string, outcome: { ok: true; result: unknown } | { ok: false; error: HarnessError }) => Promise<void>;
  resolveActor: (identity: HarnessActorIdentity) => Promise<HarnessActorContext | null>;
  authorizeWorkspacePath?: (
    actor: HarnessActorContext,
    path: string,
    options: { allowMissing: boolean },
  ) => Promise<boolean>;
  defaultTimeoutMs?: number;
}

interface RouterHostEvent {
  actor?: HarnessActorIdentity;
  envelope?: {
    data?: unknown;
    event?: string;
    kind?: string;
  } | undefined;
  kind: string;
  sessionId?: string;
}

const requestPath = (
  method: HarnessMethod,
  params: unknown,
): { allowMissing: boolean; path: string } | null | "invalid" => {
  const record = params && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
  if (method === "search.content") {
    if (record.path === undefined) return null;
    return typeof record.path === "string" && record.path.trim()
      ? { allowMissing: false, path: record.path }
      : "invalid";
  }
  if (method === "shell.exec") {
    if (record.cwd === undefined) return null;
    return typeof record.cwd === "string" && record.cwd.trim()
      ? { allowMissing: false, path: record.cwd }
      : "invalid";
  }
  if (method === "fs.lock" || method === "lsp.diagnostics" || method === "lsp.diagnosticsSnapshot") {
    return typeof record.path === "string" && record.path.trim()
      ? { allowMissing: method === "fs.lock", path: record.path }
      : "invalid";
  }
  return null;
};

const harnessError = (code: HarnessError["code"], message: string, retryable = false): HarnessError => ({
  code,
  message,
  ...(retryable ? { retryable } : {}),
});

export const createHarnessRouter = (options: HarnessRouterOptions) => {
  const services = new Map<HarnessMethod, HarnessService<HarnessMethod>>();
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  let disposed = false;

  const register = <M extends HarnessMethod>(method: M, service: HarnessService<M>): void => {
    services.set(method, service as HarnessService<HarnessMethod>);
  };

  const processEvent = async (event: RouterHostEvent): Promise<void> => {
    if (disposed) return;
    if (event.kind !== "host" || event.envelope?.kind !== "event" || event.envelope?.event !== "harness.request") return;
    const data = event.envelope.data as HarnessRequestData | undefined;
    const identity = event.actor;
    if (!data || typeof data.requestId !== "string" || !identity) return;
    const respond = (outcome: { ok: true; result: unknown } | { ok: false; error: HarnessError }) => (
      options.respond(identity.sessionId, data.requestId, outcome)
    );
    if (!isHarnessMethod(data.method)) {
      await respond({
        ok: false,
        error: harnessError("unavailable", `Unknown harness method: ${data.method}`),
      });
      return;
    }
    const method = data.method;
    const controller = new AbortController();
    // Per-request timeout override (e.g. thread.wait carries a longer
    // timeout), clamped so a worker cannot pin a handler open forever.
    const requestTimeoutMs = (typeof data.timeoutMs === "number" && data.timeoutMs > 0)
      ? Math.min(data.timeoutMs, HARNESS_MAX_REQUEST_TIMEOUT_MS)
      : defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const actor = await options.resolveActor(identity);
      if (!actor) {
        await respond({
          ok: false,
          error: harnessError("forbidden", "Harness actor is not registered for this session"),
        });
        return;
      }
      const requiredCapability = HARNESS_METHOD_CAPABILITY[method];
      if (!actor.grantedCapabilities.includes(requiredCapability)) {
        await respond({
          ok: false,
          error: harnessError("forbidden", `Harness capability is not granted: ${requiredCapability}`),
        });
        return;
      }
      const scopedPath = requestPath(method, data.params);
      if (scopedPath === "invalid") {
        await respond({
          ok: false,
          error: harnessError("invalid-params", `Harness method ${method} requires a valid path`),
        });
        return;
      }
      if (
        scopedPath
        && (
          !options.authorizeWorkspacePath
          || !await options.authorizeWorkspacePath(actor, scopedPath.path, { allowMissing: scopedPath.allowMissing })
        )
      ) {
        await respond({
          ok: false,
          error: harnessError("forbidden", "Harness path is outside the actor workspace"),
        });
        return;
      }
      const service = services.get(method);
      if (!service) {
        await respond({
          ok: false,
          error: harnessError("unavailable", `Harness method not registered: ${method}`),
        });
        return;
      }
      const result = await service.handle(data.params as never, {
        actor,
        sessionId: actor.sessionId,
        workspaceId: actor.workspaceId,
        signal: controller.signal,
      });
      await respond({ ok: true, result });
    } catch (error) {
      let code: HarnessError["code"];
      let message: string;
      let retryable = false;
      if (error instanceof HarnessServiceError) {
        code = error.harnessCode;
        message = error.message;
        retryable = error.harnessRetryable;
      } else if (error instanceof Error && error.name === "AbortError") {
        code = "timeout";
        message = error.message;
        retryable = true;
      } else {
        code = "failed";
        message = error instanceof Error ? error.message : String(error);
      }
      await respond({
        ok: false,
        error: harnessError(code, message, retryable),
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const dispose = (): void => {
    disposed = true;
    services.clear();
  };

  return { register, processEvent, dispose };
};
