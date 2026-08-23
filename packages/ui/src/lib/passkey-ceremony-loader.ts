import type { PasskeyAuthenticationOptions } from './passkey-ceremony';

type CeremonyModule = typeof import('./passkey-ceremony');
let ceremonyModulePromise: Promise<CeremonyModule> | null = null;

const loadCeremonyModule = (): Promise<CeremonyModule> => {
  ceremonyModulePromise ??= import('./passkey-ceremony');
  return ceremonyModulePromise;
};

export const isPasskeyCeremonyAbort = (error: unknown): boolean => (
  Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ERROR_CEREMONY_ABORTED')
);

export const cancelPasskeyCeremony = (): void => {
  if (!ceremonyModulePromise) return;
  void ceremonyModulePromise.then((module) => module.cancelPasskeyCeremony()).catch(() => undefined);
};

export const registerCurrentDevicePasskey = async () => (
  (await loadCeremonyModule()).registerCurrentDevicePasskey()
);

export const authenticateWithPasskey = async (
  trustDevice: boolean,
  options: PasskeyAuthenticationOptions = {},
) => (await loadCeremonyModule()).authenticateWithPasskey(trustDevice, options);

export type { PasskeyAuthenticationOptions };
