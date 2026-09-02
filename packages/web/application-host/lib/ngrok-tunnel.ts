import { spawn, spawnSync } from 'child_process';
import {
  createExecutableSearchEnv,
  resolveExecutableLaunchTarget,
} from './tunnels/executable-search.js';
import { getTunnelDependencyInstallInfo } from './tunnels/install-help.js';
import { TUNNEL_PROVIDER_NGROK } from './tunnels/types.js';
import type { TunnelController } from './tunnels/types.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const NGROK_API_URL = 'http://127.0.0.1:4040/api/tunnels';
const NGROK_PUBLIC_URL_REGEX = /https:\/\/[^\s"']+/i;
const NGROK_AUTHTOKEN_HELP = 'Run: ngrok config add-authtoken <your-ngrok-token>';
const getNgrokInstallInfo = () => getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_NGROK);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

export interface NgrokAvailability {
  available: boolean;
  path: string | null;
  version: string | null;
}

export async function checkNgrokAvailable(): Promise<NgrokAvailability> {
  const target = resolveExecutableLaunchTarget('ngrok');
  if (target) {
    try {
      const result = spawnSync(target.command, ['version'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: target.env,
      });
      if (result.status === 0) {
        return { available: true, path: target.command, version: result.stdout.trim() || result.stderr.trim() };
      }
    } catch {
      // Ignore and report unavailable below.
    }
  }
  return { available: false, path: null, version: null };
}

export async function checkNgrokAuthtokenConfigured(
  ngrokPath: string | null = null,
): Promise<{ configured: boolean; detail: string }> {
  if (typeof process.env.NGROK_AUTHTOKEN === 'string' && process.env.NGROK_AUTHTOKEN.trim().length > 0) {
    return { configured: true, detail: 'NGROK_AUTHTOKEN is set.' };
  }

  const target = ngrokPath
    ? { command: ngrokPath, env: createExecutableSearchEnv() }
    : resolveExecutableLaunchTarget('ngrok');
  if (!target) {
    return { configured: false, detail: getNgrokInstallInfo().message };
  }

  try {
    const result = spawnSync(target.command, ['config', 'check'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: target.env,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (result.status === 0) {
      return { configured: true, detail: output || 'ngrok config is valid.' };
    }
    return { configured: false, detail: output || NGROK_AUTHTOKEN_HELP };
  } catch (error) {
    return {
      configured: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkNgrokApiReachability({
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
}: { fetchImpl?: typeof fetch | undefined; timeoutMs?: number | undefined } = {}): Promise<{
  error: string | null;
  reachable: boolean;
  status: number | null;
}> {
  if (typeof fetchImpl !== 'function') {
    return { reachable: false, status: null, error: 'Fetch API is unavailable in this runtime.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('https://api.ngrok.com/', {
      method: 'GET',
      signal: controller.signal,
    });
    return { reachable: true, status: response.status, error: null };
  } catch (error) {
    return {
      reachable: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

const spawnNgrok = (args: string[], resolvedBinaryPath = 'ngrok') => spawn(resolvedBinaryPath, args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: createExecutableSearchEnv(),
  killSignal: 'SIGINT',
});

const normalizeNgrokPublicUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:' && parsed.hostname.includes('ngrok')) {
      return parsed.toString().replace(/\/$/, '');
    }
  } catch {
    return null;
  }
  return null;
};

export function extractNgrokPublicUrlFromText(text: unknown): string | null {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      const parsedUrl = isRecord(parsed)
        ? normalizeNgrokPublicUrl(parsed.url) || normalizeNgrokPublicUrl(parsed.public_url)
        : null;
      if (parsedUrl) {
        return parsedUrl;
      }
    } catch {
      // ngrok may emit non-JSON diagnostics even when log-format=json.
    }

    const match = line.match(NGROK_PUBLIC_URL_REGEX);
    const matchedUrl = normalizeNgrokPublicUrl(match?.[0]);
    if (matchedUrl) {
      return matchedUrl;
    }
  }

  return null;
}

const normalizeNgrokDiagnosticText = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
};

export const summarizeNgrokOutput = (lines: unknown): string => {
  const nonEmptyLines = Array.isArray(lines)
    ? lines.map((line) => String(line || '').trim()).filter(Boolean)
    : [];
  if (nonEmptyLines.length === 0) {
    return '';
  }

  for (const line of [...nonEmptyLines].reverse()) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) continue;
      const level = typeof parsed.lvl === 'string' ? parsed.lvl.toLowerCase() : '';
      if (level !== 'eror' && level !== 'error' && level !== 'crit') {
        continue;
      }
      const err = normalizeNgrokDiagnosticText(parsed.err);
      if (err && err !== '<nil>') {
        return err;
      }
    } catch {
      // Not a JSON ngrok log line.
    }
  }

  for (const line of [...nonEmptyLines].reverse()) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) continue;
      const err = normalizeNgrokDiagnosticText(parsed.err);
      if (err && err !== '<nil>' && !/context canceled/i.test(err)) {
        return err;
      }
      const msg = normalizeNgrokDiagnosticText(parsed.msg);
      if (msg && /failed|error|invalid|auth/i.test(msg)) {
        return msg;
      }
    } catch {
      // Not a JSON ngrok log line.
    }
  }

  const errorLines = nonEmptyLines
    .filter((line) => /^ERROR:/i.test(line))
    .map((line) => normalizeNgrokDiagnosticText(line.replace(/^ERROR:\s*/i, '')))
    .filter(Boolean);
  if (errorLines.length > 0) {
    return errorLines.slice(0, 4).join(' ');
  }

  const lastLine = [...nonEmptyLines].reverse().find((line) => line.trim().length > 0);
  if (!lastLine) {
    return '';
  }
  try {
    const parsed = JSON.parse(lastLine) as unknown;
    if (isRecord(parsed) && typeof parsed.err === 'string' && parsed.err.trim().length > 0) {
      return normalizeNgrokDiagnosticText(parsed.err);
    }
    if (isRecord(parsed) && typeof parsed.msg === 'string' && parsed.msg.trim().length > 0) {
      return normalizeNgrokDiagnosticText(parsed.msg);
    }
  } catch {
    // Fall through to plain text output.
  }
  return normalizeNgrokDiagnosticText(lastLine);
};

