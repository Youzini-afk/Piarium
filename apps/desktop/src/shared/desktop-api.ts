import type { RuntimeCandidate } from "@piarium/pi-host/discovery";
import type {
  EventEnvelope,
  ExtensionUiResponse,
  ImageAttachment,
  JsonValue,
  ModelDescriptor,
  PackageDescriptor,
  ProviderAuthType,
  ProviderDescriptor,
  RecoveryApplyResult,
  RecoveryCheckpoint,
  RecoveryListResult,
  RecoveryMode,
  RecoveryPoint,
  RecoveryPreview,
  SessionSnapshot,
  SessionSummary,
} from "@piarium/protocol";

export interface ProjectDescriptor {
  lastOpenedAt: string;
  name: string;
  path: string;
}

export type RecoveryDefaultMode = "ask" | "both" | "conversation";

export interface AppPreferences {
  recoveryDefault: RecoveryDefaultMode;
}

export interface DesktopAppInfo {
  appVersion: string;
  arch: string;
  electronVersion: string;
  nodeVersion: string;
  platform: string;
  protocolVersion: number;
  runtimes: RuntimeCandidate[];
}

export type DesktopEvent =
  | {
      envelope: EventEnvelope;
      kind: "host";
      sessionId?: string;
      workerId: string;
    }
  | {
      code: number | null;
      kind: "worker.exit";
      sessionId?: string;
      signal: NodeJS.Signals | null;
      workerId: string;
    };

export interface OpenSessionInput {
  cwd?: string;
  sessionFile?: string;
  sessionId?: string;
}

export interface DesktopApi {
  abort(sessionId: string): Promise<{ aborted: boolean }>;
  chooseProject(): Promise<ProjectDescriptor | null>;
  closeSession(sessionId: string): Promise<{ closed: boolean }>;
  createSession(cwd: string, name?: string): Promise<SessionSnapshot>;
  executeCommand(sessionId: string, command: string): Promise<JsonValue>;
  followUp(
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
  ): Promise<{ accepted: boolean }>;
  forkSession(
    sessionId: string,
    entryId: string,
    position?: "before" | "at",
  ): Promise<{ cancelled: boolean; editorText?: string; snapshot: SessionSnapshot }>;
  getAppInfo(): Promise<DesktopAppInfo>;
  getPreferences(): Promise<AppPreferences>;
  getEntries(sessionId: string, branchOnly?: boolean): Promise<JsonValue>;
  getRecentProjects(): Promise<ProjectDescriptor[]>;
  getSettings(sessionId: string): Promise<JsonValue>;
  getSnapshot(sessionId: string): Promise<SessionSnapshot>;
  installPackage(sessionId: string, source: string): Promise<PackageDescriptor>;
  listCommands(
    sessionId: string,
  ): Promise<Array<{ description?: string; name: string; source?: string }>>;
  listModels(sessionId: string): Promise<ModelDescriptor[]>;
  listPackages(sessionId: string): Promise<PackageDescriptor[]>;
  listProviders(sessionId: string): Promise<ProviderDescriptor[]>;
  listSessions(cwd?: string): Promise<SessionSummary[]>;
  loginProvider(
    sessionId: string,
    providerId: string,
    type: ProviderAuthType,
  ): Promise<{ authenticated: boolean }>;
  logoutProvider(sessionId: string, providerId: string): Promise<{ authenticated: false }>;
  navigateSession(
    sessionId: string,
    targetId: string,
    summarize?: boolean,
  ): Promise<{ cancelled: boolean; editorText?: string; snapshot: SessionSnapshot }>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
  openProject(path: string): Promise<ProjectDescriptor>;
  openSession(input: OpenSessionInput): Promise<SessionSnapshot>;
  prompt(
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
  ): Promise<{ accepted: boolean }>;
  removePackage(sessionId: string, source: string): Promise<{ removed: boolean }>;
  applyRecovery(sessionId: string, planId: string): Promise<RecoveryApplyResult>;
  createRecoveryCheckpoint(sessionId: string, name: string): Promise<RecoveryCheckpoint>;
  getRecovery(sessionId: string): Promise<RecoveryListResult>;
  previewRecovery(
    sessionId: string,
    targetKind: "checkpoint" | "turn",
    targetId: string,
    point: RecoveryPoint,
    mode: RecoveryMode,
  ): Promise<RecoveryPreview>;
  redoRecovery(sessionId: string): Promise<RecoveryApplyResult>;
  respondToExtensionUi(sessionId: string, response: ExtensionUiResponse): Promise<boolean>;
  selectModel(sessionId: string, provider: string, modelId: string): Promise<SessionSnapshot>;
  setRecoveryDefault(mode: RecoveryDefaultMode): Promise<AppPreferences>;
  steer(
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
  ): Promise<{ accepted: boolean }>;
  updatePackages(sessionId: string, source?: string): Promise<PackageDescriptor[]>;
  updateSettings(sessionId: string, patch: JsonValue): Promise<JsonValue>;
  undoRecovery(sessionId: string): Promise<RecoveryApplyResult>;
}

export const DESKTOP_EVENT_CHANNEL = "piarium:event";

export const IPC_CHANNELS = {
  abort: "piarium:agent:abort",
  chooseProject: "piarium:project:choose",
  closeSession: "piarium:session:close",
  createSession: "piarium:session:create",
  executeCommand: "piarium:command:execute",
  followUp: "piarium:agent:follow-up",
  forkSession: "piarium:session:fork",
  getAppInfo: "piarium:app:info",
  getPreferences: "piarium:preferences:get",
  getEntries: "piarium:session:entries",
  getRecentProjects: "piarium:project:recent",
  getSettings: "piarium:settings:get",
  getSnapshot: "piarium:session:snapshot",
  installPackage: "piarium:package:install",
  listCommands: "piarium:command:list",
  listModels: "piarium:model:list",
  listPackages: "piarium:package:list",
  listProviders: "piarium:provider:list",
  listSessions: "piarium:session:list",
  loginProvider: "piarium:provider:login",
  logoutProvider: "piarium:provider:logout",
  navigateSession: "piarium:session:navigate",
  openProject: "piarium:project:open",
  openSession: "piarium:session:open",
  prompt: "piarium:agent:prompt",
  removePackage: "piarium:package:remove",
  applyRecovery: "piarium:recovery:apply",
  createRecoveryCheckpoint: "piarium:recovery:checkpoint-create",
  getRecovery: "piarium:recovery:list",
  previewRecovery: "piarium:recovery:preview",
  redoRecovery: "piarium:recovery:redo",
  respondToExtensionUi: "piarium:extension-ui:respond",
  selectModel: "piarium:model:select",
  setRecoveryDefault: "piarium:preferences:recovery-default",
  steer: "piarium:agent:steer",
  updatePackages: "piarium:package:update",
  updateSettings: "piarium:settings:update",
  undoRecovery: "piarium:recovery:undo",
} as const;
