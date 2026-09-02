import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type path from 'node:path';
import type {
  PiariumBreakpoint,
  PiariumDebugBreakpointListResult,
  PiariumDebugBreakpointsResult,
  PiariumDebugEvent,
  PiariumDebugFeatureResult,
  PiariumDebugScope,
  PiariumDebugSessionStatus,
  PiariumDebugStackFrame,
  PiariumDebugThread,
  PiariumDebugVariable,
  PiariumTaskConfiguration,
  PiariumTaskEvent,
  PiariumTaskListResult,
  PiariumTaskRunStatus,
  PiariumTestDiscoverResult,
  PiariumTestEvent,
  PiariumTestItem,
  PiariumTestRunStatus,
} from '@piarium/application-client';
import type { DocumentAuthority } from '../documents/authority.js';
import type { createJsonRpcClient } from '../lsp/jsonrpc.js';
import type { createDapClient } from './dap.js';

export type {
  PiariumBreakpoint,
  PiariumDebugBreakpointListResult,
  PiariumDebugBreakpointsResult,
  PiariumDebugEvent,
  PiariumDebugFeatureResult,
  PiariumDebugScope,
  PiariumDebugSessionStatus,
  PiariumDebugStackFrame,
  PiariumDebugThread,
  PiariumDebugVariable,
  PiariumTaskConfiguration,
  PiariumTaskEvent,
  PiariumTaskListResult,
  PiariumTaskRunStatus,
  PiariumTestDiscoverResult,
  PiariumTestEvent,
  PiariumTestItem,
  PiariumTestRunStatus,
};

export type RunSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export type RunPathModule = typeof path;
export type RunTrustCheck = (root: string) => boolean | Promise<boolean>;
export type RunListener<Event> = (event: Event) => void;
export type RunSubscription = { close(): void };
export type ProcessWriter = NonNullable<Awaited<ReturnType<DocumentAuthority['registerWriterForScope']>>>;

export interface ExtensionRunOwner {
  entrypointId: string;
  extensionId: string;
  extensionVersion?: string;
  generation: number;
}

export interface RunSupervisorOptions {
  documents: DocumentAuthority;
  env?: NodeJS.ProcessEnv;
  isTrusted?: RunTrustCheck;
  pathModule?: RunPathModule;
  spawn: RunSpawn;
}

export interface TaskRunnerOptions extends RunSupervisorOptions {
  execPath?: string;
}

export interface TestSupervisorOptions extends TaskRunnerOptions {
  fsPromises?: typeof import('node:fs/promises');
}

export interface RunRuntimeOptions extends TaskRunnerOptions {
  registerBuiltins?: boolean;
}

export type DapClient = ReturnType<typeof createDapClient>;
export type JsonRpcClient = ReturnType<typeof createJsonRpcClient>;

export interface DebugAdapterDescriptor {
  adapterId: string;
  args?: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
  languageIds?: string[];
  source?: 'builtin' | 'extension' | 'host' | 'workspace';
  workspaceId?: string;
}

export interface RegisteredDebugAdapter {
  adapterId: string;
  args: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
  languageIds: string[];
  ownerKey: string;
  ownerScopeKey: string;
  source: 'builtin' | 'extension' | 'host' | 'workspace';
  workspaceId?: string;
}

export interface DebugSessionRecord {
  adapterId: string;
  adapterOwnerKey: string;
  child: ChildProcess | null;
  generation: number;
  message: string;
  pendingTermination: Promise<void> | null;
  program: string;
  reason?: string;
  root: string;
  rpc: DapClient | null;
  sessionId: string;
  status: 'starting' | 'running' | 'paused' | 'stopped' | 'failed';
  workspaceId: string;
  writer: ProcessWriter | null;
  writerReleased: boolean;
}

export interface DebugStartRequest {
  adapterId?: string;
  languageId?: string;
  program?: string;
  workspaceId: string;
}

export interface DebugRequest {
  expression?: string;
  frameId?: number;
  threadId?: number;
  variablesReference?: number;
  workspaceId: string;
}

export interface DebugBreakpointMutationRequest {
  expectedGeneration: number | null;
  expectedSessionId: string | null;
  lines: number[];
  resourceId: string;
  workspaceId: string;
}

export interface TestProviderDescriptor {
  args?: string[];
  command?: string;
  env?: NodeJS.ProcessEnv;
  kind?: 'adapter' | 'node-test';
  providerId: string;
  source?: 'builtin' | 'extension' | 'host' | 'workspace';
  workspaceId?: string;
}

export interface RegisteredTestProvider {
  args: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
  kind: 'adapter' | 'node-test';
  ownerKey: string;
  ownerScopeKey: string;
  providerId: string;
  source: 'builtin' | 'extension' | 'host' | 'workspace';
  workspaceId?: string;
}

export interface TestRunRecord {
  cancelled: boolean;
  child: ChildProcess | null;
  generation: number;
  message: string;
  pendingTermination: Promise<void> | null;
  providerId: string;
  providerOwnerKey: string;
  rpc: JsonRpcClient | null;
  runId: string;
  status: 'running' | 'stopped' | 'failed';
  workspaceId: string;
  writer: ProcessWriter | null;
  writerReleased: boolean;
}

export interface TaskRunRecord {
  child: ChildProcess | null;
  exitCode?: number;
  generation: number;
  message: string;
  pendingTermination: Promise<void> | null;
  runId: string;
  status: 'running' | 'stopped' | 'failed';
  taskId: string;
  workspaceId: string;
  writer: ProcessWriter | null;
  writerReleased: boolean;
}

export interface InspectedRunWorkspace {
  root: string;
  workspaceId: string;
}

export interface ProviderProcess {
  child: ChildProcess;
  rpc: JsonRpcClient;
  writer: ProcessWriter | null;
}
