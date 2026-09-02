import fs from 'node:fs';
import path from 'node:path';
import { resolvePiariumDataDir } from '../../platform/data-paths.js';

export type ManagedQuotaProviderId = 'cursor' | 'ollama-cloud' | 'opencode-go';
const MANAGED_QUOTA_PROVIDERS = new Set<string>(['opencode-go', 'ollama-cloud', 'cursor']);

const credentialsDirectory = (): string => path.join(
  resolvePiariumDataDir(process),
  'quota',
);

const credentialPath = (providerId: string): string => {
  if (!MANAGED_QUOTA_PROVIDERS.has(providerId)) throw new Error('Unsupported credential provider');
  return path.join(credentialsDirectory(), `${providerId}.json`);
};

export const readQuotaCredential = <T>(
  providerId: ManagedQuotaProviderId,
  normalize: (value: unknown) => T | null,
): T | null => {
  try {
    return normalize(JSON.parse(fs.readFileSync(credentialPath(providerId), 'utf8')));
  } catch (error) {
    if (!error || typeof error !== 'object' || (error as { code?: unknown }).code !== 'ENOENT') {
      console.warn(`Failed to read ${providerId} quota credentials`);
    }
    return null;
  }
};

export const writeQuotaCredential = (providerId: string, credential: unknown): void => {
  const target = credentialPath(providerId);
  const directory = path.dirname(target);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* The successful rename removes the temporary path. */ }
  }
};

export const deleteQuotaCredential = (providerId: ManagedQuotaProviderId): void => {
  try { fs.unlinkSync(credentialPath(providerId)); } catch (error) {
    if (!error || typeof error !== 'object' || (error as { code?: unknown }).code !== 'ENOENT') throw error;
  }
};
