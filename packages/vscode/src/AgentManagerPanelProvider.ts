import * as vscode from 'vscode';
import { handleBridgeMessage, type BridgeRequest } from './bridge';
import { normalizeWindowsDriveLetter } from './pathUtils';
import type { PiRuntimeConnectionStatus, VSCodePiRuntime } from './piRuntime';
import { PiRuntimeWebviewBridge } from './piRuntimeWebviewBridge';
import { getWebviewShikiThemes } from './shikiThemes';
import { getThemeKindName } from './theme';
import { resolveWebviewDevServerUrl } from './webviewDevServer';
import { getWebviewHtml } from './webviewHtml';
import { resolveWorkspaceFolders } from './workspaceResolver';

const t = vscode.l10n.t;

export class AgentManagerPanelProvider implements vscode.Disposable {
  public static readonly viewType = 'piarium.agentManager';

  private _panel?: vscode.WebviewPanel;
  private _cachedStatus: PiRuntimeConnectionStatus = 'connecting';
  private _cachedError?: string;
  private _piRuntimeBridge?: PiRuntimeWebviewBridge;
  private readonly _webviewDevServerUrl: string | null;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _piRuntime: VSCodePiRuntime,
  ) {
    this._webviewDevServerUrl = resolveWebviewDevServerUrl(this._context);
  }

  public createOrShow(): void {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel(
      AgentManagerPanelProvider.viewType,
      t('Agent Manager'),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._extensionUri, distUri],
      },
    );
    this._panel = panel;
    panel.iconPath = {
      light: vscode.Uri.joinPath(this._extensionUri, 'assets', 'icon.svg'),
      dark: vscode.Uri.joinPath(this._extensionUri, 'assets', 'icon-titlebar.svg'),
    };
    panel.webview.html = this._getHtmlForWebview(panel.webview);
    this._piRuntimeBridge = new PiRuntimeWebviewBridge(panel.webview, this._piRuntime);
    void this.updateTheme(vscode.window.activeColorTheme.kind);
    this._sendCachedState();

    panel.onDidDispose(() => {
      this._piRuntimeBridge?.dispose();
      this._piRuntimeBridge = undefined;
      if (this._panel === panel) this._panel = undefined;
    }, null, this._context.subscriptions);

    panel.webview.onDidReceiveMessage(async (message: BridgeRequest) => {
      if (this._piRuntimeBridge?.handleMessage(message)) return;
      void panel.webview.postMessage(await handleBridgeMessage(message, { context: this._context, piRuntime: this._piRuntime, webview: panel.webview }));
    }, null, this._context.subscriptions);
  }

  public updateTheme(kind: vscode.ColorThemeKind): void {
    if (!this._panel) return;
    void getWebviewShikiThemes().then((shikiThemes) => {
      void this._panel?.webview.postMessage({
        type: 'themeChange',
        theme: { kind: getThemeKindName(kind), shikiThemes },
      });
    });
  }

  public updateConnectionStatus(status: PiRuntimeConnectionStatus, error?: string): void {
    this._cachedStatus = status;
    this._cachedError = error;
    this._sendCachedState();
  }

  public notifyWindowFocusChanged(focused: boolean): void {
    void this._panel?.webview.postMessage({
      type: 'command',
      command: 'windowFocusChanged',
      payload: { focused },
    });
  }

  public dispose(): void {
    this._panel?.dispose();
    this._piRuntimeBridge?.dispose();
    this._piRuntimeBridge = undefined;
    this._panel = undefined;
  }

  private _sendCachedState(): void {
    void this._panel?.webview.postMessage({
      type: 'connectionStatus',
      status: this._cachedStatus,
      error: this._cachedError,
    });
    this.notifyWindowFocusChanged(vscode.window.state.focused);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    return getWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      workspaceFolder: normalizeWindowsDriveLetter(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''),
      workspaceFolders: resolveWorkspaceFolders(vscode.workspace.workspaceFolders ?? []),
      initialStatus: this._cachedStatus,
      panelType: 'agentManager',
      viewMode: 'editor',
      extensionVersion: String(this._context.extension?.packageJSON?.version || ''),
      devServerUrl: this._webviewDevServerUrl,
    });
  }
}
