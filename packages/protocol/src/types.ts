import type { PiSessionFeatureState } from "./session-features.js";

// Piarium is pre-release and all product surfaces ship in lockstep. Breaking
// development changes replace this single contract instead of accumulating
// compatibility versions that no released client needs.
export const PIARIUM_PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PIARIUM_PROTOCOL_VERSION;

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type HostMode = "desktop" | "headless" | "mobile" | "test" | "vscode" | "web";

export type RuntimeSourceKind = "bundled" | "system" | "source" | "custom";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface HostCapabilities {
  agentProviders: boolean;
  extensionUi: boolean;
  fleet: boolean;
  models: boolean;
  packages: boolean;
  providerConfiguration: boolean;
  recovery: boolean;
  resources: boolean;
  sessionFeatures: boolean;
  sessions: boolean;
  settings: boolean;
}

export interface RuntimeDescriptor {
  agentDir: string;
  nodePath: string;
  nodeVersion: string;
  packageRoot?: string;
  piVersion: string;
  source: RuntimeSourceKind;
}

export interface SessionSummary {
  allMessagesText: string;
  archivedAt?: string;
  createdAt: string;
  cwd: string;
  firstMessage: string;
  id: string;
  messageCount: number;
  name?: string;
  parentId?: string;
  parentSessionPath?: string;
  persisted: boolean;
  sessionFile: string;
  updatedAt: string;
}

export interface SessionHeader {
  cwd: string;
  id: string;
  parentSession?: string;
  timestamp: string;
  version?: number;
}

export interface ModelDescriptor {
  api: string;
  available: boolean;
  baseUrl: string;
  contextWindow: number;
  cost: {
    cacheRead: number;
    cacheWrite: number;
    input: number;
    output: number;
    tiers?: Array<{
      cacheRead: number;
      cacheWrite: number;
      input: number;
      inputTokensAbove: number;
      output: number;
    }>;
  };
  id: string;
  input: Array<"text" | "image">;
  maxTokens: number;
  name: string;
  provider: string;
  supportedThinkingLevels: ThinkingLevel[];
}

export interface ImageAttachment {
  data: string;
  mimeType: string;
}

export type ProviderAuthType = "api_key" | "oauth";

export interface PackageDescriptor {
  installed: boolean;
  name: string;
  resolvedPath?: string;
  scope: PiPackageScope;
  source: string;
  structured: boolean;
  version?: string;
}

export type PiPackageScope = "global" | "project";

export type PiResourceKind = "prompt" | "skill";

export type PiResourceScope = "user" | "project";

export interface PiResourceSourceInfo {
  baseDir?: string;
  origin: "package" | "top-level";
  path: string;
  scope: PiResourceScope | "temporary";
  source: string;
}

export type PiCommandSource = "extension" | "prompt" | "skill";

export interface PiCommandDescriptor {
  argumentHint?: string;
  description?: string;
  name: string;
  source: PiCommandSource;
  sourceInfo: PiResourceSourceInfo;
}

export interface PiResourceCollision {
  loserPath: string;
  loserSource?: string;
  name: string;
  resourceType: "extension" | "prompt" | "skill" | "theme";
  winnerPath: string;
  winnerSource?: string;
}

export interface PiResourceDiagnostic {
  collision?: PiResourceCollision;
  message: string;
  path?: string;
  type: "collision" | "error" | "warning";
}

export interface PiResourceDescriptor {
  active: boolean;
  argumentHint?: string;
  baseDir?: string;
  description: string;
  disableModelInvocation?: boolean;
  filePath: string;
  id: string;
  kind: PiResourceKind;
  name: string;
  sourceInfo: PiResourceSourceInfo;
  valid: boolean;
  writable: boolean;
}

export interface PiResourceCatalogSnapshot {
  diagnostics: PiResourceDiagnostic[];
  projectTrusted: boolean;
  resources: PiResourceDescriptor[];
}

export interface PiResourceDocumentSnapshot {
  content: string;
  descriptor: PiResourceDescriptor;
  projectTrusted: boolean;
  revision: string;
}

export type PiAgentKind =
  | "delegatable"
  | "internal"
  | "primary"
  | "profile"
  | "service"
  | "workflow";

export type PiAgentStatus =
  | "available"
  | "disabled"
  | "error"
  | "unavailable"
  | "unconfigured";

export type PiAgentSourceScope = "builtin" | "package" | "project" | "runtime" | "user";

export interface PiAgentSource {
  packageName?: string;
  path?: string;
  scope: PiAgentSourceScope;
}

export interface PiAgentActionDescriptor {
  destructive?: boolean;
  id: string;
  label: string;
  requiresScope?: boolean;
}

export interface PiAgentConfigurationTarget {
  pluginId: string;
  section?: string;
}

export interface PiAgentInvocationDescriptor {
  command: string;
  kind: "slash-command";
  taskSeparator: "space" | "double-dash";
}

/** Provider-owned definition used to seed that agent's edit/update flow. */
export interface PiAgentDefinitionDescriptor {
  config: { [key: string]: JsonValue };
}

export interface PiAgentDescriptor {
  actions: PiAgentActionDescriptor[];
  aliases?: string[];
  configuration?: PiAgentConfigurationTarget;
  definition?: PiAgentDefinitionDescriptor;
  description: string;
  fallbackModels?: string[];
  id: string;
  invocation?: PiAgentInvocationDescriptor;
  kind: PiAgentKind;
  model?: string;
  name: string;
  providerId: string;
  source: PiAgentSource;
  status: PiAgentStatus;
  thinking?: string;
}

