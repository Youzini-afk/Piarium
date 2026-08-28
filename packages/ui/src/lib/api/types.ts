import type { PiRuntimeSnapshot } from '@piarium/protocol';
import type { WorktreeMetadata } from '@/types/worktree';
import type { DraftStarterRef } from '@/lib/draftStarters';
import type { FileEditorSettingsPatch } from '@/lib/file-editor-settings';
import type {
  PiariumExtensionActualState,
  PiariumExtensionAssetPayload,
  PiariumExtensionAssetRequest,
  PiariumExtensionCandidateCapabilityReviewRequest,
  PiariumExtensionCapabilityReviewRequest,
  PiariumExtensionCandidateSelectionRequest,
  PiariumExtensionCandidatePreparationResult,
  PiariumExtensionCatalogAvailability,
  PiariumExtensionCatalogSnapshot,
  PiariumExtensionHostStateSnapshot,
  PiariumExtensionHostStateWaitRequest,
  PiariumExtensionManagedEntrypointPayload,
  PiariumExtensionManagedEntrypointRequest,
  PiariumExtensionLocalSourceReloadRequest,
  PiariumExtensionLocalSourceReloadResult,
  PiariumExtensionPackageInstallRequest,
  PiariumExtensionRemoveRequest,
  PiariumExtensionServiceInvocationRequest,
  PiariumExtensionServiceRoutingRuleRemoveRequest,
  PiariumExtensionServiceRoutingRuleUpdateRequest,
  PiariumExtensionServiceRoutingSnapshot,
  PiariumExtensionServiceSelectionRequest,
  PiariumWorkbenchLayoutUpdateRequest,
  PiariumWorkbenchProfileRemoveRequest,
  PiariumWorkbenchProfileApplyRequest,
  PiariumWorkbenchProfileSelectionRequest,
  PiariumWorkbenchProfileSnapshot,
  PiariumWorkbenchProfileUpsertRequest,
  JsonValue,
} from '@piarium/extension-contract';

type RuntimePlatform = 'web' | 'desktop' | 'vscode';

interface RuntimeDescriptor {
  platform: RuntimePlatform;

  isDesktop: boolean;

  isVSCode: boolean;

  label?: string;
}

export interface Subscription {

  close: () => void;
}

export interface TerminalSession {
  sessionId: string;
  cols: number;
  rows: number;
  status: 'running' | 'exited' | 'error';
}

export type TerminalShell = 'auto' | 'bash' | 'zsh' | 'sh' | 'fish' | 'pwsh' | 'powershell' | 'cmd' | 'dash' | 'ksh' | 'nu';

export interface TerminalShellOption {
  id: TerminalShell;
  name: string;
  supportsLogin: boolean;
}

export interface TerminalStreamEvent {
  type: 'snapshot' | 'data' | 'exit' | 'reconnecting';
  sequence?: number;
  data?: string;
  replayData?: string;
  status?: 'running' | 'exited' | 'error';
  exitCode?: number;
  signal?: number | null;
  attempt?: number;
  maxAttempts?: number;

  runtime?: 'node' | 'bun';
  ptyBackend?: string;
}

export interface TerminalError extends Error {
  code?: string;
}

export interface CreateTerminalOptions {
  cwd?: string;
  workspacePath?: string;
  sessionId?: string;
  cols?: number;
  rows?: number;
  themeMode?: 'light' | 'dark';
  terminalBackground?: string;
  terminalForeground?: string;
  shell?: TerminalShell;
  loginShell?: boolean;
}