const appendNgrokOutputSummary = (message: string, lines: unknown): string => {
  const summary = summarizeNgrokOutput(lines);
  return summary ? `${message}: ${summary}` : message;
};

async function fetchNgrokPublicUrl(fetchImpl: typeof fetch = globalThis.fetch): Promise<string | null> {
  if (typeof fetchImpl !== 'function') {
    return null;
  }
  try {
    const response = await fetchImpl(NGROK_API_URL, { method: 'GET' });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json() as unknown;
    const tunnels = isRecord(payload) && Array.isArray(payload.tunnels) ? payload.tunnels : [];
    const httpsTunnel = tunnels.find((entry) => isRecord(entry)
      && entry.proto === 'https' && normalizeNgrokPublicUrl(entry.public_url));
    const fallbackTunnel = tunnels.find((entry) => isRecord(entry) && normalizeNgrokPublicUrl(entry.public_url));
    return normalizeNgrokPublicUrl(isRecord(httpsTunnel) ? httpsTunnel.public_url : null)
      || normalizeNgrokPublicUrl(isRecord(fallbackTunnel) ? fallbackTunnel.public_url : null);
  } catch {
    return null;
  }
}

export async function startNgrokQuickTunnel({ port }: { port: number | null }): Promise<TunnelController & {
  process: ReturnType<typeof spawnNgrok>;
}> {
  const ngrokCheck = await checkNgrokAvailable();
  if (!ngrokCheck.available) {
    throw new Error(getNgrokInstallInfo().message);
  }

  const authtokenCheck = await checkNgrokAuthtokenConfigured(ngrokCheck.path);
  if (!authtokenCheck.configured) {
    throw new Error(`ngrok authtoken is not configured. ${authtokenCheck.detail || NGROK_AUTHTOKEN_HELP}`);
  }

  if (!Number.isFinite(port)) {
    throw new Error('A local port is required to start an ngrok tunnel');
  }

  const child = spawnNgrok(
    ['http', '--log=stdout', '--log-format=json', `127.0.0.1:${port}`],
    ngrokCheck.path ?? 'ngrok',
  );
  let publicUrl: string | null = null;
  const recentOutput: string[] = [];

  const captureOutput = (chunk: string | Buffer): string => {
    const text = chunk.toString('utf8');
    const parsedUrl = extractNgrokPublicUrlFromText(text);
    if (parsedUrl) {
      publicUrl = parsedUrl;
    }

    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      recentOutput.push(trimmed);
      if (recentOutput.length > 200) {
        recentOutput.shift();
      }
    }
    return text;
  };

  child.stdout.on('data', (chunk) => {
    captureOutput(chunk);
  });

  child.stderr.on('data', (chunk) => {
    const text = captureOutput(chunk);
    process.stderr.write(text);
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = <T>(handler: (value: T) => void, value: T): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(checkReady);
      child.off('error', onError);
      child.off('exit', onExit);
      handler(value);
    };

    const timeout = setTimeout(() => {
      try { child.kill('SIGINT'); } catch { /* ignore */ }
      finish(reject, new Error(appendNgrokOutputSummary('Ngrok tunnel URL not received within 30 seconds', recentOutput)));
    }, DEFAULT_STARTUP_TIMEOUT_MS);

    const checkReady = setInterval(async () => {
      publicUrl = publicUrl || await fetchNgrokPublicUrl();
      if (publicUrl) {
        finish(resolve, undefined);
      }
    }, 250);

    const onError = (error: Error): void => {
      finish(reject, new Error(`Ngrok failed to start: ${error.message}`));
    };

    const onExit = (code: number | null): void => {
      finish(reject, new Error(appendNgrokOutputSummary(`Ngrok exited while starting (code ${code ?? 'unknown'})`, recentOutput)));
    };

    child.once('error', onError);
    child.once('exit', onExit);
  });

  return {
    mode: 'quick' as const,
    stop: () => {
      try {
        child.kill('SIGINT');
      } catch {
        // Ignore.
      }
    },
    process: child,
    getPublicUrl: () => publicUrl,
  };
}
