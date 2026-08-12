import type {
  ExtensionUiResponse,
  HostHandshakeParams,
  HostHandshakeResult,
  ImageAttachment,
  JsonValue,
  ModelDescriptor,
  PackageDescriptor,
  PiCommandDescriptor,
  PiPackageScope,
  PiAgentCatalogSnapshot,
  PiAgentProviderActionResult,
  PiConfigDocumentSnapshot,
  PiConfigScope,
  PiConfigTextDocumentSnapshot,
  PiConfigTextFormat,
  PiConfigTextRoot,
  PiFleetSnapshot,
  PiResourceCatalogSnapshot,
  PiResourceDocumentSnapshot,
  PiResourceKind,
  PiResourceScope,
  PiSettingsSnapshot,
  ProviderAuthType,
  RecoveryMode,
  RecoveryOperationResult,
  RecoveryRepairAction,
  RecoveryStatus,
  SessionHeader,
  SessionSnapshot,
  SessionStats,
  SessionSummary,
  ThinkingLevel,
} from "./types.js";
import type { PiMcpConfigSnapshot } from "./mcp.js";
import type { ProviderAuthResponse, ProviderDescriptor } from "./auth.js";
import type {
  ProviderConfigDeleteScope,
  ProviderConfigDetails,
  ProviderConfigInput,
  ProviderConfigScope,
  ProviderModelDiscoveryResult,
} from "./provider.js";
import type { PiSessionEntry, SessionEntriesResult, SessionTreeResult } from "./session.js";
import type { PiSessionFeatureMutation, PiSessionFeatureState } from "./session-features.js";

