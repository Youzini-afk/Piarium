import type { BrowserWindow } from 'electron';

export interface RendererRuntimeConfig {
  apiBaseUrl: string;
  clientToken: string;
  relayHostId?: string | undefined;
  requestHeaders: Record<string, string>;
}

declare module 'electron' {
  interface BrowserWindow {
    __piariumInitScript?: string | null | undefined;
    __piariumLabel?: string | undefined;
    __piariumMiniChat?: boolean | undefined;
    __piariumMiniChatSessionId?: string | undefined;
    __piariumPinned?: boolean | undefined;
    __piariumRuntimeConfig?: RendererRuntimeConfig | undefined;
    __piariumTitleBarOverlayEnabled?: boolean | undefined;
    setTrafficLightPosition?(position: { x: number; y: number }): void;
  }
}

declare global {
  const __PIARIUM_UPDATER_E2E_BUILD__: boolean | undefined;
}

export type WindowFocusListener = (event: Electron.Event, browserWindow: BrowserWindow) => void;