export interface PiAgentProviderDescriptor {
  actions: PiAgentActionDescriptor[];
  available: boolean;
  configuration?: PiAgentConfigurationTarget;
  description: string;
  id: string;
  label: string;
  source?: string;
}

export interface PiAgentDiagnostic {
  message: string;
  path?: string;
  providerId: string;
  severity: "error" | "warning";
}

export interface PiAgentCatalogSnapshot {
  agents: PiAgentDescriptor[];
  diagnostics: PiAgentDiagnostic[];
  projectTrusted: boolean;
  providers: PiAgentProviderDescriptor[];
}

export interface PiAgentProviderActionResult {
  agentId?: string;
  data?: JsonValue;
  message: string;
  providerId: string;
  success: boolean;
}

export type PiFleetProviderState = "active" | "degraded" | "incompatible" | "unavailable";

export interface PiFleetProviderSnapshot {
  bridgeVersion?: number;
  id: string;
  issue?: string;
  label: string;
  source?: string;
  state: PiFleetProviderState;
}

export interface PiFleetEntry {
  agent: string;
  effort?: string;
  goal?: string;
  key: string;
  model?: string;
  providerId: string;
  role?: string;
  startedAt: number;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
}

export interface PiFleetSnapshot {
  entries: PiFleetEntry[];
  omitted: number;
  providers: PiFleetProviderSnapshot[];
  totalActive: number;
}

export type RecoveryMode = "conversation" | "files" | "both";

export type RecoveryPreference = "conversation" | "both" | "ask";

export type RecoveryAction =
  | "navigate"
  | "undo"
  | "redo"
  | "checkpoint"
  | "repair"
  | "repair-typo"
  | "repair-destructive";

export type RecoveryRepairAction = "recover" | "recover-typo" | "recover-destructive";

export interface RecoveryProviderDescriptor {
  actions: RecoveryAction[];
  active: boolean;
  bridgeVersion?: number;
  id: string;
  modes: RecoveryMode[];
  name: string;
  source?: string;
}

export interface RecoveryStatus {
  actions: RecoveryAction[];
  available: boolean;
  issues: string[];
  modes: RecoveryMode[];
  providers: RecoveryProviderDescriptor[];
}

export interface RecoveryOperationResult {
  action: RecoveryAction;
  editorImages?: ImageAttachment[];
  editorText?: string;
  handledBy: string;
  mode?: RecoveryMode;
  outcome: "applied" | "cancelled" | "unknown";
  snapshot: SessionSnapshot;
}

export interface HostHandshakeParams {
  clientName: string;
  clientVersion: string;
  mode: HostMode;
  protocolVersions: number[];
}

export interface HostHandshakeResult {
  capabilities: HostCapabilities;
  hostVersion: string;
  protocolVersion: ProtocolVersion;
  runtime: RuntimeDescriptor;
}

export type ExtensionUiMethod =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "custom"
  | "notify"
  | "setStatus"
  | "setWidget"
  | "setTitle"
  | "setEditorText"
  | "setWorkingMessage"
  | "setWorkingVisible"
  | "setWorkingIndicator"
  | "setHiddenThinkingLabel";

export interface ExtensionUiRequest {
  id?: string;
  method: ExtensionUiMethod;
  options?: JsonValue;
  payload: JsonValue;
  sessionId: string;
}

export interface ExtensionUiResponse {
  cancelled?: boolean;
  requestId: string;
  value?: JsonValue;
}

export interface SessionRuntimeState {
  activeTools: string[];
  busy: boolean;
  followUp: string[];
  followUpMode: "all" | "one-at-a-time";
  isCompacting: boolean;
  isStreaming: boolean;
  pendingMessageCount: number;
  retryAttempt: number;
  steering: string[];
  steeringMode: "all" | "one-at-a-time";
}

export interface SessionSnapshot extends SessionRuntimeState {
  cwd: string;
  features: PiSessionFeatureState;
  leafId: string | null;
  model?: ModelDescriptor;
  name?: string;
  sessionFile?: string;
  sessionId: string;
  thinkingLevel: ThinkingLevel;
}

export interface SessionStats {
  contextUsage?: JsonValue;
  cost: number;
  sessionFile?: string;
  sessionId: string;
  tokens: {
    cacheRead: number;
    cacheWrite: number;
    input: number;
    output: number;
    total: number;
  };
  totalMessages: number;
  toolCalls: number;
  toolResults: number;
  assistantMessages: number;
  userMessages: number;
}

export interface ProjectTrustRequest {
  cwd: string;
  id: string;
  reason: "project-resources";
}

export type PiConfigScope = "global" | "project";

export type PiConfigTextFormat = "json" | "jsonc";
export type PiConfigTextRoot = "agent" | "home" | "project" | "user-config";

export interface ExtensionStateSnapshot {
  channel: string;
  sessionId: string;
  value: JsonValue | null;
}

export interface PiConfigTextDocumentSnapshot {
  content: string;
  exists: boolean;
  format: PiConfigTextFormat;
  path: string;
  projectTrusted: boolean;
  revision: string;
  root: PiConfigTextRoot;
}

export interface PiConfigDocumentSnapshot {
  document: { [key: string]: JsonValue };
  exists: boolean;
  path: string;
  projectTrusted: boolean;
  scope: PiConfigScope;
}

export interface PiSettingsSnapshot {
  global: { [key: string]: JsonValue };
  project: { [key: string]: JsonValue };
  projectTrusted: boolean;
}

export interface ProtocolErrorData {
  code: string;
  details?: JsonValue;
  message: string;
  retryable?: boolean;
}