export interface ResizeTerminalPayload {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalHandlers {
  onEvent: (event: TerminalStreamEvent) => void;
  onError?: (error: TerminalError, fatal?: boolean) => void;
}

export interface ForceKillOptions {
  sessionId?: string;
  cwd?: string;
}

export interface TerminalAPI {
  listShells?(): Promise<TerminalShellOption[]>;
  createSession(options: CreateTerminalOptions): Promise<TerminalSession>;
  connect(sessionId: string, handlers: TerminalHandlers): Subscription;
  sendInput(sessionId: string, input: string): Promise<void>;
  resize(payload: ResizeTerminalPayload): Promise<void>;
  updateAppearance?(sessionId: string, appearance: Pick<CreateTerminalOptions, 'themeMode' | 'terminalBackground' | 'terminalForeground'>): Promise<void>;
  close(sessionId: string): Promise<void>;
  restartSession?(currentSessionId: string, options: CreateTerminalOptions): Promise<TerminalSession>;
  forceKill?(options: ForceKillOptions): Promise<void>;
}

export interface GitStatusFile {
  path: string;
  index: string;
  working_dir: string;
}

export interface GitMergeInProgress {
  /** Short SHA of MERGE_HEAD */
  head: string;
  /** First line of MERGE_MSG */
  message: string;
}

export interface GitRebaseInProgress {
  /** Branch name being rebased */
  headName: string;
  /** Short SHA of the onto commit */
  onto: string;
}

export interface GitRemoteComparison {
  remote: string;
  branch: string;
  ahead: number;
  behind: number;
}

export interface GitStatus {
  current: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  upstreamComparison?: GitRemoteComparison | null;
  files: GitStatusFile[];
  isClean: boolean;
  diffStats?: Record<string, { insertions: number; deletions: number }>;
  /** Present when a merge is in progress with conflicts */
  mergeInProgress?: GitMergeInProgress | null;
  /** Present when a rebase is in progress */
  rebaseInProgress?: GitRebaseInProgress | null;
  /** Phase 1: reason for attention-required state */
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
}

export interface GitDiffResponse {
  diff: string;
}

export interface GetGitDiffOptions {
  path: string;
  staged?: boolean;
  contextLines?: number;
}

export interface GitFileDiffResponse {
  original: string;
  modified: string;
  path: string;
  isBinary?: boolean;
}

export interface GetGitFileDiffOptions {
  path: string;
  staged?: boolean;
}

export interface GitBranchDetails {
  current: boolean;
  name: string;
  commit: string;
  label: string;
  tracking?: string;
  ahead?: number;
  behind?: number;
}

export interface GitBranch {
  all: string[];
  current: string;
  branches: Record<string, GitBranchDetails>;
  defaultBranches?: Record<string, string>;
}

interface GitCommitSummary {
  changes: number;
  insertions: number;
  deletions: number;
}

export interface GitCommitResult {
  success: boolean;
  commit: string;
  branch: string;
  summary: GitCommitSummary;
}

export interface GitPushResult {
  success: boolean;
  pushed: Array<{
    local: string;
    remote: string;
  }>;
  repo: string;
  ref: unknown;
}

export interface GitPullResult {
  success: boolean;
  summary: GitCommitSummary;
  files: string[];
  insertions: number;
  deletions: number;
}

export interface GitPullOptions {
  remote?: string;
  branch?: string;
  rebase?: boolean;
}

export interface GitStashEntry {
  ref: string;
  message: string;
  relativeTime: string;
  hash: string;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface GitMergeResult {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface CheckoutCommitResponse {
  success: boolean;
}

export interface CherryPickResponse {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface RevertCommitResponse {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface ResetToCommitResponse {
  success: boolean;
}

export interface GitRebaseResult {
  success: boolean;
  conflict?: boolean;
  conflictFiles?: string[];
}

export interface MergeConflictDetails {
  /** Git status --porcelain output showing current state */
  statusPorcelain: string;
  /** List of unmerged file paths */
  unmergedFiles: string[];
  /** Git diff output showing current conflict state */
  diff: string;
  /** Information about MERGE_HEAD or REBASE_HEAD */
  headInfo: string;
  /** The operation type: 'merge' or 'rebase' */
  operation: 'merge' | 'rebase';
}

export type GitIdentityAuthType = 'ssh' | 'token';

export interface GitIdentityProfile {
  id: string;
  name: string;
  userName: string;
  userEmail: string;
  authType?: GitIdentityAuthType;
  sshKey?: string | null;
  signCommits?: boolean;
  signingKey?: string | null;
  host?: string | null;
  color?: string | null;
  icon?: string | null;
}

export interface DiscoveredGitCredential {
  host: string;
  username: string;
}

export interface GitIdentitySummary {
  userName: string | null;
  userEmail: string | null;
  sshCommand: string | null;
}

export interface GitCloneRepositoryInput {
  remoteUrl: string;
  destinationPath: string;
  gitIdentity?: GitIdentityProfile | null;
}

export interface GitCloneRepositoryResult {
  success: boolean;
  path: string;
  output?: string;
}

export interface GitLogEntry {
  hash: string;
  date: string;
  message: string;
  refs: string;
  body: string;
  author_name: string;
  author_email: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  parents: string[];
}

export interface GitLogResponse {
  all: GitLogEntry[];
  latest: GitLogEntry | null;
  total: number;
}

export interface CommitFileEntry {
  path: string;
  insertions: number;
  deletions: number;
  isBinary: boolean;
  changeType: 'A' | 'M' | 'D' | 'R' | 'C' | string;
}

export interface GitCommitFilesResponse {
  files: CommitFileEntry[];
}

export interface CommitFileDiffResponse {
  original: string;
  modified: string;
  isBinary: boolean;
}

export interface GitWorktreeInfo {
  head: string;
  name: string;
  branch: string;
  path: string;
}

export interface GitWorktreeValidationError {
  code: string;
  message: string;
}

export interface GitWorktreeValidationResult {
  ok: boolean;
  errors: GitWorktreeValidationError[];
  resolved?: {
    mode?: 'new' | 'existing';
    localBranch?: string | null;
  };
}

export interface GitWorktreeBootstrapStatus {
  status: 'pending' | 'ready' | 'failed';
  phase?: 'directory-created' | 'git-ready' | 'setup-ready';
  error: string | null;
  updatedAt: number;
}

export interface CreateGitWorktreePayload {
  mode?: 'new' | 'existing';
  /** Worktree folder name (falls back to Piarium name generation when omitted). */
  worktreeName?: string;
  /** New local branch name for mode=new. */
  branchName?: string;
  /** Existing local/remote branch for mode=existing. */
  existingBranch?: string;
  /** Start ref for mode=new (local/remote branch or commit SHA). */
  startRef?: string;
  /** Setup script to run after Git has populated the worktree. */
  startCommand?: string;
  /** Configure upstream tracking for the created/attached local branch. */
  setUpstream?: boolean;
  upstreamRemote?: string;
  upstreamBranch?: string;
  /** Optional remote provisioning (used for fork PR workflows). */
  ensureRemoteName?: string;
  ensureRemoteUrl?: string;
  /** Return once the target directory exists and finish Git worktree setup in the background. */
  returnAfterDirectoryCreated?: boolean;
}

export interface GitWorktreeCreateResult {
  head: string;
  name: string;
  branch: string;
  path: string;
  directoryCreated?: true;
  bootstrapStatus?: GitWorktreeBootstrapStatus;
}

export interface RemoveGitWorktreePayload {
  directory: string;
  deleteLocalBranch?: boolean;
}

export interface GitDeleteBranchPayload {
  branch: string;
  force?: boolean;
}

export interface GitDeleteRemoteBranchPayload {
  branch: string;
  remote?: string;
}

export interface GitRemoveRemotePayload {
  remote: string;
}

export interface CreateGitCommitOptions {
  addAll?: boolean;
  files?: string[];
  stageFiles?: string[];
}

export interface GitLogOptions {
  maxCount?: number;
  from?: string;
  to?: string;
  file?: string;
  all?: boolean;
}

export interface GeneratedCommitMessage {
  subject: string;
  highlights: string[];
}

export interface GeneratedPullRequestDescription {
  title: string;
  body: string;
}

interface GitWorktreeAPI {
  list(directory: string): Promise<GitWorktreeInfo[]>;
  validate?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult>;
  bootstrapStatus?(directory: string): Promise<GitWorktreeBootstrapStatus>;
  preview?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  create?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  remove?(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }>;
}

export interface GitAPI {
  cloneRepository(input: GitCloneRepositoryInput): Promise<GitCloneRepositoryResult>;
  checkIsGitRepository(directory: string): Promise<boolean>;
  getGitStatus(directory: string, options?: { mode?: 'light' }): Promise<GitStatus>;
  getGitDiff(directory: string, options: GetGitDiffOptions): Promise<GitDiffResponse>;
  getGitFileDiff(directory: string, options: GetGitFileDiffOptions): Promise<GitFileDiffResponse>;
  revertGitFile(directory: string, filePath: string, options?: { scope?: 'all' | 'working' }): Promise<void>;
  stageGitFile(directory: string, filePath: string): Promise<void>;
  stageGitFiles?(directory: string, filePaths: string[]): Promise<void>;
  unstageGitFile(directory: string, filePath: string): Promise<void>;
  unstageGitFiles?(directory: string, filePaths: string[]): Promise<void>;
  stageGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  unstageGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  revertGitHunk?(directory: string, filePath: string, patch: string): Promise<void>;
  isLinkedWorktree(directory: string): Promise<boolean>;
  getGitBranches(directory: string): Promise<GitBranch>;
  deleteGitBranch(directory: string, payload: GitDeleteBranchPayload): Promise<{ success: boolean }>;
  deleteRemoteBranch(directory: string, payload: GitDeleteRemoteBranchPayload): Promise<{ success: boolean }>;
  removeRemote(directory: string, payload: GitRemoveRemotePayload): Promise<{ success: boolean }>;
  generateCommitMessage(directory: string, files: string[], options?: { zenModel?: string; providerId?: string; modelId?: string }): Promise<{ message: GeneratedCommitMessage }>;
  generatePullRequestDescription(
    directory: string,
    payload: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string }
  ): Promise<GeneratedPullRequestDescription>;
  listGitWorktrees(directory: string): Promise<GitWorktreeInfo[]>;
  validateGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult>;
  getGitWorktreeBootstrapStatus?(directory: string): Promise<GitWorktreeBootstrapStatus>;
  previewGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  createGitWorktree?(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult>;
  deleteGitWorktree?(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }>;
  createGitCommit(directory: string, message: string, options?: CreateGitCommitOptions): Promise<GitCommitResult>;
  gitPush(directory: string, options?: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> }): Promise<GitPushResult>;
  gitPull(directory: string, options?: GitPullOptions): Promise<GitPullResult>;
  gitFetch(directory: string, options?: { remote?: string; branch?: string }): Promise<{ success: boolean }>;
  listGitStashes(directory: string): Promise<{ stashes: GitStashEntry[] }>;
  countGitStashFiles(directory: string, refs: string[]): Promise<{ counts: Record<string, number> }>;
  stashGitChanges(directory: string, options?: { message?: string }): Promise<{ success: boolean; created: boolean; message: string; output: string }>;
  applyGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  popGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  dropGitStash(directory: string, options: { ref: string }): Promise<{ success: boolean; ref: string }>;
  checkoutBranch(directory: string, branch: string): Promise<{ success: boolean; branch: string }>;
  createBranch(directory: string, name: string, startPoint?: string): Promise<{ success: boolean; branch: string }>;
  renameBranch(directory: string, oldName: string, newName: string): Promise<{ success: boolean; branch: string }>;
  getGitLog(directory: string, options?: GitLogOptions): Promise<GitLogResponse>;
  getCommitFiles(directory: string, hash: string): Promise<GitCommitFilesResponse>;
  getCommitFileDiff?(directory: string, hash: string, filePath: string, isBinary: boolean): Promise<CommitFileDiffResponse>;
  getCurrentGitIdentity(directory: string): Promise<GitIdentitySummary | null>;
  hasLocalIdentity?(directory: string): Promise<boolean>;
  setGitIdentity(directory: string, profileId: string): Promise<{ success: boolean; profile: GitIdentityProfile }>;
  getGitIdentities(): Promise<GitIdentityProfile[]>;
  createGitIdentity(profile: GitIdentityProfile): Promise<GitIdentityProfile>;
  updateGitIdentity(id: string, updates: GitIdentityProfile): Promise<GitIdentityProfile>;
  deleteGitIdentity(id: string): Promise<void>;
  discoverGitCredentials?(): Promise<DiscoveredGitCredential[]>;
  getGlobalGitIdentity?(): Promise<GitIdentitySummary | null>;
  getRemoteUrl?(directory: string, remote?: string): Promise<string | null>;
  getRemotes(directory: string): Promise<GitRemote[]>;
  rebase(directory: string, options: { onto: string }): Promise<GitRebaseResult>;
  abortRebase(directory: string): Promise<{ success: boolean }>;
  continueRebase(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>;
  merge(directory: string, options: { branch: string }): Promise<GitMergeResult>;
  abortMerge(directory: string): Promise<{ success: boolean }>;
  continueMerge(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }>;
  checkoutCommit(directory: string, hash: string): Promise<CheckoutCommitResponse>;
  cherryPick(directory: string, hash: string): Promise<CherryPickResponse>;
  revertCommit(directory: string, hash: string): Promise<RevertCommitResponse>;
  resetToCommit(directory: string, hash: string, mode: 'soft' | 'mixed' | 'hard', force?: boolean): Promise<ResetToCommitResponse>;
  stash(directory: string, options?: { message?: string; includeUntracked?: boolean }): Promise<{ success: boolean }>;
  stashPop(directory: string): Promise<{ success: boolean }>;
  getConflictDetails(directory: string): Promise<MergeConflictDetails>;
  /** Phase 1: validate that a cwd is inside a worktreeRoot */
  validateWorktreeDirectory?(directory: string, worktreeRoot: string): Promise<{
    valid: boolean;
    insideWorktreeRoot: boolean;
    resolvedWorktreeRoot: string | null;
    resolvedCwd: string | null;
  }>;
  /** Phase 1: canonicalize a directory to full worktree state */
  canonicalizeWorktreeState?(directory: string): Promise<{
    worktreeRoot: string | null;
    cwd: string | null;
    branch: string | null;
    headState: 'branch' | 'detached' | 'unborn';
    worktreeStatus: 'pending' | 'ready' | 'missing' | 'invalid' | 'not-a-repo';
    legacy: boolean;
    degraded: boolean;
    attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
  }>;
  worktree?: GitWorktreeAPI;
}

export interface FileListEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modifiedTime?: number;
}

export interface DirectoryListResult {
  directory: string;
  entries: FileListEntry[];
}

export interface FileSearchQuery {
  directory: string;
  query: string;
  maxResults?: number;
  includeHidden?: boolean;
  respectGitignore?: boolean;
}

export interface FileSearchResult {
  path: string;
  score?: number;
  preview?: string[];
}

export interface CommandExecResult {
  command: string;
  success: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

interface ListDirectoryOptions {
  respectGitignore?: boolean;
}

export interface FileReadOptions {
  allowOutsideWorkspace?: boolean;
  outsideFileGrant?: string;
  optional?: boolean;
  directory?: string;
}

/** Browse, binary preview, and tree CRUD. Text content is DocumentsAPI. */
export interface FilesAPI {
  getHomeDirectory(): Promise<string>;
  listDirectory(path: string, options?: ListDirectoryOptions): Promise<DirectoryListResult>;
  search(payload: FileSearchQuery, options?: { signal?: AbortSignal }): Promise<FileSearchResult[]>;
  createDirectory(path: string, options?: { allowOutsideWorkspace?: boolean }): Promise<{ success: boolean; path: string }>;
  statFile?(path: string, options?: FileReadOptions): Promise<{ path: string; isFile: boolean; size: number; mtimeMs?: number }>;
  readFileBinary?(path: string, options?: FileReadOptions): Promise<{ dataUrl: string; path: string }>;
  delete?(path: string): Promise<{ success: boolean }>;
  rename?(oldPath: string, newPath: string): Promise<{ success: boolean; path: string }>;
  revealPath?(path: string): Promise<{ success: boolean }>;
  execCommands?(commands: string[], cwd: string): Promise<{ success: boolean; results: CommandExecResult[] }>;
  downloadFile?(path: string): Promise<void>;
}

export interface ProjectEntry {
  id: string;
  path: string;
  label?: string;
  icon?: string | null;
  iconImage?: {
    mime: string;
    updatedAt: number;
    source: 'custom' | 'auto';
  } | null;
  iconBackground?: string | null;
  color?: string | null;
  defaultModel?: string;
  addedAt?: number;
  lastOpenedAt?: number;
  sidebarCollapsed?: boolean;
}

export interface SettingsPayload {
  themeId?: string;
  useSystemTheme?: boolean;
  themeVariant?: 'light' | 'dark';
  lightThemeId?: string;
  darkThemeId?: string;
  lastDirectory?: string;
  homeDirectory?: string;
  projects?: ProjectEntry[];
  activeProjectId?: string | null;
  securityScopedBookmarks?: string[];
  pinnedDirectories?: string[];
  showReasoningTraces?: boolean;
  collapsibleThinkingBlocks?: boolean;
  showDeletionDialog?: boolean;
  nativeNotificationsEnabled?: boolean;
  notificationMode?: 'always' | 'hidden-only';
  autoDeleteEnabled?: boolean;
  autoSaveEnabled?: boolean;
  autoDeleteAfterDays?: number;
  sessionRetentionAction?: 'archive' | 'delete';
  recoveryPreference?: 'conversation' | 'both' | 'ask';
  followUpBehavior?: 'steer' | 'queue';
  gitmojiEnabled?: boolean;
  inputSpellcheckEnabled?: boolean;
  showToolFileIcons?: boolean;
  codeBlockLineWrap?: boolean;
  showTurnChangedFiles?: boolean;
  showExpandedBashTools?: boolean;
  showExpandedEditTools?: boolean;
  chatRenderMode?: 'sorted' | 'live';
  messageStreamTransport?: 'auto' | 'ws' | 'sse';
  activityRenderMode?: 'collapsed' | 'summary';
  mermaidRenderingMode?: 'svg' | 'ascii';
  showSplitAssistantMessageActions?: boolean;
  fontSize?: number;
  terminalFontSize?: number;
  terminalShell?: TerminalShell;
  terminalLoginShells?: TerminalShell[];
  editorFontSize?: number;
  fileEditorSettings?: FileEditorSettingsPatch;
  uiFont?: string;
  monoFont?: string;
  padding?: number;
  cornerRadius?: number;
  inputBarOffset?: number;
  shortcutOverrides?: Record<string, string>;
  diffLayoutPreference?: 'dynamic' | 'inline' | 'side-by-side';
  gitChangesViewMode?: 'flat' | 'tree';
  directoryShowHidden?: boolean;
  filesViewShowGitignored?: boolean;
  openInAppId?: string;
  gitProviderId?: string;
  gitModelId?: string;
  pwaAppName?: string;
  mobileKeyboardMode?: 'native' | 'resize-content';
  draftStarters?: DraftStarterRef[];
  draftStartersVisible?: boolean;

  [key: string]: unknown;
}

export interface SettingsLoadResult {
  settings: SettingsPayload;
  source: 'desktop' | 'web';
}

export interface SettingsAPI {
  load(): Promise<SettingsLoadResult>;
  save(changes: Partial<SettingsPayload>): Promise<SettingsPayload>;
}

export interface DirectoryPermissionRequest {
  path: string;
}

interface DirectoryPermissionResult {
  success: boolean;
  path?: string;
  error?: string;
}

export interface StartAccessingResult {
  success: boolean;
  error?: string;
}

export interface PermissionsAPI {
  requestDirectoryAccess(request: DirectoryPermissionRequest): Promise<DirectoryPermissionResult>;
  startAccessingDirectory(path: string): Promise<StartAccessingResult>;
  stopAccessingDirectory(path: string): Promise<StartAccessingResult>;
}

export interface NotificationPayload {
  title?: string;
  body?: string;

  tag?: string;
  kind?: string;
  sessionId?: string;
  directory?: string;
  requireHidden?: boolean;
}

export interface NotificationsAPI {
  notifyAgentCompletion(payload?: NotificationPayload): Promise<boolean>;
  canNotify?: () => boolean | Promise<boolean>;
}

interface DiagnosticsAPI {
  downloadLogs(): Promise<{ fileName: string; content: string }>;
}

export interface ToolsAPI {

  getAvailableTools(): Promise<string[]>;
}

export interface EditorAPI {
  openFile(path: string, line?: number, column?: number): Promise<void>;
  openDiff(
    original: string,
    modified: string,
    label?: string,
    options?: { line?: number; patch?: string },
  ): Promise<void>;
}

export interface VSCodeAPI {
  executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  openAgentManager(): Promise<void>;
  openSettings?(settingsPage?: string): Promise<void>;
  openExternalUrl(url: string): Promise<void>;
  pickFiles?(options?: { extensions?: string[] }): Promise<unknown>;
  saveImage?(payload: unknown): Promise<unknown>;
  saveMarkdown?(payload: unknown): Promise<unknown>;
}

export interface PushSubscribePayload {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  origin?: string;
  /** Runtime surface ('ios' | 'android' | 'vscode' | 'desktop' | 'web') for presence-aware routing. */
  platform?: string;
}

export interface PushUnsubscribePayload {
  endpoint: string;
}

export interface ApnsTokenPayload {
  token: string;
  /** 'ios' (APNs) or 'android' (FCM) — lets the relay route the token to the right service. */
  platform?: string;
  /**
   * APNs environment the token belongs to: 'sandbox' for Xcode/dev-signed installs,
   * 'production' for TestFlight/App Store. Omitted when unknown (server defaults to production).
   */
  environment?: 'sandbox' | 'production';
}

export interface PushAPI {
  getVapidPublicKey(): Promise<{ publicKey: string } | null>;
  subscribe(payload: PushSubscribePayload): Promise<{ ok: true } | null>;
  unsubscribe(payload: PushUnsubscribePayload): Promise<{ ok: true } | null>;
  setVisibility(payload: { visible: boolean; platform?: string }): Promise<{ ok: true } | null>;
  /** Register a native iOS APNs device token (Capacitor mobile app only). */
  registerApnsToken(payload: ApnsTokenPayload): Promise<{ ok: true } | null>;
  unregisterApnsToken(payload: ApnsTokenPayload): Promise<{ ok: true } | null>;
}

export interface WorkspaceGitSummary {
  isRepository: boolean;
  branch: string | null;
  isClean: boolean;
  dirty?: number;
  ahead?: number;
  behind?: number;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  relativePath: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modifiedAt: string;
  mtimeMs: number;
  isProject?: boolean;
  git?: WorkspaceGitSummary | null;
  children?: WorkspaceEntry[];
}

export interface WorkspaceRootInfo {
  root: string;
  relativeRoot: string;
  exists: boolean;
  mtimeMs: number;
  limits: {
    maxReadBytes: number;
    maxUploadBytes: number;
    maxDownloadBytes?: number;
    maxDownloadFiles?: number;
    maxArchiveBytes?: number;
    maxExtractBytes?: number;
    maxExtractFiles?: number;
    archivePreviewLimit?: number;
  };
  features: {
    lockdown: boolean;
    trash: boolean;
    customCommands: boolean;
  };
  separator: string;
}

export interface WorkspaceListResult {
  path: string;
  relativePath: string;
  entries: WorkspaceEntry[];
}

export interface WorkspaceMutationResult {
  success: boolean;
  entry: WorkspaceEntry;
}

export interface WorkspaceDeleteResult {
  success: boolean;
  trashed: boolean;
  trashPath?: string;
}

export type WorkspaceUploadFile = File | {
  name: string;
  contentBase64: string;
};

export interface WorkspaceUploadResult {
  success: boolean;
  entries: WorkspaceEntry[];
}

export interface WorkspaceProjectOpenResult {
  success: boolean;
  project: ProjectEntry;
  settings: SettingsPayload;
}

export type WorkspaceGitStatus = GitStatus & {
  isGitRepository?: boolean;
};

export interface WorkspaceGitCloneOptions {
  url: string;
  branch?: string;
  directoryName?: string;
}

export interface WorkspaceGitCloneResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  directoryName?: string | null;
}

export interface WorkspaceArchivePreviewEntry {
  path: string;
  type: 'file' | 'directory';
  size: number;
}

export interface WorkspaceArchivePreview {
  archive: WorkspaceEntry;
  format: 'zip' | 'tar' | 'tgz';
  entries: WorkspaceArchivePreviewEntry[];
  totalFiles: number;
  totalDirectories: number;
  totalBytes: number;
  truncated: boolean;
}

export interface WorkspaceArchiveExtractRequest {
  path: string;
  destination: string;
  mode: 'new-folder' | 'merge';
  conflict: 'rename' | 'skip' | 'error';
  deleteArchive?: boolean;
}

export interface WorkspaceArchiveExtractResult {
  success: true;
  destination: string;
  destinationEntry: WorkspaceEntry;
  filesCreated: number;
  directoriesCreated: number;
  bytesExtracted?: number;
  archiveDeleted?: boolean;
  bytesWritten?: number;
  conflictsRenamed?: number;
  conflictsSkipped?: number;
  deletedArchive?: boolean;
}

export interface WorkspaceAPI {
  getRoot(): Promise<WorkspaceRootInfo>;
  list(path?: string): Promise<WorkspaceListResult>;
  tree(path?: string, depth?: number): Promise<WorkspaceListResult>;
  entry(path: string): Promise<WorkspaceEntry>;
  createFolder(path: string): Promise<WorkspaceMutationResult>;
  createFile(path: string, content?: string): Promise<WorkspaceMutationResult>;
  move(from: string, to: string): Promise<WorkspaceMutationResult>;
  deleteEntry(path: string, options?: { permanent?: boolean }): Promise<WorkspaceDeleteResult>;
  upload(path: string, files: WorkspaceUploadFile[]): Promise<WorkspaceUploadResult>;
  download(path: string): Promise<void>;
  previewArchive(path: string): Promise<WorkspaceArchivePreview>;
  extractArchive(request: WorkspaceArchiveExtractRequest): Promise<WorkspaceArchiveExtractResult>;
  openProject(path: string): Promise<WorkspaceProjectOpenResult>;
  gitStatus(path: string, options?: { mode?: 'light' }): Promise<WorkspaceGitStatus>;
  gitFetch(path: string, options?: { remote?: string; branch?: string }): Promise<{ success: boolean }>;
  gitClone(path: string, options: WorkspaceGitCloneOptions): Promise<WorkspaceGitCloneResult>;
  gitPull(path: string, options?: { remote?: string; branch?: string }): Promise<GitPullResult>;
  gitPush(path: string, options?: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> }): Promise<GitPushResult>;
  gitCheckout(path: string, branch: string): Promise<{ success: boolean; branch: string }>;
  gitCommit(path: string, message: string, options?: CreateGitCommitOptions): Promise<GitCommitResult>;
  gitLog(path: string, options?: GitLogOptions): Promise<GitLogResponse>;
  gitRemotes(path: string): Promise<GitRemote[]>;
}

export interface CheckpointRecord {
  id: string;
  sessionId: string;
  messageId: string;
  directory: string;
  createdAt: number;
  label?: string;
  phase: 'before-message' | 'before-restore' | 'manual';
  backupDir: string;
  type: 'full' | 'incremental';
  baseCheckpointId?: string;
  changes?: Array<{
    path: string;
    type: 'added' | 'modified' | 'deleted';
    hash?: string;
  }>;
  fileCount: number;
  totalBytes: number;
  contentHash: string;
  hasFileHashes: boolean;
}

export interface CheckpointChangedFile {
  path: string;
  type: 'added' | 'modified' | 'deleted';
}

export interface CheckpointRestoreResult {
  success: boolean;
  restored: number;
  deleted: number;
  skipped: number;
  safetyCheckpoint?: CheckpointRecord;
}

export interface CheckpointRestoreReviewResult {
  restore: boolean;
  cancelled?: boolean;
  changedCount: number;
  openedDiff?: boolean;
}

export interface CheckpointCleanupResult {
  deletedCheckpoints: number;
  deletedSessions: number;
  deletedBytes: number;
  remainingCheckpoints: number;
}

export interface CheckpointStorageStats {
  sessionCount: number;
  checkpointCount: number;
  totalBytes: number;
  retentionLimit: number;
}

export interface CheckpointsAPI {
  create(input: {
    sessionId: string;
    messageId: string;
    directory: string;
    label?: string;
    phase?: CheckpointRecord['phase'];
  }): Promise<CheckpointRecord | null>;
  getForMessage(input: {
    sessionId: string;
    messageId: string;
    directory?: string;
  }): Promise<CheckpointRecord | null>;
  list(sessionId: string): Promise<CheckpointRecord[]>;
  diff(input: { sessionId: string; checkpointId: string }): Promise<{ files: CheckpointChangedFile[] }>;
  openFileDiff(input: { sessionId: string; checkpointId: string; filePath: string }): Promise<void>;
  reviewRestore?(input: { sessionId: string; checkpointId: string }): Promise<CheckpointRestoreReviewResult>;
  restore(input: {
    sessionId: string;
    checkpointId: string;
    createSafetyCheckpoint?: boolean;
  }): Promise<CheckpointRestoreResult>;
  stats?(): Promise<CheckpointStorageStats>;
  cleanupSession?(sessionId: string): Promise<CheckpointCleanupResult>;
  cleanupRetention?(limit?: number): Promise<CheckpointCleanupResult>;
  cleanupAll?(): Promise<CheckpointCleanupResult>;
}

export interface MobileDevice {
  id: string;
  name: string;
  platform: 'ios' | 'android' | 'unknown';
  appVersion?: string | null;
  pushProvider?: string | null;
  pushEnabled: boolean;
  enabled: boolean;
  createdAt: number;
  lastSeenAt?: number | null;
  lastPushSuccessAt?: number | null;
  lastPushFailureAt?: number | null;
}

export interface MobilePairStartResult {
  pairingToken: string;
  expiresAt: number;
  serverUrl: string | null;
  qrPayload: {
    serverUrl: string | null;
    pairingToken: string;
  };
}

export interface MobileTestPushResult {
  ok: boolean;
  sent?: number;
  failed?: number;
  reason?: string;
}

export interface MobileAPI {
  startPairing(payload?: { serverUrl?: string }): Promise<MobilePairStartResult | null>;
  listDevices(): Promise<{ devices: MobileDevice[] } | null>;
  deleteDevice(deviceId: string): Promise<{ ok: true; deleted: boolean } | null>;
  sendTestPush(deviceId: string): Promise<MobileTestPushResult | null>;
}

export type GitHubUserSummary = {
  login: string;
  id?: number;
  avatarUrl?: string;
  name?: string;
  email?: string;
};

type GitHubRepoRef = {
  owner: string;
  repo: string;
  url: string;
};

export type GitHubChecksSummary = {
  state: 'success' | 'failure' | 'pending' | 'unknown';
  total: number;
  success: number;
  failure: number;
  /** queued + in_progress + unconcluded runs. */
  pending: number;
  inProgress?: number;
  queued?: number;
  /** Earliest started_at among in-progress runs (ISO), for elapsed display. */
  startedAt?: string;
};

export type GitHubCheckRun = {
  id?: number;
  name: string;
  startedAt?: string;
  completedAt?: string;
  app?: {
    name?: string;
    slug?: string;
  };
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string;
  output?: {
    title?: string;
    summary?: string;
    text?: string;
  };
  job?: {
    runId?: number;
    jobId?: number;
    url?: string;
    name?: string;
    workflowName?: string;
    conclusion?: string | null;
    steps?: Array<{
      name: string;
      status?: string;
      conclusion?: string | null;
      number?: number;
      startedAt?: string;
      completedAt?: string;
    }>;
  };
  annotations?: Array<{
    path?: string;
    startLine?: number;
    endLine?: number;
    level?: string;
    message: string;
    title?: string;
    rawDetails?: string;
  }>;
};

export type GitHubPullRequest = {
  number: number;
  title: string;
  body?: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  base: string;
  head: string;
  headSha?: string;
  mergeable?: boolean | null;
  mergeableState?: string | null;
};

type GitHubPullRequestHeadRepo = {
  owner: string;
  repo: string;
  url: string;
  cloneUrl?: string;
  sshUrl?: string;
};

export type GitHubPullRequestSummary = GitHubPullRequest & {
  author?: GitHubUserSummary | null;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
  headLabel?: string;
  headRepo?: GitHubPullRequestHeadRepo | null;
  sourceRepo?: (GitHubRepoSelector & { source: string }) | null;
};

type GitHubPullRequestFile = {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
};

type GitHubPullRequestReviewComment = {
  id: number;
  url: string;
  body: string;
  author?: GitHubUserSummary | null;
  path?: string;
  line?: number | null;
  position?: number | null;
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubPullRequestsListResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  prs?: GitHubPullRequestSummary[];
  page?: number;
  hasMore?: boolean;
};

export type GitHubPullRequestContextResult = {
  connected: boolean;
  /** Server-side stamp of when the data was fetched from GitHub (ms epoch); survives server cache serves. */
  fetchedAt?: number;
  repo?: GitHubRepoRef | null;
  pr?: GitHubPullRequestSummary | null;
  issueComments?: GitHubIssueComment[];
  reviewComments?: GitHubPullRequestReviewComment[];
  files?: GitHubPullRequestFile[];
  diff?: string;
  checks?: GitHubChecksSummary | null;
  checkRuns?: GitHubCheckRun[];
};

export type GitHubPullRequestStatus = {
  connected: boolean;
  /** Server-side stamp of when the data was fetched from GitHub (ms epoch); survives server cache serves. */
  fetchedAt?: number;
  repo?: GitHubRepoRef | null;
  branch?: string;
  pr?: GitHubPullRequest | null;
  checks?: GitHubChecksSummary | null;
  canMerge?: boolean;
  defaultBranch?: string | null;
  resolvedRemoteName?: string | null;
};

export type GitHubPullRequestCreateInput = {
  directory: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
  /** Remote to create the PR against (target repo, e.g., 'upstream' for forks) */
  remote?: string;
  /** Remote where the head branch lives (source repo, e.g., 'origin' for forks) */
  headRemote?: string;
  /** Explicit target repo (alternative to remote, for auto-detected upstream) */
  targetRepo?: { owner: string; repo: string };
};

export type GitHubPullRequestUpdateInput = {
  directory: string;
  number: number;
  title: string;
  body?: string;
};

export type GitHubPullRequestMergeInput = {
  directory: string;
  number: number;
  method: 'merge' | 'squash' | 'rebase';
};

export type GitHubPullRequestReadyInput = {
  directory: string;
  number: number;
};

export type GitHubPullRequestReadyResult = {
  ready: boolean;
};

export type GitHubPullRequestMergeResult = {
  merged: boolean;
  message?: string;
};

type GitHubIssueLabel = {
  name: string;
  color?: string;
};

export type GitHubRepoSelector = {
  owner: string;
  repo: string;
};

export type GitHubIssueSummary = {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  author?: GitHubUserSummary | null;
  labels?: GitHubIssueLabel[];
  sourceRepo?: (GitHubRepoSelector & { source: string }) | null;
};

export type GitHubIssue = GitHubIssueSummary & {
  body?: string;
  assignees?: GitHubUserSummary[];
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubIssueComment = {
  id: number;
  url: string;
  body: string;
  author?: GitHubUserSummary | null;
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubIssuesListResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  issues?: GitHubIssueSummary[];
  page?: number;
  hasMore?: boolean;
};

export type GitHubRepoUpstreamResult = {
  connected: boolean;
  isFork: boolean;
  upstream: { owner: string; repo: string; url: string; defaultBranch: string; defaultBranchSha: string | null; remoteName: string | null } | null;
};

export type GitHubIssueGetResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  issue?: GitHubIssue | null;
};

export type GitHubIssueCommentsResult = {
  connected: boolean;
  repo?: GitHubRepoRef | null;
  comments?: GitHubIssueComment[];
};

export type GitHubAuthStatus = {
  connected: boolean;
  user?: GitHubUserSummary | null;
  scope?: string;
  accounts?: GitHubAuthAccount[];
  ghCli?: {
    available: boolean;
    disabled: boolean;
    active: boolean;
    user?: GitHubUserSummary | null;
  } | null;
};

type GitHubAuthAccount = {
  id: string;
  user: GitHubUserSummary;
  scope?: string;
  current?: boolean;
  source?: 'oauth' | 'gh-cli';
};

export type GitHubDeviceFlowStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
  scope?: string;
};

export type GitHubDeviceFlowComplete =
  | { connected: true; user: GitHubUserSummary; scope?: string }
  | { connected: false; status?: string; error?: string };

export type GitHubTerminalAuthResult = {
  success: boolean;
  ghConfigPath: string;
  helperPath: string;
  gitCredentialHelperConfigured: boolean;
  gitCredentialHelperError?: string;
};

export type GitHubGitAuthorResult = {
  success: boolean;
  userName: string;
  userEmail: string;
};

export interface GitHubAPI {
  authStatus(): Promise<GitHubAuthStatus>;
  authStart(): Promise<GitHubDeviceFlowStart>;
  authComplete(deviceCode: string): Promise<GitHubDeviceFlowComplete>;
  authDisconnect(): Promise<{ removed: boolean }>;
  authActivate(accountId: string): Promise<GitHubAuthStatus>;
  authSetGhCliDisabled(disabled: boolean): Promise<{ disabled: boolean }>;
  authSyncTerminal(options?: { configureGit?: boolean }): Promise<GitHubTerminalAuthResult>;
  authConfigureGitAuthor(): Promise<GitHubGitAuthorResult>;
  me?(): Promise<GitHubUserSummary>;

