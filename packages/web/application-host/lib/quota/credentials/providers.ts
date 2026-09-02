import { deleteQuotaCredential, readQuotaCredential, writeQuotaCredential } from './store.js';
import type { ManagedQuotaProviderId } from './store.js';

const clean = (value: unknown): string => typeof value === 'string' && !/[\r\n]/.test(value) ? value.trim() : '';

export type ManagedCredential = Record<string, string>;
type CredentialNormalizer = (value: unknown) => ManagedCredential | null;

export const normalizers: Record<ManagedQuotaProviderId, CredentialNormalizer> = {
  'opencode-go': (value) => {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const workspaceId = clean(record.workspaceId);
    let authCookie = clean(record.authCookie);
    if (authCookie.startsWith('auth=')) authCookie = authCookie.slice(5).trim();
    return workspaceId && authCookie ? { workspaceId, authCookie } : null;
  },
  'ollama-cloud': (value) => {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const cookie = clean(record.cookie);
    return cookie ? { cookie } : null;
  },
  cursor: (value) => {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const accessToken = clean(record.accessToken);
    const refreshToken = clean(record.refreshToken);
    return accessToken || refreshToken ? { accessToken, refreshToken } : null;
  },
};

export const readManagedCredential = (providerId: ManagedQuotaProviderId): ManagedCredential | null => {
  const normalize = normalizers[providerId];
  return normalize ? readQuotaCredential(providerId, normalize) : null;
};

export const writeManagedCredential = (providerId: ManagedQuotaProviderId, value: unknown) => {
  const credential = normalizers[providerId]?.(value);
  if (!credential) throw new Error('Invalid credential');
  writeQuotaCredential(providerId, credential);
  return getManagedCredentialStatus(providerId);
};

export const getManagedCredentialStatus = (providerId: ManagedQuotaProviderId): Record<string, unknown> => {
  const credential = readManagedCredential(providerId);
  if (!credential) return { configured: false };
  if (providerId === 'opencode-go') return { configured: true, workspaceId: credential.workspaceId, secretMasked: '••••••••' };
  if (providerId === 'cursor') return { configured: true, hasRefreshToken: Boolean(credential.refreshToken), secretMasked: '••••••••' };
  return { configured: true, secretMasked: '••••••••' };
};

export const deleteManagedCredential = (providerId: ManagedQuotaProviderId): void => deleteQuotaCredential(providerId);
