import { refreshRuntimeUrlAuthToken, setRuntimeBearerToken, setRuntimeExtraHeaders } from '@/lib/runtime-auth';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import {
  activateRelayTunnel,
  deactivateRelayTunnel,
  getActiveRelayTunnel,
  type RelayRuntimeDescriptor,
} from '@/lib/relay/runtime-tunnel';

export { getActiveRelayTunnel };

export type RuntimeEndpointChangedDetail = {
  apiBaseUrl: string;
  previousApiBaseUrl: string;
  runtimeKey: string;
  previousRuntimeKey: string;
};

const RUNTIME_ENDPOINT_CHANGED_EVENT = 'piarium:runtime-endpoint-changed';
const RUNTIME_ENDPOINT_WILL_CHANGE_EVENT = 'piarium:runtime-endpoint-will-change';

let activeApiBaseUrl = '';
let activeRuntimeKey = '';
let runtimeEndpointGeneration = 1;

const setWindowRuntimeValue = <K extends '__PIARIUM_API_BASE_URL__' | '__PIARIUM_CLIENT_TOKEN__' | '__PIARIUM_RUNTIME_HEADERS__'>(
  runtimeWindow: typeof window & {
    __PIARIUM_API_BASE_URL__?: string;
    __PIARIUM_CLIENT_TOKEN__?: string;
    __PIARIUM_RUNTIME_HEADERS__?: Record<string, string>;
  },
  key: K,
  value: (typeof runtimeWindow)[K],
): void => {
  try {
    runtimeWindow[key] = value;
  } catch {
    // Electron preload exposes some initial globals through contextBridge, which
    // makes them read-only. Runtime switching must still update in-memory state.
  }
};

const normalizeRuntimeUrlKey = (value: string): string => {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    // Normalise pathname so root `/` becomes empty and no path ends with `/`.
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    // url.toString() still appends `/` when pathname is `/`; strip it
    // so every key uses the bare-origin form: `url:https://example.com`.
    return `url:${url.toString().replace(/\/+$/, '')}`;
  } catch {
    return `url:${value.trim().replace(/\/+$/, '') || 'default'}`;
  }
};

const readInjectedApiBaseUrl = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = (window as typeof window & { __PIARIUM_API_BASE_URL__?: string }).__PIARIUM_API_BASE_URL__;
  return typeof injected === 'string' ? injected.trim() : '';
};

const readInjectedLocalOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = (window as typeof window & { __PIARIUM_LOCAL_ORIGIN__?: string }).__PIARIUM_LOCAL_ORIGIN__;
  return typeof injected === 'string' ? injected.trim() : '';
};

const sameOrigin = (left: string, right: string): boolean => {
  if (!left || !right) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
};

export const getRuntimeApiBaseUrl = (): string => activeApiBaseUrl || readInjectedApiBaseUrl();

let cachedRuntimeKey = '';
let cachedActiveApiBaseUrl: string | null = null;
let cachedRawApiBaseUrl: string | undefined;
let cachedRawLocalOrigin: string | undefined;

const readRawRuntimeGlobal = (
  key: '__PIARIUM_API_BASE_URL__' | '__PIARIUM_LOCAL_ORIGIN__',
): string | undefined => {
  if (typeof window === 'undefined') return undefined;
  const value = (window as typeof window & {
    __PIARIUM_API_BASE_URL__?: string;
    __PIARIUM_LOCAL_ORIGIN__?: string;
  })[key];
  return typeof value === 'string' ? value : undefined;
};

export const getRuntimeEndpointGeneration = (): number => runtimeEndpointGeneration;

export const getRuntimeKey = (): string => {
  if (activeRuntimeKey) return activeRuntimeKey;

  const rawApiBaseUrl = readRawRuntimeGlobal('__PIARIUM_API_BASE_URL__');
  const rawLocalOrigin = readRawRuntimeGlobal('__PIARIUM_LOCAL_ORIGIN__');
  if (
    cachedActiveApiBaseUrl === activeApiBaseUrl
    && cachedRawApiBaseUrl === rawApiBaseUrl
    && cachedRawLocalOrigin === rawLocalOrigin
  ) {
    return cachedRuntimeKey;
  }

  const apiBaseUrl = getRuntimeApiBaseUrl();
  cachedRuntimeKey = sameOrigin(apiBaseUrl, readInjectedLocalOrigin())
    ? 'local'
    : normalizeRuntimeUrlKey(apiBaseUrl);
  cachedActiveApiBaseUrl = activeApiBaseUrl;
  cachedRawApiBaseUrl = rawApiBaseUrl;
  cachedRawLocalOrigin = rawLocalOrigin;
  return cachedRuntimeKey;
};

