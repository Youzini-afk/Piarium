import {
  PIARIUM_PROTOCOL_VERSION,
  type ExtensionUiResponse,
  type HostMode,
  type HostMethodParams,
  type HostMethodResult,
  type ImageAttachment,
  type JsonValue,
  parsePiSessionFeatureMutation,
  parseProviderConfigInput,
  PiSessionFeatureValidationError,
  type ProviderConfigInput,
  ProviderConfigValidationError,
  type ProviderAuthResponse,
  type PiConfigTextAuthorityId,
  type PiConfigWatchTarget,
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

export interface RuntimeDispatchContext {
  active: boolean;
  configWatchIds: Set<string>;
}

export function createRuntimeDispatchContext(): RuntimeDispatchContext {
  return { active: true, configWatchIds: new Set() };
}

export function disposeRuntimeDispatchContext(
  broker: PiRuntimeBroker,
  context: RuntimeDispatchContext,
): void {
  if (!context.active) return;
  context.active = false;
  const watchIds = [...context.configWatchIds];
  context.configWatchIds.clear();
  void Promise.allSettled(watchIds.map((watchId) => broker.unwatchConfig(watchId)));
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

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = optionalBoolean(record, key);
  if (value === undefined) {
    throw new RuntimeDispatchError("invalid_params", `${key} must be a boolean`);
  }
  return value;
}

function requireStringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new RuntimeDispatchError("invalid_params", `${key} must be an array of strings`);
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

function requireSessionFeatureMutation(value: unknown) {
  try {
    return parsePiSessionFeatureMutation(value);
  } catch (error) {
    if (error instanceof PiSessionFeatureValidationError) {
      throw new RuntimeDispatchError("invalid_params", error.message);
    }
    throw error;
  }
}

function requireConfigTextAuthority(
  record: Record<string, unknown>,
): PiConfigTextAuthorityId {
  return requireEnum(
    record,
    "authority",
    ["aft-user", "pi-lens-global", "pi-lens-project"] as const,
  );
}

function requireConfigWatchTarget(value: unknown): PiConfigWatchTarget {
  const target = requireRecord(value);
  const kind = requireEnum(
    target,
    "kind",
    ["document", "text", "text-authority", "settings"] as const,
  );
  if (kind === "document") {
    return {
      kind,
      path: requireString(target, "path"),
      scope: requireEnum(target, "scope", ["global", "project"] as const),
    };
  }
  if (kind === "text") {
    return {
      format: requireEnum(target, "format", ["json", "jsonc"] as const),
      kind,
      path: requireString(target, "path"),
      root: requireEnum(target, "root", ["agent", "home", "project", "user-config"] as const),
    };
  }
  if (kind === "text-authority") {
    return { authority: requireConfigTextAuthority(target), kind };
  }
  return {
    kind,
    scope: requireEnum(target, "scope", ["global", "project"] as const),
  };
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
  context?: RuntimeDispatchContext,
): Promise<RuntimeMethodResult<M>> {
  const result = await dispatchRuntimeRequestUnchecked(broker, method, params, context);
  return result as RuntimeMethodResult<M>;
}

async function dispatchRuntimeRequestUnchecked(
  broker: PiRuntimeBroker,
  method: RuntimeMethod,
  params: unknown,
  context?: RuntimeDispatchContext,
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
      return broker.createSession(
        requireString(input, "cwd"),
        optionalName(input),
        optionalString(input, "parentSession"),
      );
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
    case "session.archive": {
      return broker.archiveSession(requireString(input, "sessionId"), true);
    }
    case "session.unarchive": {
      return broker.archiveSession(requireString(input, "sessionId"), false);
    }
    case "session.delete": {
      return broker.deleteSession(requireString(input, "sessionId"));
    }
    case "session.snapshot": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "session.snapshot", { sessionId });
    }
    case "session.entries": {
      const sessionId = requireString(input, "sessionId");
      const scope =
        input.scope === undefined
          ? undefined
          : requireEnum(input, "scope", ["branch", "all"] as const);
      return broker.requestForSession(sessionId, "session.entries", {
        ...(scope === undefined ? {} : { scope }),
        sessionId,
      });
    }
    case "session.features.get": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "session.features.get", { sessionId });
    }
    case "session.features.mutate": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "session.features.mutate", {
        mutation: requireSessionFeatureMutation(input.mutation),
        sessionId,
      });
    }
    case "session.entry": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "session.entry", {
        entryId: requireString(input, "entryId"),
        sessionId,
      });
    }
    case "session.header": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "session.header", { sessionId });
    }
    case "session.tree": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "session.tree", { sessionId });
    }
    case "session.stats": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "session.stats", { sessionId });
    }
    case "session.summary": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "session.summary", { sessionId });
    }
    case "session.rename": {
      return broker.renameSession(
        requireString(input, "sessionId"),
        requireString(input, "name", { allowEmpty: true }),
      );
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
      const instructions = optionalString(input, "instructions");
      return broker.requestForSession(sessionId, method, {
        ...(images === undefined ? {} : { images }),
        ...(instructions === undefined ? {} : { instructions }),
        sessionId,
        text: requireString(input, "text", { allowEmpty: true }),
      });
    }
    case "agent.abort": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "agent.abort", { sessionId });
    }

    case "agentProvider.list": {
      return requestForRuntimeContext(
        broker,
        requireRuntimeContext(input),
        "agentProvider.list",
        {},
      );
    }
    case "agentProvider.action": {
      const agentId = optionalString(input, "agentId");
      return requestForRuntimeContext(
        broker,
        requireRuntimeContext(input),
        "agentProvider.action",
        {
          action: requireString(input, "action"),
          ...(agentId === undefined ? {} : { agentId }),
          ...(input.input === undefined ? {} : { input: input.input as JsonValue }),
          providerId: requireString(input, "providerId"),
        },
      );
    }

    case "command.list": {
      const target = requireRuntimeContext(input);
      return "sessionId" in target
        ? broker.requestForSession(target.sessionId, "command.list", { sessionId: target.sessionId })
        : broker.listCommandsForWorkspace(target.cwd);
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
    case "mcp.config.snapshot": {
      return requestForRuntimeContext(
        broker,
        requireRuntimeContext(input),
        "mcp.config.snapshot",
        {},
      );
    }
    case "model.select": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "model.select", {
        modelId: requireString(input, "modelId"),
        provider: requireString(input, "provider"),
        sessionId,
      });
    }
    case "thinking.select": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "thinking.select", {
        level: requireEnum(input, "level", [
          "off",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ] as const),
        sessionId,
      });
    }

    case "project.trust.respond": {
      const accepted = await broker.respondToProjectTrust(
        requireString(input, "workerId"),
        requireString(input, "requestId"),
        {
          remember: requireBoolean(input, "remember"),
          trusted: requireBoolean(input, "trusted"),
        },
      );
      return { accepted };
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

    case "resource.list": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "resource.list", {
        kind: requireEnum(input, "kind", ["prompt", "skill"] as const),
      });
    }
    case "resource.get": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "resource.get", {
        id: requireString(input, "id"),
        kind: requireEnum(input, "kind", ["prompt", "skill"] as const),
      });
    }
    case "resource.create": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "resource.create", {
        content: requireString(input, "content", { allowEmpty: true }),
        kind: requireEnum(input, "kind", ["prompt", "skill"] as const),
        name: requireString(input, "name"),
        scope: requireEnum(input, "scope", ["user", "project"] as const),
      });
    }
    case "resource.update": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "resource.update", {
        content: requireString(input, "content", { allowEmpty: true }),
        expectedRevision: requireString(input, "expectedRevision"),
        id: requireString(input, "id"),
        kind: requireEnum(input, "kind", ["prompt", "skill"] as const),
      });
    }
    case "resource.delete": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "resource.delete", {
        expectedRevision: requireString(input, "expectedRevision"),
        id: requireString(input, "id"),
        kind: requireEnum(input, "kind", ["prompt", "skill"] as const),
      });
    }
    case "resource.copy": {
      const name = optionalString(input, "name");
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "resource.copy", {
        id: requireString(input, "id"),
        kind: requireEnum(input, "kind", ["prompt", "skill"] as const),
        ...(name === undefined ? {} : { name }),
        scope: requireEnum(input, "scope", ["user", "project"] as const),
      });
    }

    case "package.list": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "package.list", {});
    }
    case "package.install":
    case "package.remove": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), method, {
        scope: requireEnum(input, "scope", ["global", "project"] as const),
        source: requireString(input, "source"),
      });
    }
    case "package.setEnabled": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), method, {
        enabled: requireBoolean(input, "enabled"),
        scope: requireEnum(input, "scope", ["global", "project"] as const),
        source: requireString(input, "source"),
      });
    }
    case "package.update": {
      const source = optionalString(input, "source");
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "package.update", {
        ...(source === undefined ? {} : { source }),
      });
    }

    case "config.document.get": {
      return requestForRuntimeContext(
        broker,
        requireRuntimeContext(input),
        "config.document.get",
        {
          path: requireString(input, "path"),
          scope: requireEnum(input, "scope", ["global", "project"] as const),
        },
      );
    }
    case "config.document.update": {
      if (!("set" in input)) {
        throw new RuntimeDispatchError("invalid_params", "set is required");
      }
      return requestForRuntimeContext(
        broker,
        requireRuntimeContext(input),
        "config.document.update",
        {
          expectedRevision: requireString(input, "expectedRevision"),
          path: requireString(input, "path"),
          remove: requireStringList(input, "remove"),
          scope: requireEnum(input, "scope", ["global", "project"] as const),
          set: requireRecord(input.set) as { [key: string]: JsonValue },
        },
      );
    }
    case "config.text.get": {
      return requestForRuntimeContext(
        broker,
        requireRuntimeContext(input),
        "config.text.get",
        {
          format: requireEnum(input, "format", ["json", "jsonc"] as const),
          path: requireString(input, "path"),
          root: requireEnum(input, "root", ["agent", "home", "project", "user-config"] as const),
        },
      );
    }
    case "config.text.authority.get": {
      return requestForRuntimeContext(
        broker,
        requireRuntimeContext(input),
        "config.text.authority.get",
        { authority: requireConfigTextAuthority(input) },
      );
    }
    case "config.text.authority.update": {
      return requestForRuntimeContext(
        broker,
        requireRuntimeContext(input),
        "config.text.authority.update",
        {
          authority: requireConfigTextAuthority(input),
          content: requireString(input, "content", { allowEmpty: true }),
          expectedRevision: requireString(input, "expectedRevision"),
        },
      );
    }
    case "config.text.update": {
      return requestForRuntimeContext(
        broker,
        requireRuntimeContext(input),
        "config.text.update",
        {
          content: requireString(input, "content", { allowEmpty: true }),
          expectedRevision: requireString(input, "expectedRevision"),
          format: requireEnum(input, "format", ["json", "jsonc"] as const),
          path: requireString(input, "path"),
          root: requireEnum(input, "root", ["agent", "home", "project", "user-config"] as const),
        },
      );
    }
    case "config.watch": {
      if (!context) {
        throw new RuntimeDispatchError(
          "persistent_connection_required",
          "Configuration watches require a persistent runtime connection",
        );
      }
      const subscription = await broker.watchConfig(
        requireRuntimeContext(input),
        requireConfigWatchTarget(input.target),
      );
      if (context && !context.active) {
        await broker.unwatchConfig(subscription.watchId);
        throw new RuntimeDispatchError(
          "runtime_connection_closed",
          "Runtime connection closed while creating the configuration watch",
        );
      }
      context.configWatchIds.add(subscription.watchId);
      return subscription;
    }
    case "config.unwatch": {
      if (!context) {
        throw new RuntimeDispatchError(
          "persistent_connection_required",
          "Configuration watches require a persistent runtime connection",
        );
      }
      const watchId = requireString(input, "watchId");
      if (!context.configWatchIds.delete(watchId)) {
        throw new RuntimeDispatchError(
          "config_watch_not_owned",
          "Configuration watch does not belong to this runtime connection",
        );
      }
      return broker.unwatchConfig(watchId);
    }

    case "settings.get": {
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "settings.get", {});
    }
    case "settings.update": {
      if (!("set" in input)) {
        throw new RuntimeDispatchError("invalid_params", "set is required");
      }
      return requestForRuntimeContext(broker, requireRuntimeContext(input), "settings.update", {
        expectedRevision: requireString(input, "expectedRevision"),
        remove: requireStringList(input, "remove"),
        scope: requireEnum(input, "scope", ["global", "project"] as const),
        set: requireRecord(input.set) as { [key: string]: JsonValue },
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

    case "fleet.status": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "fleet.status", { sessionId });
    }

    case "recovery.status": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, method, { sessionId });
    }
    case "recovery.undo":
    case "recovery.redo": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, method, {
        mode: requireEnum(input, "mode", ["conversation", "files", "both"] as const),
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
    case "recovery.navigate": {
      const sessionId = requireString(input, "sessionId");
      const summarize = optionalBoolean(input, "summarize");
      return broker.requestForSession(sessionId, "recovery.navigate", {
        mode: requireEnum(input, "mode", ["conversation", "files", "both"] as const),
        sessionId,
        targetId: requireString(input, "targetId"),
        ...(summarize === undefined ? {} : { summarize }),
      });
    }
    case "recovery.repair": {
      const sessionId = requireString(input, "sessionId");
      return broker.requestForSession(sessionId, "recovery.repair", {
        action: requireEnum(input, "action", [
          "recover",
          "recover-typo",
          "recover-destructive",
        ] as const),
        sessionId,
      });
    }
    default:
      return assertNever(method);
  }
}
