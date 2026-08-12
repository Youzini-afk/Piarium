import { resolve } from "node:path";
import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import {
  createErrorResponse,
  createEvent,
  type ExtensionUiResponse,
  type HostCapabilities,
  type HostEvent,
  type HostEventData,
  type ImageAttachment,
  type JsonValue,
  parsePiSessionFeatureMutation,
  parseProviderConfigInput,
  PiSessionFeatureValidationError,
  PIARIUM_PROTOCOL_VERSION,
  type ProviderConfigDeleteScope,
  type ProviderConfigInput,
  ProviderConfigValidationError,
  type ProviderAuthResponse,
  ProtocolDecodeError,
  type RequestEnvelope,
  type RecoveryMode,
  type PiResourceKind,
  type PiResourceScope,
  type PiPackageScope,
  type RuntimeDescriptor,
  THINKING_LEVELS,
  type ThinkingLevel,
  type WireEnvelope,
} from "@piarium/protocol";
import { HostError, toProtocolError } from "./errors.js";
import { expectRecord, readBoolean, readJson, readString } from "./params.js";
import { SessionHost } from "./session-host.js";
import type { HostTransport } from "./transport.js";

export const PIARIUM_HOST_VERSION = "0.1.0";

const HOST_CAPABILITIES: HostCapabilities = {
  agentProviders: true,
  extensionUi: true,
  fleet: true,
  models: true,
  packages: true,
  providerConfiguration: true,
  recovery: true,
  resources: true,
  sessionFeatures: true,
  sessions: true,
  settings: true,
};

const OUT_OF_BAND_METHODS = new Set([
  "agent.abort",
  "extension.ui.respond",
  "provider.auth.respond",
  "project.trust.respond",
]);

export interface HostControllerOptions {
  agentDir?: string;
  projectTrustOverride?: boolean;
  transport: HostTransport;
}

function readImages(record: Record<string, unknown>): ImageAttachment[] | undefined {
  const value = record.images;
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HostError("invalid_params", "images must be an array");
  return value.map((entry, index) => {
    const image = expectRecord(entry, `images[${index}]`);
    return {
      data: readString(image, "data"),
      mimeType: readString(image, "mimeType"),
    };
  });
}

function readRecoveryMode(record: Record<string, unknown>): RecoveryMode {
  const mode = readString(record, "mode");
  if (mode !== "conversation" && mode !== "files" && mode !== "both") {
    throw new HostError("invalid_params", "mode must be conversation, files, or both");
  }
  return mode;
}

function readSessionFeatureMutation(value: unknown) {
  try {
    return parsePiSessionFeatureMutation(value);
  } catch (error) {
    if (error instanceof PiSessionFeatureValidationError) {
      throw new HostError("invalid_params", error.message);
    }
    throw error;
  }
}

function readResourceKind(record: Record<string, unknown>): PiResourceKind {
  const kind = readString(record, "kind");
  if (kind !== "prompt" && kind !== "skill") {
    throw new HostError("invalid_params", "kind must be prompt or skill");
  }
  return kind;
}

function readResourceScope(record: Record<string, unknown>): PiResourceScope {
  const scope = readString(record, "scope");
  if (scope !== "user" && scope !== "project") {
    throw new HostError("invalid_params", "scope must be user or project");
  }
  return scope;
}

function readPackageScope(record: Record<string, unknown>): PiPackageScope {
  const scope = readString(record, "scope");
  if (scope !== "global" && scope !== "project") {
    throw new HostError("invalid_params", "scope must be global or project");
  }
  return scope;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  return readString(record, key, { optional: true });
}

function readStringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HostError("invalid_params", `${key} must be an array of strings`);
  }
  return value as string[];
}

function readProviderConfig(value: unknown): ProviderConfigInput {
  try {
    return parseProviderConfigInput(value);
  } catch (error) {
    if (error instanceof ProviderConfigValidationError) {
      throw new HostError("invalid_params", error.message);
    }
    throw error;
  }
}

function readProviderConfigScope(value: string): "user" | "project" | "custom" {
  if (value !== "user" && value !== "project" && value !== "custom") {
    throw new HostError("invalid_params", "scope must be user, project, or custom");
  }
  return value;
}

function readProviderDeleteScope(value: string): ProviderConfigDeleteScope {
  if (
    value !== "user" &&
    value !== "project" &&
    value !== "custom" &&
    value !== "auth" &&
    value !== "all"
  ) {
    throw new HostError("invalid_params", "scope must be user, project, custom, auth, or all");
  }
  return value;
}