export const initializeRuntimeEndpoint = (options: { apiBaseUrl?: string | null; runtimeKey?: string | null } = {}): void => {
  if (activeApiBaseUrl || activeRuntimeKey) {
    return;
  }

  const apiBaseUrl = options.apiBaseUrl?.trim() || readInjectedApiBaseUrl();
  if (!apiBaseUrl) {
    return;
  }

  activeApiBaseUrl = apiBaseUrl;
  activeRuntimeKey = options.runtimeKey?.trim() || (sameOrigin(apiBaseUrl, readInjectedLocalOrigin()) ? 'local' : normalizeRuntimeUrlKey(apiBaseUrl));
};

export const switchRuntimeEndpoint = (options: { apiBaseUrl: string; clientToken?: string | null; runtimeKey?: string | null; requestHeaders?: Record<string, string> | null; relay?: RelayRuntimeDescriptor | null }): void => {
  const apiBaseUrl = options.apiBaseUrl.trim();
  const previousApiBaseUrl = getRuntimeApiBaseUrl();
  const previousRuntimeKey = getRuntimeKey();
  const runtimeKey = options.runtimeKey?.trim() || normalizeRuntimeUrlKey(apiBaseUrl);
  const detail = { apiBaseUrl, previousApiBaseUrl, runtimeKey, previousRuntimeKey };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<RuntimeEndpointChangedDetail>(RUNTIME_ENDPOINT_WILL_CHANGE_EVENT, { detail }));
  }
  runtimeEndpointGeneration += 1;
  activeApiBaseUrl = apiBaseUrl;
  activeRuntimeKey = runtimeKey;
  if (typeof window !== 'undefined') {
    const runtimeWindow = window as typeof window & {
      __PIARIUM_API_BASE_URL__?: string;
      __PIARIUM_CLIENT_TOKEN__?: string;
      __PIARIUM_RUNTIME_HEADERS__?: Record<string, string>;
    };
    setWindowRuntimeValue(runtimeWindow, '__PIARIUM_API_BASE_URL__', apiBaseUrl);
    setWindowRuntimeValue(runtimeWindow, '__PIARIUM_CLIENT_TOKEN__', options.clientToken || undefined);
    setWindowRuntimeValue(runtimeWindow, '__PIARIUM_RUNTIME_HEADERS__', options.requestHeaders || undefined);
  }
  configureRuntimeUrlResolver({ apiBaseUrl, realtimeBaseUrl: apiBaseUrl });
  setRuntimeExtraHeaders(options.requestHeaders || null);
  setRuntimeBearerToken(options.clientToken || null);
  // Relay mode routes runtime HTTP/WS through an E2EE tunnel instead of the
  // network. Activate the tunnel BEFORE minting the url token, since the mint
  // itself rides the tunnel (runtimeFetch -> tunnel.fetch).
  if (options.relay) {
    activateRelayTunnel(options.relay);
  } else {
    deactivateRelayTunnel();
  }
  void refreshRuntimeUrlAuthToken(apiBaseUrl).catch(() => {});
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<RuntimeEndpointChangedDetail>(RUNTIME_ENDPOINT_CHANGED_EVENT, {
      detail,
    }));
  }
};

export const subscribeRuntimeEndpointWillChange = (callback: (detail: RuntimeEndpointChangedDetail) => void): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    callback((event as CustomEvent<RuntimeEndpointChangedDetail>).detail);
  };
  window.addEventListener(RUNTIME_ENDPOINT_WILL_CHANGE_EVENT, listener);
  return () => window.removeEventListener(RUNTIME_ENDPOINT_WILL_CHANGE_EVENT, listener);
};

export const subscribeRuntimeEndpointChanged = (callback: (detail: RuntimeEndpointChangedDetail) => void): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  const listener = (event: Event) => {
    callback((event as CustomEvent<RuntimeEndpointChangedDetail>).detail);
  };
  window.addEventListener(RUNTIME_ENDPOINT_CHANGED_EVENT, listener);
  return () => window.removeEventListener(RUNTIME_ENDPOINT_CHANGED_EVENT, listener);
};
