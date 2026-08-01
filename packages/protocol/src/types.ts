export const PIARIUM_PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PIARIUM_PROTOCOL_VERSION;

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type HostMode = "desktop" | "headless" | "mobile" | "test" | "vscode" | "web";

export type RuntimeSourceKind = "bundled" | "system" | "source" | "custom";

export interface HostCapabilities {
  extensionUi: boolean;
  models: boolean;
  packages: boolean;
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
  createdAt?: string;
  cwd: string;
  id: string;
  name?: string;
  sessionFile?: string;
  updatedAt?: string;
}

export interface ModelDescriptor {
  contextWindow?: number;
  id: string;
  name: string;
  provider: string;
  supportsImages?: boolean;
  supportsThinking?: boolean;
}

export interface ImageAttachment {
  data: string;
  mimeType: string;
}

export type ProviderAuthType = "api_key" | "oauth";

export interface ProviderDescriptor {
  authTypes: ProviderAuthType[];
  configured: boolean;
  id: string;
  name: string;
  source?: string;
}

export interface PackageDescriptor {
  enabled: boolean;
  name: string;
  source: string;
  version?: string;
}

export type RecoveryMode = "conversation" | "files" | "both";

export type RecoveryPoint = "before" | "after";

export interface RecoveryTurn {
  afterCommit: string;
  beforeCommit: string;
  completedAt: string;
  hasImages: boolean;
  id: string;
  parentLeafId: string | null;
  resultLeafId: string;
  sessionId: string;
  startedAt: string;
  userEntryId: string;
}

export interface RecoveryCheckpoint {
  commit: string;
  createdAt: string;
  id: string;
  leafId: string | null;
  name: string;
  sessionId: string;
}

export type RecoveryFileChangeKind = "added" | "deleted" | "modified" | "type-changed";

export interface RecoveryFileChange {
  kind: RecoveryFileChangeKind;
  path: string;
}

export interface RecoveryStatus {
  available: boolean;
  canRedo: boolean;
  canUndo: boolean;
  gitPath?: string;
  issue?: string;
  root?: string;
}

export interface RecoveryListResult extends RecoveryStatus {
  checkpoints: RecoveryCheckpoint[];
  turns: RecoveryTurn[];
}

export interface RecoveryPreview {
  changes: RecoveryFileChange[];
  currentLeafId: string | null;
  expiresAt: string;
  mode: RecoveryMode;
  planId: string;
  point: RecoveryPoint;
  targetId: string;
  targetKind: "checkpoint" | "turn";
  totalChanges: number;
  truncated: boolean;
}

export interface RecoveryApplyResult {
  cancelled: boolean;
  editorText?: string;
  mode: RecoveryMode;
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

export interface SessionSnapshot {
  activeTools: string[];
  busy: boolean;
  cwd: string;
  model?: ModelDescriptor;
  sessionId: string;
  thinkingLevel?: string;
}

export interface ProjectTrustRequest {
  cwd: string;
  id: string;
  reason: "project-resources";
}

export interface ProtocolErrorData {
  code: string;
  details?: JsonValue;
  message: string;
  retryable?: boolean;
}
