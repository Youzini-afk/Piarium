import type { DesktopBootOutcome } from '@/lib/desktopBoot';

declare global {
  interface Window {
    __PIARIUM_HOME__?: string;
    __PIARIUM_MACOS_MAJOR__?: number;
    __PIARIUM_LOCAL_ORIGIN__?: string;
    __PIARIUM_ELECTRON__?: { runtime?: string; arch?: string; macVibrancy?: boolean; macVibrancySupported?: boolean; trayEnabled?: boolean };
    __PIARIUM_PLATFORM__?: string;
    __PIARIUM_DESKTOP_BOOT_OUTCOME__?: DesktopBootOutcome;
  }

  interface WebviewElement extends HTMLElement {
    loadURL(url: string): void;
    goBack(): void;
    goForward(): void;
    reload(): void;
    getURL(): string;
    getTitle(): string;
    isLoading(): boolean;
    getWebContentsId(): number;
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<WebviewElement> & {
          src?: string;
          partition?: string;
          preload?: string;
          nodeintegration?: string;
          allowpopups?: string;
          ref?: React.Ref<WebviewElement>;
        },
        WebviewElement
      >;
    }
  }
}

export {};
