import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { readManagedCredential, writeManagedCredential } from '../credentials/providers.js';
import {
  asObject,
  buildResult,
  formatMoney,
  toNumber,
  toTimestamp,
  toUsageWindow
} from '../utils/index.js';
import type { ManagedCredential } from '../credentials/providers.js';
import type { UsageWindow } from '../utils/index.js';

const BASE_URL = 'https://api2.cursor.sh';
const USAGE_URL = `${BASE_URL}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`;
const PLAN_URL = `${BASE_URL}/aiserver.v1.DashboardService/GetPlanInfo`;
const CREDITS_URL = `${BASE_URL}/aiserver.v1.DashboardService/GetCreditGrantsBalance`;
const REFRESH_URL = `${BASE_URL}/oauth/token`;
const CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const STATE_DB = join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');

interface CursorAuthState {
  accessToken: string | null;
  refreshToken: string | null;
  source: 'env' | 'file' | 'managed' | 'import' | 'validation';
}

export const providerId = 'cursor';
export const providerName = 'Cursor';

const readJwtPayload = (token: string): Record<string, unknown> | null => {
  try {
    const [, payload] = String(token).split('.');
    if (!payload) return null;
    return asObject(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown);
  } catch {
    return null;
  }
};

const readStateValue = (key: string): string | null => {
  if (!existsSync(STATE_DB)) return null;
  try {
    const escapedKey = String(key).replace(/'/g, "''");
    const rows = execFileSync('sqlite3', [
      '-json',
      STATE_DB,
      `SELECT value FROM ItemTable WHERE key = '${escapedKey}' LIMIT 1;`
    ], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const parsed = JSON.parse(rows || '[]') as unknown;
    const first = Array.isArray(parsed) ? asObject(parsed[0]) : null;
    const value = first?.value;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
};

const readFileToken = (path: string | null): string | null => {
  try {
    if (!path || !existsSync(path)) return null;
    const content = readFileSync(path, 'utf8').trim();
    return content || null;
  } catch {
    return null;
  }
};

const loadAuthState = (): CursorAuthState => {
  const envAccessToken = process.env.CURSOR_TOKEN || process.env.CURSOR_ACCESS_TOKEN || null;
  const envRefreshToken = process.env.CURSOR_REFRESH_TOKEN || null;
  const accessTokenPath = process.env.CURSOR_TOKEN_FILE || null;
  const refreshTokenPath = process.env.CURSOR_REFRESH_TOKEN_FILE || null;
  const fileAccessToken = readFileToken(accessTokenPath);
  const fileRefreshToken = readFileToken(refreshTokenPath);

  if (envAccessToken || envRefreshToken) {
    return {
      accessToken: envAccessToken,
      refreshToken: envRefreshToken,
      source: 'env'
    };
  }

  if (fileAccessToken || fileRefreshToken) {
    return {
      accessToken: fileAccessToken,
      refreshToken: fileRefreshToken,
      source: 'file'
    };
  }

  const managed = readManagedCredential(providerId);
  return {
    accessToken: managed?.accessToken || null,
    refreshToken: managed?.refreshToken || null,
    source: 'managed'
  };
};

const tokenNeedsRefresh = (token: string | null): boolean => {
  if (!token) return true;
  const payload = readJwtPayload(token);
  const expiresAt = typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
  return !expiresAt || expiresAt - Date.now() <= REFRESH_BUFFER_MS;
};

const persistAccessToken = (auth: CursorAuthState, accessToken: string): void => {
  if (auth.source === 'managed') writeManagedCredential(providerId, { accessToken, refreshToken: auth.refreshToken || '' });
};

export const importCursorCredential = async () => {
  const credential = {
    accessToken: readStateValue('cursorAuth/accessToken') || '',
    refreshToken: readStateValue('cursorAuth/refreshToken') || '',
  };
  if (!credential.accessToken && !credential.refreshToken) throw new Error('Cursor credentials are unavailable');
  const accessToken = await resolveCredentialAccessToken({ ...credential, source: 'import' });
  if (!accessToken) throw new Error('Cursor credentials are invalid');
  return writeManagedCredential(providerId, { ...credential, accessToken });
};

const refreshAccessToken = async (auth: CursorAuthState): Promise<string | null> => {
  if (!auth.refreshToken) return auth.accessToken;

  const response = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: auth.refreshToken
    })
  });

  const body = asObject(await response.json().catch(() => null));
  if (body?.shouldLogout === true) {
    throw new Error('Session expired - please sign in to Cursor again');
  }
  if (!response.ok) {
    throw new Error(response.status === 401 ? 'Cursor session expired' : `API error: ${response.status}`);
  }
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    throw new Error('Cursor refresh response did not include an access token');
  }

  persistAccessToken(auth, body.access_token);
  return body.access_token;
};

const resolveCredentialAccessToken = async (auth: CursorAuthState): Promise<string | null> => {
  if (!auth.accessToken && !auth.refreshToken) return null;
  if (!tokenNeedsRefresh(auth.accessToken)) return auth.accessToken;
  return refreshAccessToken(auth);
};

const resolveAccessToken = async () => resolveCredentialAccessToken(loadAuthState());

