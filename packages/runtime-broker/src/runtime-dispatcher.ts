import {
  PIARIUM_PROTOCOL_VERSION,
  type ExtensionUiResponse,
  type HostMode,
  type HostMethodParams,
  type HostMethodResult,
  type ImageAttachment,
  type JsonValue,
  parseProviderConfigInput,
  type ProviderConfigInput,
  ProviderConfigValidationError,
  type ProviderAuthResponse,
  type RuntimeMethod,
  type RuntimeMethodResult,
} from "@piarium/protocol";
import { PiRuntimeBroker, type PiCatalogMethod } from "./runtime-broker.js";

export class RuntimeDispatchError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean = false) {
    super(message);
    this.name = "RuntimeDispatchError";
    this.code = code;
    this.retryable = retryable;
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeDispatchError("invalid_params", "Runtime params must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const value = record[key];
  if (typeof value !== "string" || (!options.allowEmpty && value.length === 0)) {
    throw new RuntimeDispatchError("invalid_params", `${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeDispatchError("invalid_params", `${key} must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new RuntimeDispatchError("invalid_params", `${key} must be a boolean`);
  }
  return value;
}

function requireEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T {
  const value = requireString(record, key);
  if (!values.includes(value as T)) {
    throw new RuntimeDispatchError(
      "invalid_params",
      `${key} must be one of: ${values.join(", ")}`,
    );
  }
  return value as T;
}

function optionalImages(record: Record<string, unknown>): ImageAttachment[] | undefined {
  const value = record.images;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new RuntimeDispatchError("invalid_params", "images must be an array");
  }
  return value.map((item, index) => {
    const image = requireRecord(item);
    try {
      return {
        data: requireString(image, "data"),
        mimeType: requireString(image, "mimeType"),
      };
    } catch (error) {
      if (error instanceof RuntimeDispatchError) {
        throw new RuntimeDispatchError(
          error.code,
          `images[${index}].${error.message}`,
          error.retryable,
        );
      }
      throw error;
    }
  });
}

function requireExtensionResponse(record: Record<string, unknown>): ExtensionUiResponse {
  const response = requireRecord(record.response);
  const cancelled = optionalBoolean(response, "cancelled");
  return {
    ...(cancelled === undefined ? {} : { cancelled }),
    requestId: requireString(response, "requestId"),
    ...(response.value === undefined ? {} : { value: response.value as JsonValue }),
  };
}

function requireProviderAuthResponse(record: Record<string, unknown>): ProviderAuthResponse {
  const response = requireRecord(record.response);
  const cancelled = optionalBoolean(response, "cancelled");
  if (response.value !== undefined && typeof response.value !== "string") {
    throw new RuntimeDispatchError("invalid_params", "response.value must be a string");
  }
  return {
    ...(cancelled === undefined ? {} : { cancelled }),
    requestId: requireString(response, "requestId"),
    ...(response.value === undefined ? {} : { value: response.value }),
  };
}

function optionalName(record: Record<string, unknown>): string | undefined {
  return optionalString(record, "name");
}

type RuntimeContextTarget = { cwd: string } | { sessionId: string };
type WorkspaceMethod = Exclude<PiCatalogMethod, "session.list">;

function requireRuntimeContext(record: Record<string, unknown>): RuntimeContextTarget {
  const cwd = optionalString(record, "cwd");
  const sessionId = optionalString(record, "sessionId");
  if ((cwd === undefined) === (sessionId === undefined)) {
    throw new RuntimeDispatchError(
      "invalid_params",
      "Exactly one of cwd or sessionId is required",
    );
  }
  return sessionId === undefined ? { cwd: cwd as string } : { sessionId };
}

function requestForRuntimeContext<M extends WorkspaceMethod>(
  broker: PiRuntimeBroker,
  target: RuntimeContextTarget,
  method: M,
  params: HostMethodParams<M>,
): Promise<HostMethodResult<M>> {
  return "sessionId" in target
    ? broker.requestForSession(target.sessionId, method, params)
    : broker.requestForWorkspace(target.cwd, method, params);
}

function requireProviderConfig(value: unknown): ProviderConfigInput {
  try {
    return parseProviderConfigInput(value);
  } catch (error) {
    if (error instanceof ProviderConfigValidationError) {
      throw new RuntimeDispatchError("invalid_params", error.message);
    }
    throw error;
  }
}

function assertNever(value: never): never {
  throw new RuntimeDispatchError("unsupported_method", `Unsupported runtime method: ${String(value)}`);
}

/**
 * Validate and dispatch one untrusted surface request. Every branch constructs
 * a fresh, minimal worker payload so callers cannot smuggle lifecycle fields
 * or route a request to another session.
 */
export async function dispatchRuntimeRequest<M extends RuntimeMethod>(
  broker: PiRuntimeBroker,
  method: M,
  params: unknown,
): Promise<RuntimeMethodResult<M>> {
  const result = await dispatchRuntimeRequestUnchecked(broker, method, params);
  return result as RuntimeMethodResult<M>;
}

async function dispatchRuntimeRequestUnchecked(
  broker: PiRuntimeBroker,
  method: RuntimeMethod,
  params: unknown,
): Promise<unknown> {
  const input = requireRecord(params);
  switch (method) {
    case "host.handshake": {
      const versions = input.protocolVersions;
      if (
        !Array.isArray(versions) ||
        !versions.every((value) => Number.isSafeInteger(value)) ||
        !versions.includes(PIARIUM_PROTOCOL_VERSION)
      ) {
        throw new RuntimeDispatchError(
          "unsupported_version",
          `Client must support Piarium protocol ${PIARIUM_PROTOCOL_VERSION}`,
        );
      }
      requireString(input, "clientName");
      requireString(input, "clientVersion");
      requireEnum<HostMode>(input, "mode", [
        "desktop",
        "headless",
        "mobile",
        "test",
        "vscode",
        "web",
      ]);
      return broker.warmup();
    }

    case "session.list": {
      return broker.listSessions(optionalString(input, "cwd"));
    }
    case "session.create": {
      return broker.createSession(requireString(input, "cwd"), optionalName(input));
    }
    case "session.open": {
      const cwd = optionalString(input, "cwd");
      const sessionFile = optionalString(input, "sessionFile");
      const sessionId = optionalString(input, "sessionId");
      if (!sessionFile && !sessionId) {
        throw new RuntimeDispatchError(
          "invalid_params",
          "session.open requires sessionFile or sessionId",
        );
      }
      return broker.openSession({
        ...(cwd === undefined ? {} : { cwd }),
        ...(sessionFile === undefined ? {} : { sessionFile }),
        ...(sessionId === undefined ? {} : { sessionId }),
      });
    }
    case "session.close": {
      return broker.closeSession(requireString(input, "sessionId"));
    }
    case "session.snapshot": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "session.snapshot", { sessionId });
    }
    case "session.entries": {
      const sessionId = requireString(input, "sessionId");
      const branchOnly = optionalBoolean(input, "branchOnly");
      return broker.requestForSession(sessionId, "session.entries", {
        ...(branchOnly === undefined ? {} : { branchOnly }),
        sessionId,
      });
    }
    case "session.fork": {
      const sessionId = requireString(input, "sessionId");
      const entryId = requireString(input, "entryId");
      const position = input.position === undefined
        ? undefined
        : requireEnum(input, "position", ["before", "at"] as const);
      return broker.forkSession(sessionId, entryId, position);
    }
    case "session.navigate": {
      const sessionId = requireString(input, "sessionId");
      const summarize = optionalBoolean(input, "summarize");
      return broker.requestForSession(sessionId, "session.navigate", {
        sessionId,
        ...(summarize === undefined ? {} : { summarize }),
        targetId: requireString(input, "targetId"),
      });
    }

