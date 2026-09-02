/**
 * CLI output formatting adapter.
 *
 * Wraps @clack/prompts for structured, beautiful terminal output.
 * Custom formatters (icons, redaction) live here to isolate the
 * formatting dependency from the rest of the CLI.
 */

import {
  intro,
  outro,
  log,
  box,
  confirm,
  select,
  text,
  password,
  spinner,
  progress,
  cancel,
  isCancel,
} from '@clack/prompts';
import { recordOf, type CliOptions } from './lib/cli-types.js';

// ── Provider icons ──────────────────────────────────────────────

const TUNNEL_PROVIDER_ICON: Record<string, string> = {
  cloudflare: '☁',
};

function formatProviderWithIcon(provider: unknown): string {
  if (typeof provider !== 'string' || provider.trim().length === 0) {
    return 'unknown';
  }
  const normalized = provider.trim().toLowerCase();
  const icon = TUNNEL_PROVIDER_ICON[normalized];
  return icon ? `${icon} ${normalized}` : normalized;
}

// ── Status-aware log dispatch ───────────────────────────────────

/**
 * Print a status-tagged message using clack log primitives.
 *
 * @param {'success'|'warning'|'error'|'info'|'neutral'} status
 * @param {string} message  Primary line
 * @param {string} [detail] Optional dim secondary line appended after newline
 */
type CliLogStatus = 'success' | 'warning' | 'error' | 'info' | 'neutral';

function logStatus(status: CliLogStatus, message: string, detail?: string): void {
  const full = detail ? `${message}\n${detail}` : message;
  switch (status) {
    case 'success':
      log.success(full);
      break;
    case 'warning':
      log.warn(full);
      break;
    case 'error':
      log.error(full);
      break;
    case 'info':
    case 'neutral':
    default:
      log.info(full);
      break;
  }
}

// ── TTY detection ───────────────────────────────────────────────

/**
 * Whether both stdout and stdin are interactive TTYs.
 * Prompts must be disabled when stdin is piped (e.g. --token-stdin).
 */
const isTTY = Boolean(process.stdout?.isTTY) && Boolean(process.stdin?.isTTY);

function isJsonMode(options?: Pick<CliOptions, 'json'> | null): boolean {
  return Boolean(options?.json);
}

function isQuietMode(options?: Pick<CliOptions, 'quiet'> | null): boolean {
  return Boolean(options?.quiet);
}

function shouldRenderHumanOutput(options?: Pick<CliOptions, 'json' | 'quiet'> | null): boolean {
  return !isJsonMode(options) && !isQuietMode(options);
}

function canPrompt(options?: Pick<CliOptions, 'json' | 'quiet'> | null): boolean {
  return shouldRenderHumanOutput(options) && isTTY;
}

function createSpinner(options?: Pick<CliOptions, 'json' | 'quiet'> | null): ReturnType<typeof spinner> | null {
  return canPrompt(options) ? spinner() : null;
}

async function createProgress(
  options: Pick<CliOptions, 'json' | 'quiet'> | null | undefined,
  config: Parameters<typeof progress>[0],
): Promise<Awaited<ReturnType<typeof progress>> | null> {
  return canPrompt(options) ? progress(config) : null;
}

function printJson(payload: unknown): void {
  const base: Record<string, unknown> = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...recordOf(payload) }
    : { data: payload };

  const messages = Array.isArray(base.messages) ? base.messages : undefined;
  const hasWarning = Boolean(messages?.some((entry) => recordOf(entry).level === 'warning'));
  const hasError = Boolean(messages?.some((entry) => recordOf(entry).level === 'error'));
  const normalizedStatus = base.status === 'ok' || base.status === 'warning' || base.status === 'error'
    ? base.status
    : (hasError ? 'error' : (hasWarning ? 'warning' : 'ok'));

  const output = {
    status: normalizedStatus,
    ...base,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

export {
  intro,
  outro,
  log,
  box,
  confirm,
  select,
  text,
  password,
  cancel,
  isCancel,
  isJsonMode,
  isQuietMode,
  shouldRenderHumanOutput,
  canPrompt,
  createSpinner,
  createProgress,
  printJson,
  formatProviderWithIcon,
  logStatus,
};