  prStatus(directory: string, branch: string, remote?: string, options?: { force?: boolean }): Promise<GitHubPullRequestStatus>;
  prCreate(payload: GitHubPullRequestCreateInput): Promise<GitHubPullRequest>;
  prUpdate(payload: GitHubPullRequestUpdateInput): Promise<GitHubPullRequest>;
  prMerge(payload: GitHubPullRequestMergeInput): Promise<GitHubPullRequestMergeResult>;
  prReady(payload: GitHubPullRequestReadyInput): Promise<GitHubPullRequestReadyResult>;

  prsList(directory: string, options?: { page?: number; query?: string }): Promise<GitHubPullRequestsListResult>;
  prContext(
    directory: string,
    number: number,
    options?: { includeDiff?: boolean; includeCheckDetails?: boolean; sourceRepo?: GitHubRepoSelector | null }
  ): Promise<GitHubPullRequestContextResult>;

  issuesList(directory: string, options?: { page?: number; query?: string }): Promise<GitHubIssuesListResult>;
  issueGet(directory: string, number: number, options?: { sourceRepo?: GitHubRepoSelector | null }): Promise<GitHubIssueGetResult>;
  issueComments(directory: string, number: number, options?: { sourceRepo?: GitHubRepoSelector | null }): Promise<GitHubIssueCommentsResult>;
  repoUpstream(directory: string): Promise<GitHubRepoUpstreamResult>;
  repoBranches(owner: string, repo: string): Promise<string[]>;
}

export interface RemoteClientRecord {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt?: string | null;
  clientKind?: string | null;
  profile?: string | null;
  capabilities?: string[];
  allowedDirectories?: string[];
  authMethod?: string | null;
  /** Pairing session this client was created from, when authMethod is 'pairing'. */
  pairingId?: string | null;
  deviceName?: string | null;
  devicePlatform?: string | null;
  deviceModel?: string | null;
  appVersion?: string | null;
  usesRelay?: boolean;
  /** Transport that carried the device's most recent authenticated request. */
  lastTransport?: 'relay' | 'direct' | null;
}

// A pairing link that has been created but not yet redeemed by a device.
export interface PendingPairingRecord {
  id: string;
  label?: string;
  fingerprint?: string | null;
  expiresAt?: string;
  usesRelay?: boolean;
}

export interface RemoteClientCreateResult {
  client: RemoteClientRecord;
  token: string;
}

export interface RemoteClientRevokeResult {
  revoked: boolean;
  client?: RemoteClientRecord;
}

export interface RemoteClientPurgeRevokedResult {
  purged: number;
}

export interface PairingSessionCreateResult {
  pairing: {
    id: string;
    label?: string;
    fingerprint?: string | null;
    expiresAt?: string;
    secret: string;
  };
  server: {
    label: string;
    // Transport candidates for the pairing-v2 payload. Shape matches
    // PairingEndpointCandidate in `@/lib/connectionPayload` (direct lan/tunnel or
    // relay); left as a structural type here so this contract file stays leaf.
    candidates: Array<Record<string, unknown>>;
  };
}

export interface ClientAuthAPI {
  listClients(): Promise<RemoteClientRecord[]>;
  createClient(input?: {
    label?: string;
    expiresAt?: string | null;
    clientKind?: string | null;
    dedupeKey?: string | null;
    profile?: string | null;
    capabilities?: string[];
    allowedDirectories?: string[];
  }): Promise<RemoteClientCreateResult>;
  // Creates a one-time pairing session (pairing v2). `serverUrl` is the
  // externally reachable URL to advertise as the direct candidate (the desktop
  // UI talks to its server over loopback, so it must supply the LAN URL); the
  // server folds in a relay candidate when its relay host is enabled.
  createPairingSession(input?: {
    label?: string;
    allowedClientKinds?: Array<'mobile' | 'desktop'>;
    serverUrl?: string;
    // Per-link transport choice. `includeRelay: true` adds the relay candidate
    // and enables the relay host on demand; `false` omits it; omitted keeps the
    // legacy "relay only if already enabled" behavior. `includeDirect: false`
    // produces a relay-only link (no direct candidate).
    includeRelay?: boolean;
    includeDirect?: boolean;
  }): Promise<PairingSessionCreateResult>;
  purgeRevokedClients(): Promise<RemoteClientPurgeRevokedResult>;
  revokeClient(id: string): Promise<RemoteClientRevokeResult>;
  // Pairing links created but not yet redeemed (the "pending devices" list).
  listPendingPairings(): Promise<PendingPairingRecord[]>;
  cancelPairing(id: string): Promise<{ cancelled: boolean }>;
  // Direct transports the server can be reached on, for the create-device dialog.
  // LAN reflects the server's actual bind, independent of the UI origin.
  getPairingTransports(): Promise<{ local: string | null; lan: string | null; relayAvailable: boolean }>;
}

export type SmartSearchConfigValueSource = 'default' | 'environment' | 'config_file';

export interface SmartSearchConfigValue {
  key: string;
  isSet: boolean;
  value?: string;
  maskedValue?: string;
  secret: boolean;
  source: SmartSearchConfigValueSource;
  editable: boolean;
}

export interface SmartSearchPathInfo {
  ok?: boolean;
  binary?: string;
  config_file?: string;
  config_dir?: string;
  config_dir_source?: string;
  error?: string;
}

export interface SmartSearchConfigResponse {
  ok: boolean;
  path?: SmartSearchPathInfo;
  values: Record<string, SmartSearchConfigValue>;
}

export interface SmartSearchConfigPatch {
  set?: Record<string, string>;
  unset?: string[];
}

export interface SmartSearchStatusResponse {
  ok: boolean;
  available: boolean;
  binary: string;
  version?: string;
  path?: SmartSearchPathInfo;
  error?: string;
}

export interface SmartSearchDoctorResponse {
  ok: boolean;
  exitCode?: number | null;
  signal?: string | null;
  result?: unknown;
  stderr?: string;
}

export interface SmartSearchAPI {
  status(): Promise<SmartSearchStatusResponse>;
  loadConfig(): Promise<SmartSearchConfigResponse>;
  saveConfig(patch: SmartSearchConfigPatch): Promise<SmartSearchConfigResponse>;
  doctor(): Promise<SmartSearchDoctorResponse>;
}

export interface ExtensionsAPI {
  activateExtension(extensionId: string): Promise<void>;
  catalog(): Promise<PiariumExtensionCatalogAvailability>;
  discardPreparedCandidate(extensionId: string, candidateIntegrity: string): Promise<void>;
  discardCandidate(request: PiariumExtensionCandidateSelectionRequest): Promise<PiariumExtensionCatalogSnapshot>;
  hostState(): Promise<PiariumExtensionHostStateSnapshot>;
  install(request: PiariumExtensionPackageInstallRequest): Promise<PiariumExtensionCatalogSnapshot>;
  invokeService(request: PiariumExtensionServiceInvocationRequest): Promise<JsonValue>;
  prepareCandidate(extensionId: string, candidateIntegrity: string): Promise<PiariumExtensionCandidatePreparationResult>;
  requestCandidateApplication(request: PiariumExtensionCandidateSelectionRequest): Promise<PiariumExtensionCatalogSnapshot>;
  readAsset(request: PiariumExtensionAssetRequest): Promise<PiariumExtensionAssetPayload>;
  readManagedEntrypoint(request: PiariumExtensionManagedEntrypointRequest): Promise<PiariumExtensionManagedEntrypointPayload>;
  reloadLocalSource(request: PiariumExtensionLocalSourceReloadRequest): Promise<PiariumExtensionLocalSourceReloadResult>;
  reportActualState(extensionId: string, state: PiariumExtensionActualState): Promise<void>;
  reviewCapabilities(request: PiariumExtensionCapabilityReviewRequest): Promise<PiariumExtensionCatalogSnapshot>;
  reviewCandidateCapabilities(request: PiariumExtensionCandidateCapabilityReviewRequest): Promise<PiariumExtensionCatalogSnapshot>;
  selectCandidate(request: PiariumExtensionCandidateSelectionRequest): Promise<PiariumExtensionCatalogSnapshot>;
  setEnabled(extensionId: string, enabled: boolean, expectedRevision: number): Promise<PiariumExtensionCatalogSnapshot>;
  setServiceSelection(request: PiariumExtensionServiceSelectionRequest): Promise<PiariumExtensionHostStateSnapshot>;
  upsertServiceRoutingRule(request: PiariumExtensionServiceRoutingRuleUpdateRequest): Promise<PiariumExtensionServiceRoutingSnapshot>;
  removeServiceRoutingRule(request: PiariumExtensionServiceRoutingRuleRemoveRequest): Promise<PiariumExtensionServiceRoutingSnapshot>;
  removeExtension(request: PiariumExtensionRemoveRequest): Promise<PiariumExtensionCatalogSnapshot>;
  updateWorkbenchLayout(request: PiariumWorkbenchLayoutUpdateRequest): Promise<PiariumWorkbenchProfileSnapshot>;
  selectWorkbenchProfile(request: PiariumWorkbenchProfileSelectionRequest): Promise<PiariumWorkbenchProfileSnapshot>;
  upsertWorkbenchProfile(request: PiariumWorkbenchProfileUpsertRequest): Promise<PiariumWorkbenchProfileSnapshot>;
  removeWorkbenchProfile(request: PiariumWorkbenchProfileRemoveRequest): Promise<PiariumWorkbenchProfileSnapshot>;
  applyWorkbenchProfile(request: PiariumWorkbenchProfileApplyRequest): Promise<PiariumExtensionCatalogSnapshot>;
  waitForHostState(request: PiariumExtensionHostStateWaitRequest, signal?: AbortSignal): Promise<PiariumExtensionHostStateSnapshot>;
}

export interface PiRuntimeManagementCapabilities {
  install: boolean;
  openLocation: boolean;
  pickPackageRoot: boolean;
}

export interface PiRuntimeManagementAPI {
  activate(id: string): Promise<PiRuntimeSnapshot>;
  activateCustom(packageRoot: string, nodePath?: string): Promise<PiRuntimeSnapshot>;
  capabilities: PiRuntimeManagementCapabilities;
  getSnapshot(): Promise<PiRuntimeSnapshot>;
  install(): Promise<PiRuntimeSnapshot>;
  openLocation(targetPath: string): Promise<void>;
  pickPackageRoot(): Promise<string | null>;
  refresh(): Promise<PiRuntimeSnapshot>;
  subscribe(listener: (snapshot: PiRuntimeSnapshot) => void): () => void;
  upgrade(): Promise<PiRuntimeSnapshot>;
}

export interface PiariumWorkspaceIdentity {
  workspaceId: string;
  hostId: string;
  epoch: number;
}

export interface PiariumResourceReference {
  workspaceId: string;
  resourceId: string;
}

export interface WorkspaceMutationOwner {
  kind: string;
  id: string;
  generation?: number;
}

export interface WorkspaceMutationToken {
  workspaceId: string;
  epoch: number;
  owner: WorkspaceMutationOwner;
}

export type PiariumDocumentReadResult =
  | {
      status: 'ready';
      epoch: number;
      resource: PiariumResourceReference;
      revision: string;
      content: string;
      encoding: string;
      bom: boolean;
      byteLength: number;
      modifiedAt?: string;
    }
  | {
      status: 'missing';
      epoch: number;
      resource: PiariumResourceReference;
    }
  | {
      status: 'binary';
      epoch: number;
      resource: PiariumResourceReference;
      revision: string;
      byteLength: number;
      mime?: string;
    }
  | {
      status: 'unsupported-encoding';
      epoch: number;
      resource: PiariumResourceReference;
      revision: string;
      byteLength: number;
      candidates?: string[];
    };

export interface PiariumDocumentWriteRequest {
  token: WorkspaceMutationToken;
  resource: PiariumResourceReference;
  content: string;
  encoding: string;
  bom: boolean;
  expectedRevision: string | null;
  operationId: string;
}

export type PiariumDocumentWriteResult =
  | { status: 'written'; revision: string; byteLength: number; modifiedAt?: string }
  | { status: 'conflict'; current: Omit<PiariumDocumentReadResult, 'content'> }
  | { status: 'stale-epoch'; currentEpoch: number };

export interface PiariumDocumentMoveRequest {
  token: WorkspaceMutationToken;
  from: PiariumResourceReference;
  to: PiariumResourceReference;
  expectedRevision: string;
  operationId: string;
}

export type PiariumDocumentMoveResult =
  | { status: 'moved'; resource: PiariumResourceReference; revision: string; byteLength: number; modifiedAt?: string }
  | { status: 'missing'; resource: PiariumResourceReference }
  | { status: 'target-exists'; resource: PiariumResourceReference }
  | { status: 'conflict'; current: Omit<PiariumDocumentReadResult, 'content'> }
  | { status: 'stale-epoch'; currentEpoch: number };

export interface PiariumDocumentDeleteRequest {
  token: WorkspaceMutationToken;
  resource: PiariumResourceReference;
  expectedRevision: string;
  operationId: string;
}

export type PiariumDocumentDeleteResult =
  | { status: 'deleted'; resource: PiariumResourceReference }
  | { status: 'missing'; resource: PiariumResourceReference }
  | { status: 'conflict'; current: Omit<PiariumDocumentReadResult, 'content'> }
  | { status: 'stale-epoch'; currentEpoch: number };

type PiariumWorkspaceFileEventPosition = {
  sourceId: string;
  generation: number;
  sequence: number;
};

export type PiariumWorkspaceFileEvent = PiariumWorkspaceFileEventPosition & (
  | { kind: 'created' | 'changed' | 'deleted'; resource: PiariumResourceReference; revision?: string }
  | { kind: 'moved'; from: PiariumResourceReference; resource: PiariumResourceReference; revision?: string }
  | { kind: 'reset'; reason: 'overflow' | 'reconnected' | 'authority-changed' | 'gap' }
);

export interface PiariumDocumentRecoveryJournalSummary {
  journalId: string;
  resource: PiariumResourceReference;
  revision: number;
  baseRevision: string | null;
  epoch: number;
  updatedAt: string;
  byteLength: number;
}

export type PiariumDocumentRecoveryReadResult =
  | {
      status: 'ready';
      journal: PiariumDocumentRecoveryJournalSummary;
      content: string;
      encoding: string;
      bom: boolean;
    }
  | { status: 'missing'; journalId: string }
  | { status: 'malformed'; journalId: string };

export interface PiariumDocumentRecoveryWriteRequest {
  token: WorkspaceMutationToken;
  workspaceId: string;
  recoverySessionId: string;
  resource: PiariumResourceReference;
  content: string;
  encoding: string;
  bom: boolean;
  baseRevision: string | null;
  expectedRevision: number | null;
}

export type PiariumDocumentRecoveryWriteResult =
  | { status: 'written'; journal: PiariumDocumentRecoveryJournalSummary }
  | { status: 'conflict'; journal: PiariumDocumentRecoveryJournalSummary }
  | { status: 'missing'; journalId: string }
  | { status: 'stale-epoch'; currentEpoch: number };

export interface DocumentsAPI {
  resolveWorkspace(input: { path?: string; workspaceId?: string }): Promise<PiariumWorkspaceIdentity>;
  read(resource: PiariumResourceReference): Promise<PiariumDocumentReadResult>;
  write(request: PiariumDocumentWriteRequest): Promise<PiariumDocumentWriteResult>;
  move(request: PiariumDocumentMoveRequest): Promise<PiariumDocumentMoveResult>;
  delete(request: PiariumDocumentDeleteRequest): Promise<PiariumDocumentDeleteResult>;
  watch(
    workspaceId: string,
    listener: (event: PiariumWorkspaceFileEvent) => void,
    options?: { signal?: AbortSignal },
  ): Subscription;
  listRecoveryJournals(request: {
    workspaceId: string;
    recoverySessionId?: string;
  }): Promise<PiariumDocumentRecoveryJournalSummary[]>;
  readRecoveryJournal(journalId: string): Promise<PiariumDocumentRecoveryReadResult>;
  writeRecoveryJournal(request: PiariumDocumentRecoveryWriteRequest): Promise<PiariumDocumentRecoveryWriteResult>;
  deleteRecoveryJournal(request: {
    token: WorkspaceMutationToken;
    journalId: string;
    expectedRevision: number;
  }): Promise<
    | { status: 'deleted' }
    | { status: 'missing' }
    | { status: 'conflict'; journal: PiariumDocumentRecoveryJournalSummary }
    | { status: 'stale-epoch'; currentEpoch: number }
  >;
}

export type WorkspaceContentSearchHit = {
  resource: PiariumResourceReference;
  line: number;
  column: number;
  preview: string;
};

export type WorkspaceContentSearchResult =
  | { status: 'ready'; generation: number; hits: WorkspaceContentSearchHit[] }
  | { status: 'empty'; generation: number }
  | { status: 'cancelled'; generation: number }
  | { status: 'failure'; generation: number; message: string };

export interface WorkspaceContentSearchRequest {
  workspaceId: string;
  query: string;
  maxResults?: number;
  includeHidden?: boolean;
}

export interface WorkspaceSearchAPI {
  searchContent(
    request: WorkspaceContentSearchRequest,
    options?: {
      signal?: AbortSignal;
      onBatch?: (hits: WorkspaceContentSearchHit[]) => void;
    },
  ): Promise<WorkspaceContentSearchResult>;
}

export type PiariumLanguageProviderFeatures = {
  completionTriggerCharacters?: string[];
  signatureHelpTriggerCharacters?: string[];
  signatureHelpRetriggerCharacters?: string[];
  onTypeFormattingTriggerCharacters?: string[];
};

export type PiariumLanguageProviderStatus =
  | { status: 'absent'; workspaceId: string; languageId: string; providerId?: string; generation?: number }
  | { status: 'starting'; workspaceId: string; languageId: string; providerId: string; generation: number }
  | { status: 'ready'; workspaceId: string; languageId: string; providerId: string; generation: number; features?: PiariumLanguageProviderFeatures }
  | { status: 'degraded'; workspaceId: string; languageId: string; providerId: string; generation: number; message: string; features?: PiariumLanguageProviderFeatures }
  | { status: 'failed'; workspaceId: string; languageId: string; providerId: string; generation: number; message: string };

export type PiariumLanguagePosition = {
  line: number;
  character: number;
};

export type PiariumLanguageRange = {
  start: PiariumLanguagePosition;
  end: PiariumLanguagePosition;
};

export type PiariumLanguageCompletionItem = {
  label: string;
  kind?: number;
  detail?: string;
  insertText?: string;
  insertTextFormat?: 'plain' | 'snippet';
  documentation?: PiariumLanguageMarkupContent;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  deprecated?: boolean;
  commitCharacters?: string[];
  tags?: number[];
  textEdit?: PiariumLanguageTextEdit | PiariumLanguageInsertReplaceEdit;
  additionalTextEdits?: PiariumLanguageTextEdit[];
  command?: PiariumLanguageCommand;
  resolveToken?: string;
};

export type PiariumLanguageLocation = {
  resource: PiariumResourceReference;
  range: PiariumLanguageRange;
};

export type PiariumLanguageLocationLink = {
  resource: PiariumResourceReference;
  targetRange: PiariumLanguageRange;
  targetSelectionRange: PiariumLanguageRange;
  originSelectionRange?: PiariumLanguageRange;
};

export type PiariumLanguageMarkupContent = {
  kind: 'plaintext' | 'markdown';
  value: string;
};

export type PiariumLanguageCommand = {
  title: string;
  command: string;
  arguments?: JsonValue[];
};

export type PiariumLanguageTextEdit = {
  range: PiariumLanguageRange;
  newText: string;
  annotationId?: string;
};

export type PiariumLanguageInsertReplaceEdit = {
  insert: PiariumLanguageRange;
  replace: PiariumLanguageRange;
  newText: string;
};

export type PiariumLanguageHover = {
  contents: PiariumLanguageMarkupContent[];
  range?: PiariumLanguageRange;
};

export type PiariumLanguageSignatureParameter = {
  label: string | [number, number];
  documentation?: PiariumLanguageMarkupContent;
};

export type PiariumLanguageSignatureInformation = {
  label: string;
  documentation?: PiariumLanguageMarkupContent;
  parameters: PiariumLanguageSignatureParameter[];
  activeParameter?: number;
};

export type PiariumLanguageSignatureHelp = {
  signatures: PiariumLanguageSignatureInformation[];
  activeSignature: number;
  activeParameter: number;
};

export type PiariumLanguageSymbol = {
  name: string;
  kind: number;
  range: PiariumLanguageRange;
  selectionRange?: PiariumLanguageRange;
  detail?: string;
  containerName?: string;
  tags?: number[];
  resource?: PiariumResourceReference;
  children?: PiariumLanguageSymbol[];
};

export type PiariumLanguageWorkspaceDocumentEdit = {
  kind: 'text';
  resource: PiariumResourceReference;
  version: number | null;
  edits: PiariumLanguageTextEdit[];
};

export type PiariumLanguageWorkspaceResourceOperation =
  | { kind: 'create'; resource: PiariumResourceReference; annotationId?: string; overwrite?: boolean; ignoreIfExists?: boolean }
  | { kind: 'rename'; from: PiariumResourceReference; to: PiariumResourceReference; annotationId?: string; overwrite?: boolean; ignoreIfExists?: boolean }
  | { kind: 'delete'; resource: PiariumResourceReference; annotationId?: string; recursive?: boolean; ignoreIfNotExists?: boolean };

export type PiariumLanguageWorkspaceEdit = {
  documentChanges: Array<PiariumLanguageWorkspaceDocumentEdit | PiariumLanguageWorkspaceResourceOperation>;
  changeAnnotations?: Record<string, { label: string; description?: string; needsConfirmation?: boolean }>;
};

export type PiariumLanguageCodeAction = {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  diagnostics?: PiariumLanguageDiagnostic[];
  disabledReason?: string;
  edit?: PiariumLanguageWorkspaceEdit;
  command?: PiariumLanguageCommand;
  resolveToken?: string;
};

export type PiariumLanguageSemanticTokens = {
  data: number[];
  resultId?: string;
  legend: {
    tokenTypes: string[];
    tokenModifiers: string[];
  };
};

export type PiariumLanguageInlayHintLabelPart = {
  value: string;
  tooltip?: PiariumLanguageMarkupContent;
  location?: PiariumLanguageLocation;
  command?: PiariumLanguageCommand;
};

export type PiariumLanguageInlayHint = {
  position: PiariumLanguagePosition;
  label: string | PiariumLanguageInlayHintLabelPart[];
  kind?: 'type' | 'parameter';
  tooltip?: PiariumLanguageMarkupContent;
  textEdits?: PiariumLanguageTextEdit[];
  paddingLeft?: boolean;
  paddingRight?: boolean;
  resolveToken?: string;
};

export type PiariumLanguageDocumentHighlight = {
  range: PiariumLanguageRange;
  kind?: 'text' | 'read' | 'write';
};

export type PiariumLanguageFoldingRange = {
  startLine: number;
  endLine: number;
  startCharacter?: number;
  endCharacter?: number;
  kind?: 'comment' | 'imports' | 'region';
};

export type PiariumLanguageSelectionRange = {
  range: PiariumLanguageRange;
  parent?: PiariumLanguageSelectionRange;
};

export type PiariumLanguageDocumentLinkTarget =
  | { kind: 'resource'; resource: PiariumResourceReference; range?: PiariumLanguageRange }
  | { kind: 'uri'; uri: string };

export type PiariumLanguageDocumentLink = {
  range: PiariumLanguageRange;
  target?: PiariumLanguageDocumentLinkTarget;
  tooltip?: string;
  resolveToken?: string;
};

export type PiariumLanguageColor = { red: number; green: number; blue: number; alpha: number };

export type PiariumLanguageColorInformation = {
  range: PiariumLanguageRange;
  color: PiariumLanguageColor;
};

export type PiariumLanguageColorPresentation = {
  label: string;
  textEdit?: PiariumLanguageTextEdit;
  additionalTextEdits?: PiariumLanguageTextEdit[];
};

export type PiariumLanguageFeatureResult<T> =
  | { status: 'ready'; documentVersion: number; providerId: string; generation: number; value: T }
  | { status: 'stale'; documentVersion: number; providerId?: string; generation?: number }
  | { status: 'absent'; workspaceId?: string; languageId?: string }
  | {
      status: 'failed';
      message: string;
      reason?: 'provider-failed' | 'request-failed' | 'unsupported' | 'untrusted';
      providerId?: string;
      generation?: number;
    };

export interface PiariumLanguageCommandRequest {
  resource: PiariumResourceReference;
  languageId: string;
  documentVersion: number;
  providerId: string;
  generation: number;
  command: string;
  arguments?: JsonValue[];
}

export interface PiariumLanguageDocumentSyncRequest {
  resource: PiariumResourceReference;
  languageId: string;
  documentVersion: number;
  reason: 'open' | 'change' | 'save' | 'close';
  content?: string;
  changes?: Array<{ from: number; to: number; insert: string }>;
}

export type PiariumLanguageDocumentSyncResult =
  | { status: 'synced'; documentVersion: number; providerId: string; generation: number }
  | { status: 'absent' }
  | { status: 'stale'; documentVersion: number }
  | { status: 'failed'; message: string };

export type PiariumLanguageDiagnostic = {
  resource: PiariumResourceReference;
  documentVersion: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  range: PiariumLanguageRange;
  code?: string | number;
  source?: string;
  tags?: number[];
  relatedInformation?: Array<{ location: PiariumLanguageLocation; message: string }>;
  providerId?: string;
  generation?: number;
};

export type PiariumLanguageServiceEvent =
  | { kind: 'status'; snapshot: PiariumLanguageProviderStatus }
  | {
      kind: 'diagnostics';
      workspaceId: string;
      languageId: string;
      resourceId: string;
      providerId: string;
      generation: number;
      items: PiariumLanguageDiagnostic[];
    };

export interface PiariumLanguageFeatureRequest {
  resource: PiariumResourceReference;
  languageId: string;
  documentVersion: number;
  position?: PiariumLanguagePosition;
  range?: PiariumLanguageRange;
  newName?: string;
  query?: string;
  triggerCharacter?: string;
  triggerKind?: 'invoked' | 'triggerCharacter' | 'incomplete';
  resolveToken?: string;
  positions?: PiariumLanguagePosition[];
  previousResultId?: string;
  color?: PiariumLanguageColor;
  diagnostics?: PiariumLanguageDiagnostic[];
  formatting?: {
    tabSize: number;
    insertSpaces: boolean;
    trimTrailingWhitespace?: boolean;
    insertFinalNewline?: boolean;
    trimFinalNewlines?: boolean;
  };
}

export interface LanguageServicesAPI {
  getStatus(workspaceId: string, languageId: string): Promise<PiariumLanguageProviderStatus>;
  subscribe(
    workspaceId: string,
    listener: (event: PiariumLanguageServiceEvent) => void,
    options?: { signal?: AbortSignal },
  ): Subscription;
  syncDocument(request: PiariumLanguageDocumentSyncRequest): Promise<PiariumLanguageDocumentSyncResult>;
  completion(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageCompletionItem[]>>;
  completionResolve(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageCompletionItem>>;
  hover(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageHover | null>>;
  signatureHelp(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageSignatureHelp | null>>;
  definition(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageLocationLink[]>>;
  references(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageLocation[]>>;
  documentSymbols(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageSymbol[]>>;
  workspaceSymbols(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageSymbol[]>>;
  rename(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageWorkspaceEdit | null>>;
  codeActions(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageCodeAction[]>>;
  codeActionResolve(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageCodeAction>>;
  executeCommand(request: PiariumLanguageCommandRequest): Promise<PiariumLanguageFeatureResult<JsonValue | null>>;
  documentFormatting(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageTextEdit[]>>;
  documentRangeFormatting(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageTextEdit[]>>;
  onTypeFormatting(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageTextEdit[]>>;
  semanticTokens(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageSemanticTokens | null>>;
  inlayHints(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageInlayHint[]>>;
  inlayHintResolve(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageInlayHint>>;
  documentHighlights(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageDocumentHighlight[]>>;
  foldingRanges(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageFoldingRange[]>>;
  selectionRanges(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageSelectionRange[]>>;
  documentLinks(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageDocumentLink[]>>;
  documentLinkResolve(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageDocumentLink>>;
  documentColors(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageColorInformation[]>>;
  colorPresentations(request: PiariumLanguageFeatureRequest): Promise<PiariumLanguageFeatureResult<PiariumLanguageColorPresentation[]>>;
  restart(workspaceId: string, languageId: string): Promise<PiariumLanguageProviderStatus>;
  disposeWorkspace(workspaceId: string): Promise<void>;
}

export type PiariumTaskConfigurationType = 'node' | 'process' | 'npm';

export type PiariumTaskConfiguration = {
  id: string;
  label: string;
  type: PiariumTaskConfigurationType;
  script?: string;
  command?: string;
  args?: string[];
};

export type PiariumTaskListResult =
  | { status: 'ready'; workspaceId: string; configurations: PiariumTaskConfiguration[] }
  | { status: 'failure'; workspaceId: string; message: string; configurations: [] };

export type PiariumTaskRunStatus =
  | { status: 'running' | 'stopped' | 'failed'; workspaceId: string; runId?: string; taskId?: string; generation?: number; message?: string; exitCode?: number };

export type PiariumTaskEvent =
  | { kind: 'status'; snapshot: PiariumTaskRunStatus }
  | { kind: 'output'; runId: string; channel: string; text: string };

export interface WorkspaceTasksAPI {
  list(workspaceId: string): Promise<PiariumTaskListResult>;
  run(request: { workspaceId: string; taskId: string }): Promise<PiariumTaskRunStatus>;
  cancel(request: { workspaceId: string; runId: string }): Promise<PiariumTaskRunStatus>;
  subscribe(
    workspaceId: string,
    listener: (event: PiariumTaskEvent) => void,
    options?: { signal?: AbortSignal },
  ): Subscription;
  disposeWorkspace(workspaceId: string): Promise<void>;
}

export type PiariumDebugSessionStatus =
  | { status: 'absent'; workspaceId: string; message?: string }
  | {
      status: 'starting' | 'running' | 'paused' | 'stopped' | 'failed';
      workspaceId: string;
      sessionId?: string;
      generation?: number;
      adapterId?: string;
      message?: string;
      reason?: string;
    };

export type PiariumBreakpoint = {
  resourceId: string;
  line: number;
};

export type PiariumDebugBreakpointMutationRequest = {
  workspaceId: string;
  resourceId: string;
  lines: number[];
} & (
  | { expectedSessionId: string; expectedGeneration: number }
  | { expectedSessionId: null; expectedGeneration: null }
);

export type PiariumDebugBreakpointsResult = {
  status: 'ready' | 'stale';
  workspaceId: string;
  sessionId?: string;
  generation?: number;
  breakpoints: PiariumBreakpoint[];
};

export type PiariumDebugBreakpointListResult = PiariumDebugBreakpointsResult & {
  status: 'ready';
};

export type PiariumDebugThread = {
  id: number;
  name: string;
};

export type PiariumDebugStackFrame = {
  id: number;
  name: string;
  line: number;
  column: number;
  resourceId?: string;
};

export type PiariumDebugScope = {
  name: string;
  variablesReference: number;
};

export type PiariumDebugVariable = {
  name: string;
  value: string;
  variablesReference: number;
  type?: string;
};

export type PiariumDebugFeatureResult<T> =
  | { status: 'ready'; workspaceId: string; sessionId?: string; generation?: number; value: T }
  | { status: 'absent'; workspaceId?: string }
  | { status: 'failed'; workspaceId?: string; sessionId?: string; generation?: number; message: string };

export type PiariumDebugEvent =
  | { kind: 'status'; snapshot: PiariumDebugSessionStatus }
  | { kind: 'breakpoints'; snapshot: PiariumDebugBreakpointListResult }
  | { kind: 'output'; sessionId: string; channel: string; text: string };

export interface WorkspaceDebugAPI {
  getStatus(workspaceId: string): Promise<PiariumDebugSessionStatus>;
  listBreakpoints(workspaceId: string): Promise<PiariumDebugBreakpointListResult>;
  setBreakpoints(request: PiariumDebugBreakpointMutationRequest): Promise<PiariumDebugBreakpointsResult>;
  start(request: { workspaceId: string; program?: string; languageId?: string; adapterId?: string }): Promise<PiariumDebugSessionStatus>;
  stop(request: { workspaceId: string }): Promise<PiariumDebugSessionStatus>;
  continue(request: { workspaceId: string }): Promise<PiariumDebugSessionStatus>;
  pause(request: { workspaceId: string }): Promise<PiariumDebugSessionStatus>;
  stepOver(request: { workspaceId: string }): Promise<PiariumDebugSessionStatus>;
  stepIn(request: { workspaceId: string }): Promise<PiariumDebugSessionStatus>;
  stepOut(request: { workspaceId: string }): Promise<PiariumDebugSessionStatus>;
  getThreads(request: { workspaceId: string }): Promise<PiariumDebugFeatureResult<PiariumDebugThread[]>>;
  getStack(request: { workspaceId: string; threadId: number }): Promise<PiariumDebugFeatureResult<PiariumDebugStackFrame[]>>;
  getScopes(request: { workspaceId: string; frameId: number }): Promise<PiariumDebugFeatureResult<PiariumDebugScope[]>>;
  getVariables(request: { workspaceId: string; variablesReference: number }): Promise<PiariumDebugFeatureResult<PiariumDebugVariable[]>>;
  evaluate(request: { workspaceId: string; expression: string; frameId?: number }): Promise<PiariumDebugFeatureResult<string>>;
  listWatch(workspaceId: string): Promise<{ status: 'ready'; workspaceId: string; expressions: string[] }>;
  addWatch(request: { workspaceId: string; expression: string }): Promise<{ status: 'ready' | 'failed'; workspaceId: string; expressions?: string[]; message?: string }>;
  removeWatch(request: { workspaceId: string; expression: string }): Promise<{ status: 'ready'; workspaceId: string; expressions: string[] }>;
  subscribe(
    workspaceId: string,
    listener: (event: PiariumDebugEvent) => void,
    options?: { signal?: AbortSignal },
  ): Subscription;
  disposeWorkspace(workspaceId: string): Promise<void>;
}

export type PiariumTestItem = {
  id: string;
  label: string;
  resourceId?: string;
  line?: number;
  status?: 'running' | 'passed' | 'failed';
  message?: string;
  stack?: string;
};

export type PiariumTestDiscoverResult =
  | { status: 'ready' | 'empty' | 'absent'; workspaceId: string; tests: PiariumTestItem[] }
  | { status: 'failure'; workspaceId: string; message: string; tests: [] };

export type PiariumTestRunStatus =
  | { status: 'absent' | 'idle' | 'empty' | 'running' | 'stopped' | 'failed'; workspaceId: string; runId?: string; generation?: number; providerId?: string; message?: string };

export type PiariumTestEvent =
  | { kind: 'status'; snapshot: PiariumTestRunStatus }
  | { kind: 'test'; runId: string; generation: number; test: PiariumTestItem }
  | { kind: 'output'; channel: string; runId: string; generation: number; text: string }
  | { kind: 'finished'; runId: string; generation: number; results?: PiariumTestItem[] };

export interface WorkspaceTestAPI {
  discover(request: { workspaceId: string; providerId?: string }): Promise<PiariumTestDiscoverResult>;
  run(request: { workspaceId: string; testIds?: string[]; providerId?: string }): Promise<PiariumTestRunStatus>;
  cancel(request: { workspaceId: string }): Promise<PiariumTestRunStatus>;
  getStatus(workspaceId: string): Promise<PiariumTestRunStatus>;
  subscribe(
    workspaceId: string,
    listener: (event: PiariumTestEvent) => void,
    options?: { signal?: AbortSignal },
  ): Subscription;
  disposeWorkspace(workspaceId: string): Promise<void>;
}

export interface RuntimeAPIs {
  runtime: RuntimeDescriptor;
  piRuntime?: PiRuntimeManagementAPI;
  terminal: TerminalAPI;
  git: GitAPI;
  workspace?: WorkspaceAPI;
  files: FilesAPI;
  documents: DocumentsAPI;
  workspaceSearch: WorkspaceSearchAPI;
  language: LanguageServicesAPI;
  tasks: WorkspaceTasksAPI;
  debug: WorkspaceDebugAPI;
  tests: WorkspaceTestAPI;
  settings: SettingsAPI;
  permissions: PermissionsAPI;
  notifications: NotificationsAPI;
  checkpoints?: CheckpointsAPI;
  github?: GitHubAPI;
  push?: PushAPI;
  mobile?: MobileAPI;
  diagnostics?: DiagnosticsAPI;
  clientAuth?: ClientAuthAPI;
  smartSearch?: SmartSearchAPI;
  extensions: ExtensionsAPI;
  tools: ToolsAPI;
  editor?: EditorAPI;
  vscode?: VSCodeAPI;
  worktrees?: WorktreeMetadata[];
}

export type RuntimeAPISelector<TValue> = (apis: RuntimeAPIs) => TValue;

// ============== Skills Catalog Types ==============

type SkillsCatalogSourceId = string;

type SkillsCatalogSourceType = 'github' | 'clawdhub';

export interface SkillsCatalogSource {
  id: SkillsCatalogSourceId;
  label: string;
  description?: string;
  source: string;
  defaultSubpath?: string;
  sourceType?: SkillsCatalogSourceType;
}

interface SkillsCatalogItemInstalledBadge {
  isInstalled: boolean;
  scope?: 'user' | 'project';
  source?: 'opencode' | 'agents' | 'claude';
}

interface ClawdHubSkillMetadata {
  slug: string;
  version: string;
  displayName?: string;
  owner?: string;
  downloads?: number;
  stars?: number;
  versionsCount?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface SkillsCatalogItem {
  sourceId: SkillsCatalogSourceId;
  repoSource: string;
  repoSubpath?: string;
  gitIdentityId?: string;
  skillDir: string;
  skillName: string;
  frontmatterName?: string;
  description?: string;
  installable: boolean;
  warnings?: string[];
  installed?: SkillsCatalogItemInstalledBadge;
  /** ClawdHub-specific metadata (present only for ClawdHub sources) */
  clawdhub?: ClawdHubSkillMetadata;
}

export interface SkillsCatalogResponse {
  ok: boolean;
  sources?: SkillsCatalogSource[];
  itemsBySource?: Record<SkillsCatalogSourceId, SkillsCatalogItem[]>;
  pageInfoBySource?: Record<SkillsCatalogSourceId, { nextCursor?: string | null }>;
  error?: { kind: string; message: string };
}

export interface SkillsCatalogSourceResponse {
  ok: boolean;
  items?: SkillsCatalogItem[];
  nextCursor?: string | null;
  error?: { kind: string; message: string };
}

export interface SkillsRepoScanRequest {
  source: string;
  subpath?: string;
  gitIdentityId?: string;
}

type SkillsRepoScanError =
  | { kind: 'authRequired'; message: string; sshOnly: true; identities?: Array<{ id: string; name: string }> }
  | { kind: 'invalidSource'; message: string }
  | { kind: 'gitUnavailable'; message: string }
  | { kind: 'networkError'; message: string }
  | { kind: 'unknown'; message: string };

export interface SkillsRepoScanResponse {
  ok: boolean;
  items?: SkillsCatalogItem[];
  error?: SkillsRepoScanError;
}

interface SkillsInstallSelection {
  skillDir: string;
  /** ClawdHub-specific metadata for installation */
  clawdhub?: {
    slug: string;
    version: string;
  };
}

export interface SkillsInstallRequest {
  source: string;
  subpath?: string;
  gitIdentityId?: string;
  scope: 'user' | 'project';
  targetSource?: 'opencode' | 'agents';
  selections: SkillsInstallSelection[];
  conflictPolicy?: 'prompt' | 'skipAll' | 'overwriteAll';
  conflictDecisions?: Record<string, 'skip' | 'overwrite'>;
}

export type SkillsInstallError = SkillsRepoScanError | {
  kind: 'conflicts';
  message: string;
  conflicts: Array<{ skillName: string; scope: 'user' | 'project'; source?: 'opencode' | 'agents' }>;
};

export interface SkillsInstallResponse {
  ok: boolean;
  installed?: Array<{ skillName: string; scope: 'user' | 'project'; source?: 'opencode' | 'agents' }>;
  skipped?: Array<{ skillName: string; reason: string }>;
  error?: SkillsInstallError;
  requiresReload?: boolean;
  message?: string;
  reloadDelayMs?: number;
}
