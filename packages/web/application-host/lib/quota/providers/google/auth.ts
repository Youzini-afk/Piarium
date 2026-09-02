/**
 * Google Provider - Auth
 *
 * Authentication resolution logic for Google quota providers.
 * @module quota/providers/google/auth
 */

import {
  ANTIGRAVITY_ACCOUNTS_PATHS,
  readJsonFile,
  getAuthEntry,
  normalizeAuthEntry,
  asObject,
  asNonEmptyString,
  toTimestamp
} from '../../utils/index.js';
import { readPiAuthFile as readAuthFile } from '../../../pi-config/storage.js';
import { parseGoogleRefreshToken } from './transforms.js';

export const GOOGLE_OAUTH_CLIENT_ENV = {
  gemini: {
    clientId: 'PIARIUM_GOOGLE_GEMINI_CLIENT_ID',
    clientSecret: 'PIARIUM_GOOGLE_GEMINI_CLIENT_SECRET'
  },
  antigravity: {
    clientId: 'PIARIUM_GOOGLE_ANTIGRAVITY_CLIENT_ID',
    clientSecret: 'PIARIUM_GOOGLE_ANTIGRAVITY_CLIENT_SECRET'
  }
} as const;
export const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

export type GoogleSourceId = keyof typeof GOOGLE_OAUTH_CLIENT_ENV;

export interface GoogleAuthSource {
  accessToken: string | null;
  email: string | null;
  expires: number | null;
  projectId: string | null;
  refreshToken: string | null;
  sourceId: GoogleSourceId;
  sourceLabel: string;
}

export const resolveGoogleOAuthClient = (sourceId: GoogleSourceId): { clientId: string; clientSecret: string } | null => {
  const env = GOOGLE_OAUTH_CLIENT_ENV[sourceId];
  if (!env) return null;
  const clientId = asNonEmptyString(process.env[env.clientId]);
  const clientSecret = asNonEmptyString(process.env[env.clientSecret]);
  return clientId && clientSecret ? { clientId, clientSecret } : null;
};

const resolveGeminiCliAuth = (auth: Record<string, unknown>): GoogleAuthSource | null => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['google', 'google.oauth']));
  const entryObject = asObject(entry);
  if (!entryObject) {
    return null;
  }

  const oauthObject = asObject(entryObject.oauth) ?? entryObject;
  const accessToken = asNonEmptyString(oauthObject.access) ?? asNonEmptyString(oauthObject.token);
  const refreshParts = parseGoogleRefreshToken(oauthObject.refresh);

  if (!accessToken && !refreshParts.refreshToken) {
    return null;
  }

  return {
    sourceId: 'gemini',
    sourceLabel: 'Gemini',
    accessToken,
    refreshToken: refreshParts.refreshToken,
    projectId: refreshParts.projectId ?? refreshParts.managedProjectId,
    expires: toTimestamp(oauthObject.expires),
    email: null,
  };
};

const resolveAntigravityAuth = (): GoogleAuthSource | null => {
  for (const filePath of ANTIGRAVITY_ACCOUNTS_PATHS) {
    const data = asObject(readJsonFile(filePath)) ?? {};
    const accounts = data.accounts;
    if (Array.isArray(accounts) && accounts.length > 0) {
      const index = typeof data.activeIndex === 'number' ? data.activeIndex : 0;
      const account = asObject(accounts[index] ?? accounts[0]);
      if (account && typeof account.refreshToken === 'string') {
        const refreshParts = parseGoogleRefreshToken(account.refreshToken);
        return {
          sourceId: 'antigravity',
          sourceLabel: 'Antigravity',
          refreshToken: refreshParts.refreshToken,
          projectId: asNonEmptyString(account.projectId)
            ?? asNonEmptyString(account.managedProjectId)
            ?? refreshParts.projectId
            ?? refreshParts.managedProjectId,
          email: asNonEmptyString(account.email),
          accessToken: null,
          expires: null,
        };
      }
    }
  }

  return null;
};

export const resolveGoogleAuthSources = (): GoogleAuthSource[] => {
  const auth = readAuthFile();
  const sources: GoogleAuthSource[] = [];

  const geminiAuth = resolveGeminiCliAuth(auth);
  if (geminiAuth) {
    sources.push(geminiAuth);
  }

  const antigravityAuth = resolveAntigravityAuth();
  if (antigravityAuth) {
    sources.push(antigravityAuth);
  }

  return sources;
};
