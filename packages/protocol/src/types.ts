export const PIARIUM_PROTOCOL_VERSION = 6 as const;

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
  extensionUi: boolean;
  models: boolean;
  packages: boolean;
  providerConfiguration: boolean;
  recovery: boolean;
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
  enabled: boolean;
  name: string;
  source: string;
  version?: string;
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
