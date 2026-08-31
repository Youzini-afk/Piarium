import React from 'react';
import type { RuntimeAPISelector, RuntimeAPIs } from '@piarium/application-client';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';

export const useRuntimeAPIs = (): RuntimeAPIs => {
  const apis = React.useContext(RuntimeAPIContext);
  if (!apis) {
    throw new Error('Runtime APIs are not available. Did you forget to wrap the app in <RuntimeAPIProvider>?');
  }
  return apis;
};

export const useRuntimeAPI = <TValue,>(selector: RuntimeAPISelector<TValue>): TValue => {
  const apis = useRuntimeAPIs();
  return selector(apis);
};

export const useIsVSCodeRuntime = (): boolean => useRuntimeAPI((api) => api.runtime.isVSCode);
