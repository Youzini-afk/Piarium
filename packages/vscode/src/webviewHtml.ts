import * as os from 'node:os';
import * as vscode from 'vscode';
import { getThemeKindName } from './theme';
import type { PiRuntimeConnectionStatus } from './piRuntime';
import type { WorkspaceFolderCandidate } from './workspaceResolver';

export type PanelType = 'chat' | 'agentManager' | 'settings';

export interface WebviewHtmlOptions {
  devServerUrl?: string | null;
  extensionUri: vscode.Uri;
  extensionVersion?: string;
  initialSessionId?: string;
  initialSettingsPage?: string;
  initialStatus: PiRuntimeConnectionStatus;
  panelType?: PanelType;
  viewMode?: 'sidebar' | 'editor';
  webview: vscode.Webview;
  workspaceFolder: string;
  workspaceFolders?: WorkspaceFolderCandidate[];
}

const asCspToken = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const toOrigin = (value: string | null | undefined): string | null => {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const uniqueTokens = (values: Array<string | null | undefined>): string => (
  Array.from(new Set(values.map(asCspToken).filter((value): value is string => Boolean(value)))).join(' ')
);

const htmlSafeJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

export function getWebviewHtml(options: WebviewHtmlOptions): string {
  const {
    webview,
    extensionUri,
    workspaceFolder,
    workspaceFolders = [],
    initialStatus,
    panelType = 'chat',
    initialSessionId,
    initialSettingsPage,
    viewMode = 'sidebar',
    devServerUrl,
    extensionVersion = '',
  } = options;
  const scriptPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'assets', 'index.js');
  const scriptUri = webview.asWebviewUri(scriptPath);
  const normalizedDevServerUrl = asCspToken(devServerUrl)?.replace(/\/$/, '') ?? null;
  const devServerOrigin = toOrigin(normalizedDevServerUrl);
  const styleSrc = uniqueTokens([webview.cspSource, "'unsafe-inline'", devServerOrigin]);
  const scriptSrc = uniqueTokens([webview.cspSource, "'unsafe-inline'", "'unsafe-eval'", devServerOrigin]);
  const connectSrc = uniqueTokens(['*', 'ws:', 'wss:', 'http:', 'https:', devServerOrigin]);
  const imgSrc = uniqueTokens([webview.cspSource, 'data:', 'https:', devServerOrigin]);
  const fontSrc = uniqueTokens([webview.cspSource, 'data:', devServerOrigin]);
  const workerSrc = uniqueTokens([webview.cspSource, 'blob:', devServerOrigin]);
  const documentLanguage = vscode.env.language.replace(/[^A-Za-z0-9-]/g, '') || 'en';
  const runtimeConnectionFailed = htmlSafeJson(vscode.l10n.t('Piarium: Pi runtime connection failed'));
  const waitingForDevelopmentServer = htmlSafeJson(vscode.l10n.t('Piarium: Waiting for the webview development server'));
  const bootstrapConfig = htmlSafeJson({
    workspaceFolder,
    workspaceFolders,
    theme: getThemeKindName(vscode.window.activeColorTheme.kind),
    connectionStatus: initialStatus,
    extensionVersion,
    platform: os.platform(),
    arch: os.arch(),
    panelType,
    viewMode,
    initialSessionId: initialSessionId ?? null,
    initialSettingsPage: initialSettingsPage ?? null,
  });

  return `<!DOCTYPE html>
<html lang="${documentLanguage}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${styleSrc}; script-src ${scriptSrc}; connect-src ${connectSrc}; img-src ${imgSrc}; font-src ${fontSrc}; worker-src ${workerSrc};">
  <style>
    html, body, #root { height: 100%; width: 100%; margin: 0; padding: 0; }
    body {
      overflow: hidden;
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    }
    #initial-loading {
      position: fixed;
      inset: 0;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
      transition: opacity 180ms ease-out;
    }
    #initial-loading.fade-out { opacity: 0; pointer-events: none; }
    .piarium-mark {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, transparent));
      border-radius: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      font: 600 20px/1 var(--vscode-font-family, sans-serif);
      animation: piarium-breathe 1.6s ease-in-out infinite;
    }
    .piarium-name { font-size: 12px; letter-spacing: 0.08em; opacity: 0.72; }
    #loading-status {
      max-width: 320px;
      padding: 0 20px;
      color: var(--vscode-errorForeground, #f48771);
      font-size: 12px;
      text-align: center;
      white-space: pre-wrap;
    }
    @keyframes piarium-breathe {
      0%, 100% { opacity: 0.62; transform: scale(0.97); }
      50% { opacity: 1; transform: scale(1); }
    }
    @media (prefers-reduced-motion: reduce) { .piarium-mark { animation: none; } }
  </style>
  <title>Piarium</title>
</head>
<body>
  <div id="initial-loading">
    <div class="piarium-mark" aria-hidden="true">π</div>
    <div class="piarium-name">PIARIUM</div>
    <div id="loading-status" role="status" aria-live="polite"></div>
  </div>
  <div id="root"></div>
  <script>
    window.process = window.process || { env: { NODE_ENV: 'production' }, platform: '', version: '', browser: true };
    window.__VSCODE_CONFIG__ = ${bootstrapConfig};
    window.__PIARIUM_HOME__ = ${htmlSafeJson(os.homedir())};
    window.addEventListener('message', function(event) {
      var message = event.data;
      if (!message || message.type !== 'connectionStatus') return;
      var status = document.getElementById('loading-status');
      if (status) status.textContent = message.status === 'error' ? (message.error || ${runtimeConnectionFailed}) : '';
    });
  </script>
  <script type="module">
    const productionEntryUrl = ${htmlSafeJson(scriptUri.toString())};
    const devServerUrl = ${normalizedDevServerUrl ? htmlSafeJson(normalizedDevServerUrl) : 'null'};

    const loadProductionBundle = () => {
      const script = document.createElement('script');
      script.type = 'module';
      script.src = productionEntryUrl;
      document.body.appendChild(script);
    };

    if (!devServerUrl) {
      loadProductionBundle();
    } else {
      const status = document.getElementById('loading-status');
      let attempt = 0;
      const waitForRootMount = (timeoutMs) => new Promise((resolve) => {
        const root = document.getElementById('root');
        if (!root || root.childNodes.length > 0) return resolve(Boolean(root?.childNodes.length));
        const observer = new MutationObserver(() => {
          if (root.childNodes.length > 0) {
            observer.disconnect();
            clearTimeout(timer);
            resolve(true);
          }
        });
        observer.observe(root, { childList: true, subtree: true });
        const timer = window.setTimeout(() => {
          observer.disconnect();
          resolve(root.childNodes.length > 0);
        }, timeoutMs);
      });
      const loadDevelopmentBundle = () => {
        if (status) status.textContent = '';
        Promise.resolve()
          .then(() => import(devServerUrl + '/@vite/client'))
          .then(() => import(devServerUrl + '/@react-refresh'))
          .then((module) => {
            const refresh = module?.default;
            if (typeof refresh?.injectIntoGlobalHook === 'function') {
              refresh.injectIntoGlobalHook(window);
              window.$RefreshReg$ = () => {};
              window.$RefreshSig$ = () => (type) => type;
              window.__vite_plugin_react_preamble_installed__ = true;
            }
          })
          .then(() => import(devServerUrl + '/main.tsx'))
          .then(() => waitForRootMount(4000))
          .then((mounted) => {
            if (!mounted) throw new Error('Development bundle loaded but did not mount');
          })
          .catch((error) => {
            attempt += 1;
            console.warn('[Piarium] VS Code webview development bundle unavailable; retrying', { attempt }, error);
            if (status) status.textContent = ${waitingForDevelopmentServer};
            window.setTimeout(loadDevelopmentBundle, 500);
          });
      };
      loadDevelopmentBundle();
    }
  </script>
</body>
</html>`;
}
