import { isHarnessMethod, type HarnessError, type HarnessMethod, type HarnessServiceMap, buildHarnessRespondParams } from "@piarium/protocol";
import { HarnessServiceError } from "./harness-services.js";

export { buildHarnessRespondParams };

export interface HarnessServiceContext {
  sessionId: string;
  workspaceId: string | null;
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
  resolveWorkspace: (sessionId: string) => Promise<string | null>;
  defaultTimeoutMs?: number;
}

interface RouterHostEvent {
  envelope?: {
    data?: unknown;
    event?: string;
    kind?: string;
  } | undefined;
  kind: string;
  sessionId?: string;
}

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
    const data = event.envelope.data as {
      requestId: string;
      sessionId: string;
      method: string;
      params: unknown;
    } | undefined;
    if (!data || typeof data.requestId !== "string" || typeof data.sessionId !== "string") return;
    if (!isHarnessMethod(data.method)) {
      await options.respond(data.sessionId, data.requestId, {
        ok: false,
        error: harnessError("unavailable", `Unknown harness method: ${data.method}`),
      });
      return;
    }
    const method = data.method;
    const service = services.get(method);
    if (!service) {
      await options.respond(data.sessionId, data.requestId, {
        ok: false,
        error: harnessError("unavailable", `Harness method not registered: ${method}`),
      });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), defaultTimeoutMs);
    try {
      const workspaceId = await options.resolveWorkspace(data.sessionId);
      const result = await service.handle(data.params as never, {
        sessionId: data.sessionId,
        workspaceId,
        signal: controller.signal,
      });
      await options.respond(data.sessionId, data.requestId, { ok: true, result });
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
      await options.respond(data.sessionId, data.requestId, {
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
