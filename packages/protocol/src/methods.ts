import type {
  ExtensionUiResponse,
  HostHandshakeParams,
  HostHandshakeResult,
  JsonValue,
  ModelDescriptor,
  PackageDescriptor,
  SessionSnapshot,
  SessionSummary,
} from "./types.js";

export interface HostMethodMap {
  "agent.abort": {
    params: { sessionId: string };
    result: { aborted: boolean };
  };
  "agent.followUp": {
    params: { images?: string[]; sessionId: string; text: string };
    result: { accepted: boolean };
  };
  "agent.prompt": {
    params: { images?: string[]; sessionId: string; text: string };
    result: { accepted: boolean };
  };
  "agent.steer": {
    params: { images?: string[]; sessionId: string; text: string };
    result: { accepted: boolean };
  };
  "command.execute": {
    params: { command: string; sessionId: string };
    result: JsonValue;
  };
  "command.list": {
    params: { sessionId: string };
    result: Array<{ description?: string; name: string; source?: string }>;
  };
  "extension.ui.respond": {
    params: ExtensionUiResponse;
    result: { accepted: boolean };
  };
  "host.handshake": {
    params: HostHandshakeParams;
    result: HostHandshakeResult;
  };
  "host.shutdown": {
    params: { force?: boolean };
    result: { accepted: boolean };
  };
  "model.list": {
    params: Record<string, never>;
    result: ModelDescriptor[];
  };
  "model.select": {
    params: { modelId: string; provider: string; sessionId: string };
    result: SessionSnapshot;
  };
  "package.install": {
    params: { source: string };
    result: PackageDescriptor;
  };
  "package.list": {
    params: Record<string, never>;
    result: PackageDescriptor[];
  };
  "package.remove": {
    params: { source: string };
    result: { removed: boolean };
  };
  "package.update": {
    params: { source?: string };
    result: PackageDescriptor[];
  };
  "session.close": {
    params: { sessionId: string };
    result: { closed: boolean };
  };
  "session.create": {
    params: { cwd: string; name?: string };
    result: SessionSnapshot;
  };
  "session.list": {
    params: { cwd?: string };
    result: SessionSummary[];
  };
  "session.open": {
    params: { cwd?: string; sessionFile?: string; sessionId?: string };
    result: SessionSnapshot;
  };
  "session.snapshot": {
    params: { sessionId: string };
    result: SessionSnapshot;
  };
  "settings.get": {
    params: Record<string, never>;
    result: JsonValue;
  };
  "settings.update": {
    params: { patch: JsonValue };
    result: JsonValue;
  };
}

export type HostMethod = keyof HostMethodMap;

export type HostMethodParams<M extends HostMethod> = HostMethodMap[M]["params"];

export type HostMethodResult<M extends HostMethod> = HostMethodMap[M]["result"];
