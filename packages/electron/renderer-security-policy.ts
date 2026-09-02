import { recordOf } from './runtime-types.js';

const asTrimmedString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export const REMOTE_SAFE_DESKTOP_COMMANDS = new Set<string>([
  'desktop_new_window',
  'desktop_new_window_at_url',
  'desktop_new_window_for_host',
  'desktop_set_window_title',
  'desktop_set_window_theme',
  'desktop_is_window_fullscreen',
  'desktop_start_window_drag',
  'desktop_minimize_current_window',
  'desktop_toggle_current_window_maximized',
  'desktop_close_current_window',
  'desktop_get_current_window_state',
  'desktop_get_app_version',
  'desktop_capture_page_rect',
]);

export const normalizeExternalHttpUrl = (raw: unknown): string | null => {
  const value = asTrimmedString(raw);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
};

export interface RendererTrustOptions {
  developmentUiOrigin?: string | null | undefined;
  localOrigins?: Array<string | null | undefined> | undefined;
  uiProtocol?: string | undefined;
}

export const isTrustedLocalRendererUrl = (raw: unknown, options: RendererTrustOptions = {}): boolean => {
  const value = asTrimmedString(raw);
  if (!value) return false;

  try {
    const url = new URL(value);
    const uiProtocol = asTrimmedString(options.uiProtocol) || 'piarium-ui';
    if (url.protocol === `${uiProtocol}:` && url.hostname === 'app') return true;

    const developmentUiOrigin = asTrimmedString(options.developmentUiOrigin);
    if (developmentUiOrigin && url.origin === developmentUiOrigin) return true;

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    for (const candidate of options.localOrigins || []) {
      const local = asTrimmedString(candidate);
      if (!local) continue;
      try {
        if (new URL(local).origin === url.origin) return true;
      } catch {
      }
    }
    return false;
  } catch {
    return false;
  }
};

export interface PreloadBootstrapInput extends RendererTrustOptions {
  apiBaseUrl?: unknown;
  clientToken?: unknown;
  homeDirectory?: unknown;
  localOrigin?: unknown;
  macosMajor?: unknown;
  macVibrancy?: unknown;
  relayHostId?: unknown;
  requestHeaders?: unknown;
  senderUrl?: unknown;
  trayEnabled?: unknown;
}

export const createPreloadBootstrapPayload = (input: PreloadBootstrapInput = {}) => {
  const localPage = isTrustedLocalRendererUrl(input.senderUrl, {
    uiProtocol: input.uiProtocol,
    developmentUiOrigin: input.developmentUiOrigin,
    localOrigins: input.localOrigins,
  });
  const shared = {
    localPage,
    localOrigin: asTrimmedString(input.localOrigin),
    apiBaseUrl: asTrimmedString(input.apiBaseUrl),
    macosMajor: Number.isFinite(input.macosMajor) ? input.macosMajor : 0,
    macVibrancy: input.macVibrancy !== false,
    trayEnabled: input.trayEnabled !== false,
  };
  if (!localPage) return shared;

  const requestHeaders = recordOf(input.requestHeaders);
  return {
    ...shared,
    clientToken: asTrimmedString(input.clientToken),
    requestHeaders,
    homeDirectory: asTrimmedString(input.homeDirectory),
    relayHostId: asTrimmedString(input.relayHostId),
  };
};