export class HostController {
  readonly #agentDir: string;
  readonly #sessionHost: SessionHost;
  readonly #transport: HostTransport;
  #disposed = false;
  #requestQueue: Promise<void> = Promise.resolve();
  #sequence = 0;
  #started = false;

  constructor(options: HostControllerOptions) {
    this.#agentDir = resolve(options.agentDir ?? getAgentDir());
    this.#transport = options.transport;
    this.#sessionHost = new SessionHost({
      agentDir: this.#agentDir,
      emit: (event, data) => this.emit(event, data),
      ...(options.projectTrustOverride === undefined
        ? {}
        : { projectTrustOverride: options.projectTrustOverride }),
    });
  }

  get runtimeDescriptor(): RuntimeDescriptor {
    return {
      agentDir: this.#agentDir,
      nodePath: process.execPath,
      nodeVersion: process.versions.node,
      piVersion: VERSION,
      source: "bundled",
    };
  }

  start(): void {
    if (this.#started) throw new Error("Host controller is already started");
    if (this.#disposed) throw new Error("Host controller is disposed");
    this.#started = true;
    this.#transport.start(
      (envelope) => {
        if (envelope.kind === "request" && OUT_OF_BAND_METHODS.has(envelope.method)) {
          void this.#handleEnvelope(envelope).catch((error) => this.#handleFatalError(error));
          return;
        }
        this.#requestQueue = this.#requestQueue
          .then(() => this.#handleEnvelope(envelope))
          .catch((error) => this.#handleFatalError(error));
      },
      () => {
        void this.#dispose(false).catch((error) => {
          process.stderr.write(
            `Piarium host disposal failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
      },
      (error) => {
        this.emit(
          "host.error",
          error instanceof ProtocolDecodeError
            ? { code: error.code, message: error.message }
            : toProtocolError(error),
        );
        void this.#dispose(true).catch((disposeError) => {
          process.stderr.write(
            `Piarium host disposal failed: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}\n`,
          );
        });
      },
    );
    this.emit("host.ready", { runtime: this.runtimeDescriptor });
  }

  emit<E extends HostEvent>(event: E, data: HostEventData<E>): void {
    if (this.#disposed) return;
    this.#transport.send(createEvent(this.#sequence++, event, data));
  }

  async dispose(): Promise<void> {
    await this.#dispose(true);
  }

  async #handleEnvelope(envelope: WireEnvelope): Promise<void> {
    if (this.#disposed) return;
    if (envelope.kind !== "request") {
      this.emit("host.error", {
        code: "unexpected_envelope",
        message: `Client sent an unexpected ${envelope.kind} envelope`,
      });
      return;
    }
    let shutdownAfterResponse = false;
    try {
      const result = await this.#dispatch(envelope);
      this.#transport.send({
        id: envelope.id,
        kind: "response",
        ok: true,
        result,
        v: PIARIUM_PROTOCOL_VERSION,
      } as WireEnvelope);
      shutdownAfterResponse = envelope.method === "host.shutdown";
    } catch (error) {
      this.#transport.send(createErrorResponse(envelope.id, toProtocolError(error)));
    }
    if (shutdownAfterResponse) await this.dispose();
  }

  async #handleFatalError(error: unknown): Promise<void> {
    if (this.#disposed) return;
    try {
      this.emit("host.error", toProtocolError(error));
    } catch {
      // The transport itself failed; disposal below is the only safe recovery.
    }
    try {
      await this.#dispose(true);
    } catch (disposeError) {
      process.stderr.write(
        `Piarium host disposal failed: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}\n`,
      );
    }
  }

  async #dispatch(request: RequestEnvelope): Promise<unknown> {
    const params = expectRecord(request.params);
    const methodName: string = request.method;
    switch (request.method) {
      case "host.handshake": {
        const versions = params.protocolVersions;
        if (
          !Array.isArray(versions) ||
          versions.some((version) => !Number.isSafeInteger(version))
        ) {
          throw new HostError("invalid_params", "protocolVersions must be an array of integers");
        }
        readString(params, "clientName");
        readString(params, "clientVersion");
        readString(params, "mode");
        if (!versions.includes(PIARIUM_PROTOCOL_VERSION)) {
          throw new HostError(
            "unsupported_version",
            `Client does not support Piarium protocol v${PIARIUM_PROTOCOL_VERSION}`,
          );
        }
        return {
          capabilities: HOST_CAPABILITIES,
          hostVersion: PIARIUM_HOST_VERSION,
          protocolVersion: PIARIUM_PROTOCOL_VERSION,
          runtime: this.runtimeDescriptor,
        };
      }
      case "host.shutdown":
        readBoolean(params, "force", { optional: true });
        return { accepted: true };
      case "catalog.context.open":
        return this.#sessionHost.openCatalogContext(readString(params, "cwd"));
      case "session.create":
        return this.#sessionHost.create(
          readString(params, "cwd"),
          optionalString(params, "name"),
          optionalString(params, "parentSession"),
        );
      case "session.open": {
        const cwd = optionalString(params, "cwd");
        const sessionFile = optionalString(params, "sessionFile");
        const sessionId = optionalString(params, "sessionId");
        return this.#sessionHost.open({
          ...(cwd === undefined ? {} : { cwd }),
          ...(sessionFile === undefined ? {} : { sessionFile }),
          ...(sessionId === undefined ? {} : { sessionId }),
        });
      }
      case "session.close":
        return { closed: await this.#sessionHost.close(readString(params, "sessionId")) };
      case "session.list":
        return this.#sessionHost.list(optionalString(params, "cwd"));
      case "session.snapshot":
        this.#sessionHost.assertSession(readString(params, "sessionId"));
        return this.#sessionHost.snapshot();
      case "session.entries":
        {
          const scope = optionalString(params, "scope") ?? "branch";
          if (scope !== "branch" && scope !== "all") {
            throw new HostError("invalid_params", "scope must be 'branch' or 'all'");
          }
          return this.#sessionHost.entries(readString(params, "sessionId"), scope);
        }
      case "session.features.get":
        return this.#sessionHost.features(readString(params, "sessionId"));
      case "session.features.mutate":
        return this.#sessionHost.mutateFeatures(
          readString(params, "sessionId"),
          readSessionFeatureMutation(params.mutation),
        );
      case "session.entry":
        return this.#sessionHost.entry(
          readString(params, "sessionId"),
          readString(params, "entryId"),
        );
      case "session.header":
        return this.#sessionHost.header(readString(params, "sessionId"));
      case "session.tree":
        return this.#sessionHost.tree(readString(params, "sessionId"));
      case "session.stats":
        return this.#sessionHost.stats(readString(params, "sessionId"));
      case "session.summary":
        return this.#sessionHost.summary(readString(params, "sessionId"));
      case "session.rename":
        return this.#sessionHost.rename(
          readString(params, "sessionId"),
          readString(params, "name", { allowEmpty: true }),
          optionalString(params, "sessionFile"),
        );
      case "session.fork": {
        const position = optionalString(params, "position") ?? "before";
        if (position !== "before" && position !== "at") {
          throw new HostError("invalid_params", "position must be 'before' or 'at'");
        }
        return this.#sessionHost.fork(
          readString(params, "sessionId"),
          readString(params, "entryId"),
          position,
        );
      }
      case "session.navigate":
        return this.#sessionHost.navigate(
          readString(params, "sessionId"),
          readString(params, "targetId"),
          readBoolean(params, "summarize", { defaultValue: false }),
        );
      case "agent.prompt":
        return this.#sessionHost.prompt(
          readString(params, "sessionId"),
          readString(params, "text", { allowEmpty: true }),
          readImages(params),
          optionalString(params, "instructions"),
        );
      case "agent.steer":
        return {
          accepted: await this.#sessionHost.steer(
            readString(params, "sessionId"),
            readString(params, "text", { allowEmpty: true }),
            readImages(params),
            optionalString(params, "instructions"),
          ),
        };
      case "agent.followUp":
        return {
          accepted: await this.#sessionHost.followUp(
            readString(params, "sessionId"),
            readString(params, "text", { allowEmpty: true }),
            readImages(params),
            optionalString(params, "instructions"),
          ),
        };
      case "agent.abort":
        return { aborted: await this.#sessionHost.abort(readString(params, "sessionId")) };
      case "agentProvider.list":
        return this.#sessionHost.listAgentProviders();
      case "agentProvider.action":
        return this.#sessionHost.runAgentProviderAction(
          readString(params, "providerId"),
          readString(params, "action"),
          optionalString(params, "agentId"),
          readJson(params, "input"),
        );
      case "command.list":
        return this.#sessionHost.listCommands(readString(params, "sessionId"));
      case "command.execute":
        return this.#sessionHost.executeCommand(
          readString(params, "sessionId"),
          readString(params, "command"),
        );
      case "fleet.status":
        return this.#sessionHost.fleetStatus(readString(params, "sessionId"));
      case "model.list":
        return this.#sessionHost.listModels();
      case "mcp.config.snapshot":
        return this.#sessionHost.mcpConfigSnapshot();
      case "model.select":
        return this.#sessionHost.selectModel(
          readString(params, "sessionId"),
          readString(params, "provider"),
          readString(params, "modelId"),
        );
      case "thinking.select": {
        const level = readString(params, "level");
        if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
          throw new HostError(
            "invalid_params",
            `level must be one of: ${THINKING_LEVELS.join(", ")}`,
          );
        }
        return this.#sessionHost.selectThinkingLevel(
          readString(params, "sessionId"),
          level as ThinkingLevel,
        );
      }
      case "provider.list":
        return this.#sessionHost.listProviders();
      case "provider.config.get":
        return this.#sessionHost.getProviderConfiguration(readString(params, "providerId"));
      case "provider.config.upsert":
        return this.#sessionHost.upsertProviderConfiguration(
          readProviderConfigScope(readString(params, "scope")),
          readProviderConfig(params.config),
        );
      case "provider.config.delete":
        return this.#sessionHost.deleteProviderConfiguration(
          readString(params, "providerId"),
          readProviderDeleteScope(readString(params, "scope")),
        );
      case "provider.models.discover":
        return this.#sessionHost.discoverProviderModels(
          readString(params, "providerId"),
          params.config === undefined ? undefined : readProviderConfig(params.config),
          readBoolean(params, "requestCredential", { optional: true }) ?? false,
        );
      case "provider.auth.respond": {
        const cancelled = readBoolean(params, "cancelled", { optional: true });
        if (params.value !== undefined && typeof params.value !== "string") {
          throw new HostError("invalid_params", "value must be a string");
        }
        const response: ProviderAuthResponse = {
          requestId: readString(params, "requestId"),
          ...(cancelled === undefined ? {} : { cancelled }),
          ...(params.value === undefined ? {} : { value: params.value }),
        };
        return { accepted: this.#sessionHost.auth.respond(response) };
      }
      case "provider.login": {
        const type = readString(params, "type");
        if (type !== "api_key" && type !== "oauth") {
          throw new HostError("invalid_params", "type must be 'api_key' or 'oauth'");
        }
        return {
          authenticated: await this.#sessionHost.loginProvider(
            readString(params, "providerId"),
            type,
          ),
        };
      }
      case "provider.logout":
        await this.#sessionHost.logoutProvider(readString(params, "providerId"));
        return { authenticated: false };
      case "resource.list":
        return this.#sessionHost.listResources(readResourceKind(params));
      case "resource.get":
        return this.#sessionHost.getResource(
          readResourceKind(params),
          readString(params, "id"),
        );
      case "resource.create":
        return this.#sessionHost.createResource(
          readResourceKind(params),
          readResourceScope(params),
          readString(params, "name"),
          readString(params, "content", { allowEmpty: true }),
        );
      case "resource.update":
        return this.#sessionHost.updateResource(
          readResourceKind(params),
          readString(params, "id"),
          readString(params, "content", { allowEmpty: true }),
          readString(params, "expectedRevision"),
        );
      case "resource.delete":
        return this.#sessionHost.deleteResource(
          readResourceKind(params),
          readString(params, "id"),
          readString(params, "expectedRevision"),
        );
      case "resource.copy":
        return this.#sessionHost.copyResource(
          readResourceKind(params),
          readString(params, "id"),
          readResourceScope(params),
          optionalString(params, "name"),
        );
      case "recovery.status":
        return this.#sessionHost.recoveryStatus(readString(params, "sessionId"));
      case "recovery.navigate":
        return this.#sessionHost.navigateRecovery(
          readString(params, "sessionId"),
          readString(params, "targetId"),
          readRecoveryMode(params),
          readBoolean(params, "summarize", { optional: true }),
        );
      case "recovery.undo":
        return this.#sessionHost.undoRecovery(
          readString(params, "sessionId"),
          readRecoveryMode(params),
        );
      case "recovery.redo":
        return this.#sessionHost.redoRecovery(
          readString(params, "sessionId"),
          readRecoveryMode(params),
        );
      case "recovery.checkpoint.create":
        return this.#sessionHost.createRecoveryCheckpoint(
          readString(params, "sessionId"),
          readString(params, "name"),
        );
      case "recovery.repair": {
        const action = readString(params, "action");
        if (
          action !== "recover" &&
          action !== "recover-typo" &&
          action !== "recover-destructive"
        ) {
          throw new HostError("invalid_params", "Unknown recovery repair action");
        }
        return this.#sessionHost.repairRecovery(readString(params, "sessionId"), action);
      }
      case "config.document.get": {
        const scope = readString(params, "scope");
        if (scope !== "global" && scope !== "project") {
          throw new HostError("invalid_params", "Unknown configuration scope");
        }
        return this.#sessionHost.getConfigDocument(scope, readString(params, "path"));
      }
      case "config.document.update": {
        const scope = readString(params, "scope");
        if (scope !== "global" && scope !== "project") {
          throw new HostError("invalid_params", "Unknown configuration scope");
        }
        return this.#sessionHost.updateConfigDocument(
          scope,
          readString(params, "path"),
          readJson(params, "set") ?? null,
          readStringList(params, "remove"),
        );
      }
      case "config.text.get": {
        const root = readString(params, "root");
        const format = readString(params, "format");
        if (root !== "agent" && root !== "home" && root !== "project" && root !== "user-config") {
          throw new HostError("invalid_params", "Unknown configuration root");
        }
        if (format !== "json" && format !== "jsonc") {
          throw new HostError("invalid_params", "Unknown configuration format");
        }
        return this.#sessionHost.getConfigTextDocument(
          root,
          format,
          readString(params, "path"),
        );
      }
      case "config.text.update": {
        const root = readString(params, "root");
        const format = readString(params, "format");
        if (root !== "agent" && root !== "home" && root !== "project" && root !== "user-config") {
          throw new HostError("invalid_params", "Unknown configuration root");
        }
        if (format !== "json" && format !== "jsonc") {
          throw new HostError("invalid_params", "Unknown configuration format");
        }
        return this.#sessionHost.updateConfigTextDocument(
          root,
          format,
          readString(params, "path"),
          readString(params, "content", { allowEmpty: true }),
          readString(params, "expectedRevision"),
        );
      }
      case "settings.get":
        return this.#sessionHost.getSettings();
      case "settings.update": {
        const scope = readString(params, "scope");
        if (scope !== "global" && scope !== "project") {
          throw new HostError("invalid_params", "Unknown settings scope");
        }
        return this.#sessionHost.updateSettings(
          scope,
          readJson(params, "set") ?? null,
          readStringList(params, "remove"),
        );
      }
      case "package.list":
        return this.#sessionHost.listPackages();
      case "package.install":
        return this.#sessionHost.installPackage(
          readString(params, "source"),
          readPackageScope(params),
        );
      case "package.remove":
        return {
          removed: await this.#sessionHost.removePackage(
            readString(params, "source"),
            readPackageScope(params),
          ),
        };
      case "package.setEnabled":
        return this.#sessionHost.setPackageEnabled(
          readString(params, "source"),
          readPackageScope(params),
          readBoolean(params, "enabled"),
        );
      case "package.update":
        return this.#sessionHost.updatePackages(optionalString(params, "source"));
      case "extension.ui.respond": {
        const cancelled = readBoolean(params, "cancelled", { optional: true });
        const response: ExtensionUiResponse = {
          requestId: readString(params, "requestId"),
          ...(cancelled === undefined ? {} : { cancelled }),
          ...(params.value === undefined ? {} : { value: params.value as JsonValue }),
        };
        return { accepted: this.#sessionHost.ui.respond(response) };
      }
      case "project.trust.respond":
        return {
          accepted: this.#sessionHost.trust.respond({
            remember: readBoolean(params, "remember"),
            requestId: readString(params, "requestId"),
            trusted: readBoolean(params, "trusted"),
          }),
        };
      default:
        throw new HostError("method_not_found", `Unknown host method: ${methodName}`);
    }
  }

  async #dispose(closeTransport: boolean): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#sessionHost.dispose();
    if (closeTransport) this.#transport.close();
  }
}
