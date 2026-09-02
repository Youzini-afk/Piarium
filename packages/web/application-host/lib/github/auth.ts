import fs from 'fs';
import path from 'path';
import { resolvePiariumDataDir } from '../platform/data-paths.js';
import { createSettingsFileStore } from '@piarium/settings-store';
import type { GitHubAuthEntry, GitHubUser, SetGitHubAuthInput } from './types.js';

const PIARIUM_DATA_DIR = resolvePiariumDataDir(process);

const STORAGE_DIR = PIARIUM_DATA_DIR;
const STORAGE_FILE = path.join(STORAGE_DIR, 'github-auth.json');
const SETTINGS_FILE = path.join(PIARIUM_DATA_DIR, 'settings.json');
const settingsStore = createSettingsFileStore({ filePath: SETTINGS_FILE });

const DEFAULT_GITHUB_CLIENT_ID = 'Ov23lizomPOC3eFYo56r';
const DEFAULT_GITHUB_SCOPES = 'repo read:org workflow read:user user:email';
export const GH_CLI_ACCOUNT_ID = 'gh-cli';

function ensureStorageDir(): void {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

function readJsonFile(): unknown {
  ensureStorageDir();
  if (!fs.existsSync(STORAGE_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch (error) {
    console.error('Failed to read GitHub auth file:', error);
    return null;
  }
}

function writeJsonFile(payload: unknown): void {
  ensureStorageDir();

  // Atomic write so multiple Piarium instances can safely share the same file.
  const tmpFile = `${STORAGE_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // best-effort
  }

  fs.renameSync(tmpFile, STORAGE_FILE);
  try {
    fs.chmodSync(STORAGE_FILE, 0o600);
  } catch {
    // best-effort
  }
}

function resolveAccountId({ user, accessToken, accountId }: {
  accessToken?: string;
  accountId?: string;
  user?: GitHubUser | null;
}): string {
  if (typeof accountId === 'string' && accountId.trim()) {
    return accountId.trim();
  }
  if (user && typeof user.login === 'string' && user.login.trim()) {
    return user.login.trim();
  }
  if (user && typeof user.id === 'number') {
    return String(user.id);
  }
  if (typeof accessToken === 'string' && accessToken.trim()) {
    return `token:${accessToken.slice(0, 8)}`;
  }
  return '';
}

function normalizeAuthEntry(entry: unknown): GitHubAuthEntry | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const value = entry as Record<string, unknown>;
  const accessToken = typeof value.accessToken === 'string' ? value.accessToken : '';
  if (!accessToken) return null;
  const rawUser = value.user && typeof value.user === 'object' && !Array.isArray(value.user)
    ? value.user as Record<string, unknown>
    : null;
  const user: GitHubUser | null = rawUser
    ? {
      login: typeof rawUser.login === 'string' ? rawUser.login : null,
      avatarUrl: typeof rawUser.avatarUrl === 'string' ? rawUser.avatarUrl : null,
      id: typeof rawUser.id === 'number' ? rawUser.id : null,
      name: typeof rawUser.name === 'string' ? rawUser.name : null,
      email: typeof rawUser.email === 'string' ? rawUser.email : null,
    }
    : null;

  const accountId = resolveAccountId({
    user,
    accessToken,
    accountId: typeof value.accountId === 'string' ? value.accountId : '',
  });

  return {
    accessToken,
    scope: typeof value.scope === 'string' ? value.scope : '',
    tokenType: typeof value.tokenType === 'string' ? value.tokenType : 'bearer',
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : null,
    user,
    current: Boolean(value.current),
    accountId,
  };
}

function normalizeAuthList(raw: unknown): { changed: boolean; list: GitHubAuthEntry[] } {
  const list = (Array.isArray(raw) ? raw : [raw])
    .map((entry) => normalizeAuthEntry(entry))
    .filter((entry): entry is GitHubAuthEntry => entry !== null);

  if (!list.length) {
    return { list: [], changed: false };
  }

  let changed = false;
  let currentFound = false;
  list.forEach((entry) => {
    if (entry.current && !currentFound) {
      currentFound = true;
    } else if (entry.current && currentFound) {
      entry.current = false;
      changed = true;
    }
  });

  if (!currentFound && list[0]) {
    list[0].current = true;
    changed = true;
  }

  list.forEach((entry) => {
    if (!entry.accountId) {
      entry.accountId = resolveAccountId(entry);
      changed = true;
    }
  });

  return { list, changed };
}

function readAuthList(): GitHubAuthEntry[] {
  const data = readJsonFile();
  if (!data) {
    return [];
  }
  const { list, changed } = normalizeAuthList(data);
  if (changed) {
    writeJsonFile(list);
  }
  return list;
}

function writeAuthList(list: GitHubAuthEntry[]): void {
  writeJsonFile(list);
}

export function getGitHubAuth(): GitHubAuthEntry | null {
  const list = readAuthList();
  if (!list.length) {
    return null;
  }
  const current = list.find((entry) => entry.current) || list[0];
  if (!current?.accessToken) {
    return null;
  }
  return current;
}

export function getGitHubAuthAccounts() {
  const list = readAuthList();
  return list
    .filter((entry) => entry?.user && entry.accountId)
    .map((entry) => ({
      id: entry.accountId,
      user: entry.user,
      scope: entry.scope || '',
      current: Boolean(entry.current),
    }));
}

export function setGitHubAuth({ accessToken, scope, tokenType, user, accountId }: SetGitHubAuthInput): GitHubAuthEntry {
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('accessToken is required');
  }
  const normalizedUser: GitHubUser | undefined = user && typeof user === 'object'
    ? {
      login: typeof user.login === 'string' ? user.login : null,
      avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : null,
      id: typeof user.id === 'number' ? user.id : null,
      name: typeof user.name === 'string' ? user.name : null,
      email: typeof user.email === 'string' ? user.email : null,
    }
    : undefined;

  const resolvedAccountId = resolveAccountId({
    accessToken,
    ...(normalizedUser ? { user: normalizedUser } : {}),
    ...(accountId ? { accountId } : {}),
  });

  const list = readAuthList();
  const existingIndex = list.findIndex((entry) => entry.accountId === resolvedAccountId);
  const nextEntry: GitHubAuthEntry = {
    accessToken,
    scope: typeof scope === 'string' ? scope : '',
    tokenType: typeof tokenType === 'string' ? tokenType : 'bearer',
    createdAt: Date.now(),
    user: normalizedUser || null,
    current: true,
    accountId: resolvedAccountId,
  };

  if (existingIndex >= 0) {
    list[existingIndex] = nextEntry;
  } else {
    list.push(nextEntry);
  }

  list.forEach((entry, index) => {
    entry.current = index === (existingIndex >= 0 ? existingIndex : list.length - 1);
  });
  writeAuthList(list);
  return nextEntry;
}

export async function activateGitHubAuth(accountId: unknown): Promise<boolean> {
  if (typeof accountId !== 'string' || !accountId.trim()) {
    return false;
  }
  const list = readAuthList();
  const index = list.findIndex((entry) => entry.accountId === accountId.trim());
  if (index === -1) {
    return false;
  }
  await setGhCliActive(false);
  list.forEach((entry, idx) => {
    entry.current = idx === index;
  });
  writeAuthList(list);
  return true;
}

export function clearGitHubAuth(): boolean {
  try {
    const list = readAuthList();
    if (!list.length) {
      return true;
    }
    const remaining = list.filter((entry) => !entry.current);
    if (!remaining.length) {
      if (fs.existsSync(STORAGE_FILE)) {
        fs.unlinkSync(STORAGE_FILE);
      }
      return true;
    }
    remaining.forEach((entry, index) => {
      entry.current = index === 0;
    });
    writeAuthList(remaining);
    return true;
  } catch (error) {
    console.error('Failed to clear GitHub auth file:', error);
    return false;
  }
}

const isMissingFileError = (error: unknown): boolean => (
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
);

export function getGitHubClientId(): string {
  const raw = process.env.PIARIUM_GITHUB_CLIENT_ID;
  const clientId = typeof raw === 'string' ? raw.trim() : '';
  if (clientId) return clientId;

  try {
    const stored = settingsStore.readSync().githubClientId;
    if (typeof stored === 'string' && stored.trim()) return stored.trim();
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  return DEFAULT_GITHUB_CLIENT_ID;
}

export function getGitHubScopes(): string {
  const raw = process.env.PIARIUM_GITHUB_SCOPES;
  const fromEnv = typeof raw === 'string' ? raw.trim() : '';
  if (fromEnv) return fromEnv;

  try {
    const stored = settingsStore.readSync().githubScopes;
    if (typeof stored === 'string' && stored.trim()) return stored.trim();
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  return DEFAULT_GITHUB_SCOPES;
}

export const GITHUB_AUTH_FILE = STORAGE_FILE;

export function isGhCliDisabled(): boolean {
  return Boolean(settingsStore.readSync().ghCliDisabled);
}

export async function setGhCliDisabled(disabled: unknown): Promise<void> {
  await settingsStore.update((settings) => {
    settings.ghCliDisabled = Boolean(disabled);
    if (settings.ghCliDisabled) settings.ghCliActive = false;
    return settings;
  });
}

export function isGhCliActive(): boolean {
  const settings = settingsStore.readSync();
  return !settings?.ghCliDisabled && Boolean(settings?.ghCliActive);
}

export async function setGhCliActive(active: unknown): Promise<void> {
  await settingsStore.update((settings) => {
    settings.ghCliActive = Boolean(active) && !settings.ghCliDisabled;
    return settings;
  });
}