const toCursorAuthState = (credential: ManagedCredential, source: CursorAuthState['source']): CursorAuthState => ({
  accessToken: credential.accessToken || null,
  refreshToken: credential.refreshToken || null,
  source,
});

export const validateCursorCredential = async (credential: ManagedCredential): Promise<void> => {
  const accessToken = await resolveCredentialAccessToken(toCursorAuthState(credential, 'validation'));
  if (!accessToken) throw new Error('Cursor credentials are invalid');
  await connectPost(USAGE_URL, accessToken);
};

const connectPost = async (url: string, accessToken: string): Promise<Record<string, unknown>> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1'
    },
    body: '{}'
  });

  if (!response.ok) {
    throw new Error(response.status === 401 ? 'Cursor session expired' : `API error: ${response.status}`);
  }

  return asObject(await response.json()) ?? {};
};

const centsLabel = (cents: unknown): string | null => {
  const value = toNumber(cents);
  return value === null ? null : `$${formatMoney(value / 100)}`;
};

const percentFromSpend = (planUsage: Record<string, unknown>): number | null => {
  const explicit = toNumber(planUsage.totalPercentUsed);
  if (explicit !== null) return explicit;
  const limit = toNumber(planUsage.limit);
  const remaining = toNumber(planUsage.remaining);
  if (!limit || remaining === null) return null;
  return Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100));
};

const buildWindows = (
  usage: Record<string, unknown>,
  plan: Record<string, unknown> | null,
): Record<string, UsageWindow> => {
  const planUsage = asObject(usage.planUsage) ?? {};
  const spendLimitUsage = asObject(usage.spendLimitUsage) ?? {};
  const planInfo = asObject(plan?.planInfo);
  const resetAt = toTimestamp(usage.billingCycleEnd ?? planInfo?.billingCycleEnd);
  const windowSeconds = resetAt ? Math.max(0, Math.floor((resetAt - Date.now()) / 1000)) : null;
  const windows: Record<string, UsageWindow> = {};

  windows.billing_cycle = toUsageWindow({
    usedPercent: percentFromSpend(planUsage),
    windowSeconds,
    resetAt,
    valueLabel: centsLabel(planUsage.totalSpend)
  });

  const autoPercent = toNumber(planUsage.autoPercentUsed);
  if (autoPercent !== null) {
    windows.auto = toUsageWindow({ usedPercent: autoPercent, windowSeconds, resetAt });
  }

  const apiPercent = toNumber(planUsage.apiPercentUsed);
  if (apiPercent !== null) {
    windows.api = toUsageWindow({ usedPercent: apiPercent, windowSeconds, resetAt });
  }

  const planLimit = centsLabel(planUsage.limit);
  if (planLimit) {
    const limit = toNumber(planUsage.limit);
    const remaining = toNumber(planUsage.remaining);
    windows.plan_limit = toUsageWindow({
      usedPercent: limit && remaining !== null
        ? Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100))
        : null,
      windowSeconds,
      resetAt,
      valueLabel: `${centsLabel(planUsage.remaining) ?? '$0.00'} remaining of ${planLimit}`
    });
  }

  const onDemandLimit = toNumber(spendLimitUsage.individualLimit) ?? toNumber(spendLimitUsage.pooledLimit);
  if (onDemandLimit && onDemandLimit > 0) {
    const remaining = toNumber(spendLimitUsage.individualRemaining) ?? toNumber(spendLimitUsage.pooledRemaining) ?? 0;
    windows.on_demand = toUsageWindow({
      usedPercent: Math.min(100, Math.max(0, ((onDemandLimit - remaining) / onDemandLimit) * 100)),
      windowSeconds,
      resetAt,
      valueLabel: `${centsLabel(remaining) ?? '$0.00'} remaining of ${centsLabel(onDemandLimit)}`
    });
  }

  return windows;
};

const appendCreditsWindow = (
  windows: Record<string, UsageWindow>,
  credits: Record<string, unknown> | null,
): void => {
  const balance = toNumber(credits?.balanceCents ?? credits?.totalBalanceCents ?? credits?.amountCents);
  if (balance === null) return;
  windows.credits = toUsageWindow({
    usedPercent: null,
    windowSeconds: null,
    resetAt: null,
    valueLabel: centsLabel(balance)
  });
};

export const isConfigured = () => {
  const auth = loadAuthState();
  return Boolean(auth.accessToken || auth.refreshToken);
};

export const fetchQuota = async () => {
  const accessToken = await resolveAccessToken();
  if (!accessToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    const [usage, plan, credits] = await Promise.all([
      connectPost(USAGE_URL, accessToken),
      connectPost(PLAN_URL, accessToken).catch(() => null),
      connectPost(CREDITS_URL, accessToken).catch(() => null)
    ]);

    if (usage.enabled === false || !usage.planUsage) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No active Cursor subscription'
      });
    }

    const windows = buildWindows(usage, plan);
    appendCreditsWindow(windows, credits);
    const planInfo = asObject(plan?.planInfo);
    const planName = typeof planInfo?.planName === 'string' ? planInfo.planName : null;

    return buildResult({
      providerId,
      providerName: planName ? `Cursor ${planName}` : providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
