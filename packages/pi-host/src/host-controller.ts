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
  PIARIUM_PROTOCOL_VERSION,
  ProtocolDecodeError,
  type RequestEnvelope,
  type RuntimeDescriptor,
  type WireEnvelope,
} from "@piarium/protocol";
import { HostError, toProtocolError } from "./errors.js";
import { expectRecord, readBoolean, readJson, readString } from "./params.js";
import { SessionHost } from "./session-host.js";
import type { HostTransport } from "./transport.js";

export const PIARIUM_HOST_VERSION = "0.1.0";

const HOST_CAPABILITIES: HostCapabilities = {
  extensionUi: true,
  models: true,
  packages: true,
  recovery: false,
  sessions: true,
  settings: true,
};

const OUT_OF_BAND_METHODS = new Set([
  "agent.abort",
  "extension.ui.respond",
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

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  return readString(record, key, { optional: true });
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
          throw new HostError("unsupported_version", "Client does not support Piarium protocol v1");
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
      case "session.create":
        return this.#sessionHost.create(readString(params, "cwd"), optionalString(params, "name"));
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
        return this.#sessionHost.entries(
          readString(params, "sessionId"),
          readBoolean(params, "branchOnly", { defaultValue: true }),
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
          readString(params, "text"),
          readImages(params),
        );
      case "agent.steer":
        return {
          accepted: await this.#sessionHost.steer(
            readString(params, "sessionId"),
            readString(params, "text"),
            readImages(params),
          ),
        };
      case "agent.followUp":
        return {
          accepted: await this.#sessionHost.followUp(
            readString(params, "sessionId"),
            readString(params, "text"),
            readImages(params),
          ),
        };
      case "agent.abort":
        return { aborted: await this.#sessionHost.abort(readString(params, "sessionId")) };
      case "command.list":
        return this.#sessionHost.listCommands(readString(params, "sessionId"));
      case "command.execute":
        return this.#sessionHost.executeCommand(
          readString(params, "sessionId"),
          readString(params, "command"),
        );
      case "model.list":
        return this.#sessionHost.listModels();
      case "model.select":
        return this.#sessionHost.selectModel(
          readString(params, "sessionId"),
          readString(params, "provider"),
          readString(params, "modelId"),
        );
      case "provider.list":
        return this.#sessionHost.listProviders();
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
      case "settings.get":
        return this.#sessionHost.getSettings();
      case "settings.update":
        return this.#sessionHost.updateSettings(readJson(params, "patch") ?? null);
      case "package.list":
        return this.#sessionHost.listPackages();
      case "package.install":
        return this.#sessionHost.installPackage(readString(params, "source"));
      case "package.remove":
        return { removed: await this.#sessionHost.removePackage(readString(params, "source")) };
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
