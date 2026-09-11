export type TerminalSessionOwner = "user" | "harness";

export interface TerminalSpawnSpec {
  executable: string;
  args: string[];
  env?: Record<string, string>;
}

export interface CreateTerminalSessionInput {
  sessionId?: string;
  cwd: string;
  cols?: number;
  rows?: number;
  shell?: string;
  loginShell?: boolean;
  themeMode?: "dark" | "light";
  terminalBackground?: string;
  terminalForeground?: string;
  owner?: TerminalSessionOwner;
  spawn?: TerminalSpawnSpec;
  registerProcessWriter?: boolean;
  retainWhenDetached?: boolean;
}

export interface TerminalCommandRecord {
  command: string;
  commandId: string;
  cwd?: string;
  endedAt: number;
  exitCode: number;
  integration: "osc-633";
  owner: TerminalSessionOwner;
  startedAt?: number;
  terminalId: string;
}

export interface TerminalHandle {
  readonly id: string;
  readonly cwd: string;
  readonly status: "exited" | "running";
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(handler: (data: string) => void): { dispose(): void };
  onCommand(handler: (event: TerminalCommandRecord) => void): { dispose(): void };
  onExit(handler: (event: { exitCode: number; signal: number }) => void): { dispose(): void };
  waitForExit(): Promise<{ exitCode: number | null; signal: number | null }>;
  terminate(force?: boolean): Promise<void>;
  destroy(): Promise<void>;
}

export interface TerminalSessionInfo {
  cwd: string;
  id: string;
  integration: "not-observed" | "ready";
  owner: TerminalSessionOwner;
  retainWhenDetached: boolean;
  status: "exited" | "running";
}

export interface TerminalSessionApi {
  attachTerminalSession(id: string): TerminalHandle | null;
  createTerminalSession(input: CreateTerminalSessionInput): Promise<TerminalHandle>;
  inspectSession(id: string): TerminalSessionInfo | null;
  subscribeCommands(handler: (event: TerminalCommandRecord) => void): { dispose(): void };
}