export interface HostMethodMap {
  "agentProvider.action": {
    params: { action: string; agentId?: string; input?: JsonValue; providerId: string };
    result: PiAgentProviderActionResult;
  };
  "agentProvider.list": {
    params: Record<string, never>;
    result: PiAgentCatalogSnapshot;
  };
  "config.document.get": {
    params: { path: string; scope: PiConfigScope };
    result: PiConfigDocumentSnapshot;
  };
  "config.document.update": {
    params: {
      path: string;
      remove: string[];
      scope: PiConfigScope;
      set: { [key: string]: JsonValue };
    };
    result: PiConfigDocumentSnapshot;
  };
  "config.text.get": {
    params: { format: PiConfigTextFormat; path: string; root: PiConfigTextRoot };
    result: PiConfigTextDocumentSnapshot;
  };
  "config.text.update": {
    params: {
      content: string;
      expectedRevision: string;
      format: PiConfigTextFormat;
      path: string;
      root: PiConfigTextRoot;
    };
    result: PiConfigTextDocumentSnapshot;
  };
  "catalog.context.open": {
    params: { cwd: string };
    result: SessionSnapshot;
  };
  "agent.abort": {
    params: { sessionId: string };
    result: { aborted: boolean };
  };
  "agent.followUp": {
    params: { images?: ImageAttachment[]; instructions?: string; sessionId: string; text: string };
    result: { accepted: boolean };
  };
  "agent.prompt": {
    params: { images?: ImageAttachment[]; instructions?: string; sessionId: string; text: string };
    result: { accepted: boolean };
  };
  "agent.steer": {
    params: { images?: ImageAttachment[]; instructions?: string; sessionId: string; text: string };
    result: { accepted: boolean };
  };
  "command.execute": {
    params: { command: string; sessionId: string };
    result: JsonValue;
  };
  "command.list": {
    params: { sessionId: string };
    result: PiCommandDescriptor[];
  };
  "extension.ui.respond": {
    params: ExtensionUiResponse;
    result: { accepted: boolean };
  };
  "fleet.status": {
    params: { sessionId: string };
    result: PiFleetSnapshot;
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
  "mcp.config.snapshot": {
    params: Record<string, never>;
    result: PiMcpConfigSnapshot;
  };
  "thinking.select": {
    params: { level: ThinkingLevel; sessionId: string };
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
  "resource.copy": {
    params: {
      id: string;
      kind: PiResourceKind;
      name?: string;
      scope: PiResourceScope;
    };
    result: PiResourceDocumentSnapshot;
  };
  "resource.create": {
    params: { content: string; kind: PiResourceKind; name: string; scope: PiResourceScope };
    result: PiResourceDocumentSnapshot;
  };
  "resource.delete": {
    params: { expectedRevision: string; id: string; kind: PiResourceKind };
    result: { deleted: boolean; id: string };
  };
  "resource.get": {
    params: { id: string; kind: PiResourceKind };
    result: PiResourceDocumentSnapshot;
  };
  "resource.list": {
    params: { kind: PiResourceKind };
    result: PiResourceCatalogSnapshot;
  };
  "resource.update": {
    params: { content: string; expectedRevision: string; id: string; kind: PiResourceKind };
    result: PiResourceDocumentSnapshot;
  };
  "recovery.checkpoint.create": {
    params: { name: string; sessionId: string };
    result: RecoveryOperationResult;
  };
  "recovery.navigate": {
    params: { mode: RecoveryMode; sessionId: string; summarize?: boolean; targetId: string };
    result: RecoveryOperationResult;
  };
  "recovery.repair": {
    params: { action: RecoveryRepairAction; sessionId: string };
    result: RecoveryOperationResult;
  };
  "recovery.redo": {
    params: { mode: RecoveryMode; sessionId: string };
    result: RecoveryOperationResult;
  };
  "recovery.status": {
    params: { sessionId: string };
    result: RecoveryStatus;
  };
  "recovery.undo": {
    params: { mode: RecoveryMode; sessionId: string };
    result: RecoveryOperationResult;
  };
  "package.install": {
    params: { scope: PiPackageScope; source: string };
    result: PackageDescriptor;
  };
  "package.list": {
    params: Record<string, never>;
    result: PackageDescriptor[];
  };
  "package.remove": {
    params: { scope: PiPackageScope; source: string };
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
    params: { cwd: string; name?: string; parentSession?: string };
    result: SessionSnapshot;
  };
  "session.list": {
    params: { cwd?: string };
    result: SessionSummary[];
  };
  "session.entries": {
    params: { scope?: "all" | "branch"; sessionId: string };
    result: SessionEntriesResult;
  };
  "session.entry": {
    params: { entryId: string; sessionId: string };
    result: PiSessionEntry | null;
  };
  "session.fork": {
    params: { entryId: string; position?: "before" | "at"; sessionId: string };
    result: { cancelled: boolean; editorText?: string; snapshot: SessionSnapshot };
  };
  "session.features.get": {
    params: { sessionId: string };
    result: PiSessionFeatureState;
  };
  "session.features.mutate": {
    params: { mutation: PiSessionFeatureMutation; sessionId: string };
    result: PiSessionFeatureState;
  };
  "session.navigate": {
    params: { sessionId: string; summarize?: boolean; targetId: string };
    result: { cancelled: boolean; editorText?: string; snapshot: SessionSnapshot };
  };
  "session.open": {
    params: { cwd?: string; sessionFile?: string; sessionId?: string };
    result: SessionSnapshot;
  };
  "session.header": {
    params: { sessionId: string };
    result: SessionHeader | null;
  };
  "session.rename": {
    params: { name: string; sessionFile?: string; sessionId: string };
    result: { name?: string; sessionId: string };
  };
  "session.snapshot": {
    params: { sessionId: string };
    result: SessionSnapshot;
  };
  "session.stats": {
    params: { sessionId: string };
    result: SessionStats;
  };
  "session.summary": {
    params: { sessionId: string };
    result: SessionSummary;
  };
  "session.tree": {
    params: { sessionId: string };
    result: SessionTreeResult;
  };
  "settings.get": {
    params: Record<string, never>;
    result: PiSettingsSnapshot;
  };
  "settings.update": {
    params: {
      remove: string[];
      scope: PiConfigScope;
      set: { [key: string]: JsonValue };
    };
    result: PiSettingsSnapshot;
  };
}

export type HostMethod = keyof HostMethodMap;

export type HostMethodParams<M extends HostMethod> = HostMethodMap[M]["params"];

export type HostMethodResult<M extends HostMethod> = HostMethodMap[M]["result"];