    case "agent.prompt":
    case "agent.steer":
    case "agent.followUp": {
      const sessionId = requireString(input, "sessionId");
      const images = optionalImages(input);
      return broker.requestForSession(sessionId, method, {
        ...(images === undefined ? {} : { images }),
        sessionId,
        text: requireString(input, "text", { allowEmpty: true }),
      });
    }
    case "agent.abort": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "agent.abort", { sessionId });
    }

    case "command.list": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "command.list", { sessionId });
    }
    case "command.execute": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "command.execute", {
        command: requireString(input, "command"),
        sessionId,
      });
    }

    case "model.list": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "model.list", {});
    }
    case "model.select": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "model.select", {
        modelId: requireString(input, "modelId"),
        provider: requireString(input, "provider"),
        sessionId,
      });
    }

    case "provider.list": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "provider.list", {});
    }
    case "provider.config.get": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "provider.config.get", {
        providerId: requireString(input, "providerId"),
      });
    }
    case "provider.config.upsert": {
      return requestForRuntimeContext(
        broker,
        requireRuntimeContext(input),
        "provider.config.upsert",
        {
          config: requireProviderConfig(input.config),
          scope: requireEnum(input, "scope", ["user", "project", "custom"] as const),
        },
      );
    }
    case "provider.config.delete": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "provider.config.delete", {
        providerId: requireString(input, "providerId"),
        scope: requireEnum(
          input,
          "scope",
          ["user", "project", "custom", "auth", "all"] as const,
        ),
      });
    }
    case "provider.models.discover": {
      const config = input.config === undefined ? undefined : requireProviderConfig(input.config);
      const requestCredential = optionalBoolean(input, "requestCredential");
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "provider.models.discover", {
        ...(config === undefined ? {} : { config }),
        providerId: requireString(input, "providerId"),
        ...(requestCredential === undefined ? {} : { requestCredential }),
      });
    }
    case "provider.auth.respond": {
      const sessionId = requireString(input, "sessionId");
      const accepted = await broker.respondToProviderAuth(
        sessionId,
        requireProviderAuthResponse(input),
      );
      return { accepted };
    }
    case "provider.login": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "provider.login", {
        providerId: requireString(input, "providerId"),
        type: requireEnum(input, "type", ["api_key", "oauth"] as const),
      });
    }
    case "provider.logout": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "provider.logout", {
        providerId: requireString(input, "providerId"),
      });
    }

    case "package.list": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "package.list", {});
    }
    case "package.install":
    case "package.remove": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), method, {
        source: requireString(input, "source"),
      });
    }
    case "package.update": {
      const source = optionalString(input, "source");
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "package.update", {
        ...(source === undefined ? {} : { source }),
      });
    }

    case "settings.get": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "settings.get", {});
    }
    case "settings.update": {
      if (!("patch" in input)) {
        throw new RuntimeDispatchError("invalid_params", "patch is required");
      }
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "settings.update", {
        patch: input.patch as JsonValue,
      });
    }

    case "extension.ui.respond": {
      const sessionId = requireString(input, "sessionId");
      const accepted = await broker.respondToExtensionUi(
        sessionId,
        requireExtensionResponse(input),
      );
      return { accepted };
    }

    case "recovery.list":
    case "recovery.undo":
    case "recovery.redo": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, method, { sessionId });
    }
    case "recovery.apply": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "recovery.apply", {
        planId: requireString(input, "planId"),
        sessionId,
      });
    }
    case "recovery.checkpoint.create": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "recovery.checkpoint.create", {
        name: requireString(input, "name"),
        sessionId,
      });
    }
    case "recovery.preview": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "recovery.preview", {
        mode: requireEnum(input, "mode", ["conversation", "files", "both"] as const),
        point: requireEnum(input, "point", ["before", "after"] as const),
        sessionId,
        targetId: requireString(input, "targetId"),
        targetKind: requireEnum(input, "targetKind", ["checkpoint", "turn"] as const),
      });
    }
    default:
      return assertNever(method);
  }
}
