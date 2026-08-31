import type { RuntimeAPIs } from '@piarium/application-client';

let registeredRuntimeAPIs: RuntimeAPIs | null = null;

export const registerRuntimeAPIs = (apis: RuntimeAPIs | null): void => {
  registeredRuntimeAPIs = apis;
};

export const getRegisteredRuntimeAPIs = (): RuntimeAPIs | null => {
  if (registeredRuntimeAPIs) {
    return registeredRuntimeAPIs;
  }

  if (typeof window === 'undefined') {
    return null;
  }

  return (window as typeof window & { __PIARIUM_RUNTIME_APIS__?: RuntimeAPIs })
    .__PIARIUM_RUNTIME_APIS__ ?? null;
};
