import type {
  ExtensionUiResponse,
  HostHandshakeParams,
  HostHandshakeResult,
  ImageAttachment,
  JsonValue,
  ModelDescriptor,
  PackageDescriptor,
  ProviderAuthType,
  RecoveryApplyResult,
  RecoveryCheckpoint,
  RecoveryListResult,
  RecoveryMode,
  RecoveryPoint,
  RecoveryPreview,
  SessionSnapshot,
  SessionSummary,
} from "./types.js";
import type { ProviderAuthResponse, ProviderDescriptor } from "./auth.js";
import type {
  ProviderConfigDeleteScope,
  ProviderConfigDetails,
  ProviderConfigInput,
  ProviderConfigScope,
  ProviderModelDiscoveryResult,
} from "./provider.js";
import type { SessionEntriesResult } from "./session.js";

export interface HostMethodMap {
  "catalog.context.open": {
    params: { cwd: string };
    result: SessionSnapshot;
  };
  "agent.abort": {
    params: { sessionId: string };
    result: { aborted: boolean };
  };
  "agent.followUp": {
    params: { images?: ImageAttachment[]; sessionId: string; text: string };
    result: { accepted: boolean };
  };
  "agent.prompt": {
    params: { images?: ImageAttachment[]; sessionId: string; text: string };
    result: { accepted: boolean };
  };
  "agent.steer": {
    params: { images?: ImageAttachment[]; sessionId: string; text: string };
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
  "project.trust.respond": {
    params: { remember: boolean; requestId: string; trusted: boolean };
    result: { accepted: boolean };
  };
  "provider.list": {
    params: Record<string, never>;
    result: ProviderDescriptor[];
  };
  "provider.config.delete": {
    params: { providerId: string; scope: ProviderConfigDeleteScope };
    result: ProviderConfigDetails;
  };
  "provider.config.get": {
    params: { providerId: string };
    result: ProviderConfigDetails;
  };
  "provider.config.upsert": {
    params: { config: ProviderConfigInput; scope: ProviderConfigScope };
    result: ProviderConfigDetails;
  };
  "provider.models.discover": {
    params: {
      config?: ProviderConfigInput;
      providerId: string;
      requestCredential?: boolean;
    };
    result: ProviderModelDiscoveryResult;
  };
  "provider.auth.respond": {
    params: ProviderAuthResponse;
    result: { accepted: boolean };
  };
  "provider.login": {
    params: { providerId: string; type: ProviderAuthType };
    result: { authenticated: boolean };
  };
  "provider.logout": {
    params: { providerId: string };
    result: { authenticated: false };
  };
  "recovery.apply": {
    params: { planId: string; sessionId: string };
    result: RecoveryApplyResult;
  };
  "recovery.checkpoint.create": {
    params: { name: string; sessionId: string };
    result: RecoveryCheckpoint;
  };
  "recovery.list": {
    params: { sessionId: string };
    result: RecoveryListResult;
  };
  "recovery.preview": {
    params: {
      mode: RecoveryMode;
      point: RecoveryPoint;
      sessionId: string;
      targetId: string;
      targetKind: "checkpoint" | "turn";
    };
    result: RecoveryPreview;
  };
  "recovery.redo": {
    params: { sessionId: string };
    result: RecoveryApplyResult;
  };
  "recovery.undo": {
    params: { sessionId: string };
    result: RecoveryApplyResult;
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
  "session.entries": {
    params: { branchOnly?: boolean; sessionId: string };
    result: SessionEntriesResult;
  };
  "session.fork": {
    params: { entryId: string; position?: "before" | "at"; sessionId: string };
    result: { cancelled: boolean; editorText?: string; snapshot: SessionSnapshot };
  };
  "session.navigate": {
    params: { sessionId: string; summarize?: boolean; targetId: string };
    result: { cancelled: boolean; editorText?: string; snapshot: SessionSnapshot };
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
