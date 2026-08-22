import * as os from 'node:os';
import * as vscode from 'vscode';
import { perspectiveMark } from '@piarium/ui/src/components/ui/piarium-mark-perspective';
import {
  buildSplashCells,
  CUBE_EDGE_PX,
  splashPlaneCss,
} from '@piarium/ui/src/components/ui/piarium-splash-lattice';
import { getThemeKindName } from './theme';
import type { PiRuntimeConnectionStatus } from './piRuntime';
import type { WorkspaceFolderCandidate } from './workspaceResolver';

/**
 * The cube, projected through the same camera the floor is transformed by, in the editor's colours.
 *
 * Built once at module load. The geometry depends only on the cube's edge, which is a constant, and these
 * colours are CSS variables the editor resolves itself, so nothing here has to be rebuilt when the theme
 * changes.
 */
const MARK = perspectiveMark(CUBE_EDGE_PX, {
  stroke: 'var(--vscode-foreground)',
  faceFill: 'var(--vscode-editorWidget-background, transparent)',
  cellFill: 'var(--vscode-foreground)',
  // Without this the floor shows straight through the cube's translucent faces.
  occlusionFill: 'var(--vscode-editor-background, var(--vscode-sideBar-background))',
});

/**
 * The floor, emitted as markup rather than built by a script, because this document is generated anyway
 * and a webview's CSP is one less thing to reason about without another inline script.
 *
 * The floor's extent is fixed and larger than any panel, which is what makes emitting it here possible:
 * this shell cannot measure a panel that may be a narrow sidebar or a full editor tab, and it does not
 * have to. No breathing, though — the splash is up for a moment and the idle pulse starts after a second
 * and a bit, so here it would only ever be dead weight in the document.
 */
const GROUND_CELLS = buildSplashCells('boot', 'forward', false)
  .map((cell) => `<span class="pi-splash-cell" data-breathe="false" style="--pi-cell-delay:${cell.delayMs}ms"></span>`)
  .join('');

/**
 * Splash rules, taken from the shared generator with the editor's own colours. A webview that ignores
 * its host's theme looks broken, which is the one thing this host must not share with the others.
 */
const SPLASH_CSS = splashPlaneCss(
  {
    background: 'var(--vscode-editor-background, var(--vscode-sideBar-background))',
    line: 'var(--vscode-widget-border, var(--vscode-editorIndentGuide-background, rgba(128,128,128,0.24)))',
    cell: 'var(--vscode-editorIndentGuide-background, rgba(128,128,128,0.14))',
    stroke: 'var(--vscode-foreground)',
  },
  { withMark: true },
);

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
    /* Splash. Same floor and same cube as the web shell, generated from the shared module so this host
       cannot drift, but coloured from the editor theme: a webview that ignores its host's theme looks
       broken. */
${SPLASH_CSS}
    /* Errors only. The product name uses the shared status slot, so it is placed and timed once. */
    #loading-status {
      position: absolute;
      left: 50%;
      top: calc(56% + 84px);
      translate: -50% 0;
      max-width: 320px;
      color: var(--vscode-errorForeground, #f48771);
      font-size: 12px;
      text-align: center;
      white-space: pre-wrap;
    }
  </style>
  <title>Piarium</title>
</head>
<body>
  <div id="initial-loading" class="pi-splash" data-leaving="false" role="status">
    <div class="pi-splash-ground-clip" aria-hidden="true"><div class="pi-splash-horizon"><div class="pi-splash-ground">${GROUND_CELLS}</div></div></div>
    <span class="pi-splash-mark">${MARK.svg}</span>
    <div class="pi-splash-status">PIARIUM</div>
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
