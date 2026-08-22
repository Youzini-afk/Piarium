import * as os from 'node:os';
import * as vscode from 'vscode';
import {
  SPLASH_EXIT_CLASS,
  SPLASH_LATTICE_TRANSFORM,
  piariumMarkSvgMarkup,
} from '@piarium/ui/src/components/ui/piarium-logo-geometry';
import { getThemeKindName } from './theme';
import type { PiRuntimeConnectionStatus } from './piRuntime';
import type { WorkspaceFolderCandidate } from './workspaceResolver';

/**
 * The lattice is emitted as markup rather than built by a script, because this document is generated
 * anyway and a webview's CSP is one less thing to reason about without another inline script.
 *
 * A fixed extent is the trade for that: the panel can be a narrow sidebar or a full editor tab, and
 * this shell has no way to measure it. The size is chosen to overflow a wide tab and be cropped in a
 * sidebar, which is the harmless direction to be wrong in.
 */
const LATTICE_AXIS = 16;
const LATTICE_CELL_PX = 76;

/** Exit delay per cell, radiating from the mark at the centre. Mirrors `buildSplashCells`. */
const renderLatticeCells = (): string => {
  const mid = (LATTICE_AXIS - 1) / 2;
  const maxRadius = Math.hypot(mid, mid) || 1;
  const cells: string[] = [];

  for (let row = 0; row < LATTICE_AXIS; row += 1) {
    for (let col = 0; col < LATTICE_AXIS; col += 1) {
      const delay = Math.round((Math.hypot(col - mid, row - mid) / maxRadius) * 460);
      cells.push(`<i style="--d:${delay}ms"></i>`);
    }
  }

  return cells.join('');
};

export interface WebviewHtmlOptions {
  devServerUrl?: string | null;
  extensionUri: vscode.Uri;
  extensionVersion?: string;
  initialStatus: PiRuntimeConnectionStatus;
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
  const latticeCells = renderLatticeCells();
  const bootstrapConfig = htmlSafeJson({
    workspaceFolder,
    workspaceFolders,
    theme: getThemeKindName(vscode.window.activeColorTheme.kind),
    connectionStatus: initialStatus,
    extensionVersion,
    platform: os.platform(),
    arch: os.arch(),
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
    /* Splash. Shares the isometric lattice with the web shell, but takes its colours from the editor
       theme rather than Piarium's: a webview that ignores the host theme looks broken. The mark and
       the lattice projection come from @piarium/ui's geometry module, so this is generated rather
       than a hand-maintained copy. */
    #initial-loading {
      position: fixed;
      inset: 0;
      z-index: 9999;
      overflow: hidden;
      background: var(--vscode-editor-background, var(--vscode-sideBar-background));
    }
    #initial-loading.${SPLASH_EXIT_CLASS} { pointer-events: none; }

    #initial-loading-lattice {
      position: absolute;
      left: 50%;
      top: 50%;
      display: grid;
      grid-template-columns: repeat(${LATTICE_AXIS}, ${LATTICE_CELL_PX}px);
      grid-template-rows: repeat(${LATTICE_AXIS}, ${LATTICE_CELL_PX}px);
      transform-origin: center;
      transform: translate(-50%, -50%) ${SPLASH_LATTICE_TRANSFORM};
    }
    /* Two edges per cell, so neighbours do not stack into a 2px rule. */
    #initial-loading-lattice > i {
      box-shadow: inset -1px -1px 0 var(--vscode-widget-border, var(--vscode-contrastBorder, transparent));
    }
    #initial-loading.${SPLASH_EXIT_CLASS} #initial-loading-lattice > i {
      animation: pi-splash-cell-out 400ms cubic-bezier(0.4, 0, 0.3, 1) both;
      animation-delay: var(--d);
    }
    @keyframes pi-splash-cell-out {
      to { opacity: 0; transform: scale(0.82); }
    }

    #initial-loading-center {
      position: absolute;
      left: 50%;
      top: 50%;
      translate: -50% -50%;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      padding: 0 20px;
      text-align: center;
    }
    #initial-loading.${SPLASH_EXIT_CLASS} #initial-loading-center {
      animation: pi-splash-mark-out 420ms 60ms cubic-bezier(0.4, 0, 0.3, 1) both;
    }
    @keyframes pi-splash-mark-out {
      to { opacity: 0; transform: scale(1.06); }
    }

    .piarium-name {
      font-size: 12px;
      letter-spacing: 0.08em;
      opacity: 0.72;
      animation: pi-splash-name-in 480ms 620ms ease both;
    }
    @keyframes pi-splash-name-in { from { opacity: 0; } to { opacity: 0.72; } }

    #loading-status {
      max-width: 320px;
      color: var(--vscode-errorForeground, #f48771);
      font-size: 12px;
      text-align: center;
      white-space: pre-wrap;
    }

    /* Reduced motion drops the staged lattice and mark animation for one fade of the whole cover.
       It must still show the cover: hiding it would put the unpainted panel back. */
    @media (prefers-reduced-motion: reduce) {
      #initial-loading.${SPLASH_EXIT_CLASS} #initial-loading-lattice > i,
      #initial-loading.${SPLASH_EXIT_CLASS} #initial-loading-center,
      .piarium-name {
        animation: none;
      }
      .piarium-name { opacity: 0.72; }
      #initial-loading { transition: opacity 260ms ease; }
      #initial-loading.${SPLASH_EXIT_CLASS} { opacity: 0; }
    }
  </style>
  <title>Piarium</title>
</head>
<body>
  <div id="initial-loading">
    <div id="initial-loading-lattice" aria-hidden="true">${latticeCells}</div>
    <div id="initial-loading-center">
      ${piariumMarkSvgMarkup(96, {
        stroke: 'var(--vscode-foreground)',
        faceFill: 'var(--vscode-editorWidget-background, transparent)',
        cellFill: 'var(--vscode-foreground)',
      })}
      <div class="piarium-name">PIARIUM</div>
      <div id="loading-status" role="status" aria-live="polite"></div>
    </div>
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
