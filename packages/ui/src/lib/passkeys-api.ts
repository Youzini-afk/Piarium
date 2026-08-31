import { runtimeFetch } from '@piarium/application-client';

const PASSKEY_LIST_ENDPOINT = '/api/passkeys';
const PASSKEY_STATUS_ENDPOINT = '/auth/passkey/status';
const AUTH_RESET_ENDPOINT = '/api/auth/reset';

export type PasskeyStatus = {
  enabled: boolean;
  hasPasskeys: boolean;
  passkeyCount: number;
  rpID: string | null;
};

export type StoredPasskey = {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  deviceType: string;
  backedUp: boolean;
};

export const defaultPasskeyStatus: PasskeyStatus = {
  enabled: false,
  hasPasskeys: false,
  passkeyCount: 0,
  rpID: null,
};

export const postPasskeyJson = async (url: string, body?: unknown): Promise<Response> => runtimeFetch(url, {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const passkeyErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  } catch {
    // Malformed error responses still fall back to the caller's stable message.
  }
  return fallback;
};

export const browserSupportsPasskeys = (): boolean => (
  typeof window !== 'undefined'
  && typeof window.PublicKeyCredential === 'function'
  && typeof navigator !== 'undefined'
  && navigator.credentials !== undefined
);

export const getPasskeySupportState = () => {
  if (typeof window === 'undefined') {
    return { supported: false, reason: 'Passkeys are unavailable outside the browser.' };
  }
  if (!window.isSecureContext) {
    return { supported: false, reason: 'Passkeys require HTTPS or localhost.' };
  }
  return { supported: true, reason: '' };
};

export const fetchPasskeyStatus = async (): Promise<PasskeyStatus> => {
  const response = await runtimeFetch(PASSKEY_STATUS_ENDPOINT, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return defaultPasskeyStatus;
  const payload = await response.json().catch(() => null);
  return {
    enabled: payload?.enabled === true,
    hasPasskeys: payload?.hasPasskeys === true,
    passkeyCount: typeof payload?.passkeyCount === 'number' ? payload.passkeyCount : 0,
    rpID: typeof payload?.rpID === 'string' && payload.rpID ? payload.rpID : null,
  };
};

export const fetchStoredPasskeys = async (): Promise<StoredPasskey[]> => {
  const response = await runtimeFetch(PASSKEY_LIST_ENDPOINT, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(await passkeyErrorMessage(response, 'Could not load passkeys.'));
  }
  const payload = await response.json().catch(() => null);
  return Array.isArray(payload?.passkeys) ? payload.passkeys : [];
};

export const revokeStoredPasskey = async (id: string) => {
  const response = await runtimeFetch(`${PASSKEY_LIST_ENDPOINT}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(await passkeyErrorMessage(response, 'Could not remove passkey.'));
  }
  return response.json().catch(() => null);
};

export const resetAllAuth = async () => {
  const response = await postPasskeyJson(AUTH_RESET_ENDPOINT);
  if (!response.ok) {
    throw new Error(await passkeyErrorMessage(response, 'Could not clear saved authentication.'));
  }
  return response.json().catch(() => null);
};
