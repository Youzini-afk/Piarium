import type { Express } from 'express';
import type { Server } from 'node:http';
import type { PiRuntimeBroker } from '@piarium/runtime-broker';

// ── Server lifecycle ─────────────────────────────────────────────────────

export interface WebUiServerController {
  expressApp: Express;
  httpServer: Server;
  getPort: () => number | null;
  getTunnelUrl: () => string | null;
  getQuitRiskStatus: () => {
    tunnel: { active: boolean };
    scheduledTasks: unknown;
  };
  isReady: () => boolean;
  stop: (options?: { exitProcess?: boolean }) => Promise<void>;
}

export interface StartWebUiServerOptions {
  port?: number;
  host?: string;
  attachSignals?: boolean;
  exitOnShutdown?: boolean;
  uiPassword?: string | null;
  piRuntimeBroker?: PiRuntimeBroker;
}

export declare function startWebUiServer(
  options?: StartWebUiServerOptions,
): Promise<WebUiServerController>;

export declare function gracefulShutdown(options?: { exitProcess?: boolean }): Promise<void>;

export interface ParsedServeCliArgs {
  port: number;
  host?: string;
  uiPassword: string | null;
  tryCfTunnel: boolean;
  tunnelProvider?: string;
  tunnelMode?: string;
  tunnelConfigPath?: string | null;
  tunnelToken?: string;
  tunnelHostname?: string;
}

export declare function parseArgs(argv?: string[]): ParsedServeCliArgs;

// ── Platform facade ──────────────────────────────────────────────────────
// Cross-package consumers (Electron, VS Code) should import these from
// '@piarium/web/server' instead of deep-importing server/lib/*.

export declare function resolvePiariumDataDir(
  processLike?: Pick<NodeJS.Process, 'env' | 'platform'>,
): string;

export declare function clearAppImageArgv0FromProcessEnv(): void;

export declare function pathLooksUserConfigured(
  value: string,
  home: string,
  delim: string,
): boolean;

export declare function mergePathValues(
  primary: string,
  fallback: string,
  delim: string,
): string;

// ── Filesystem facade ────────────────────────────────────────────────────

export interface OutsideFileGrantOptions {
  scopes?: readonly string[];
  fsPromises?: Pick<typeof import('node:fs/promises'), 'realpath' | 'stat'>;
  path?: Pick<typeof import('node:path'), 'dirname'>;
  crypto?: Pick<Crypto, 'randomUUID'>;
}

export interface OutsideFileGrantResult {
  path: string;
  outsideFileGrant: string;
  expiresAt: number;
}

export declare function mintOutsideFileGrant(
  targetPath: string,
  options?: OutsideFileGrantOptions,
): Promise<OutsideFileGrantResult>;
