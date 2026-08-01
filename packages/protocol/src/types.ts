export const PIARIUM_PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PIARIUM_PROTOCOL_VERSION;

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type HostMode = "desktop" | "headless" | "remote" | "test";

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
