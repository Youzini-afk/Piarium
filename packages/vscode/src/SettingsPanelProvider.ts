import * as vscode from 'vscode';
import { handleBridgeMessage, type BridgeRequest } from './bridge';
import { normalizeWindowsDriveLetter } from './pathUtils';
import type { PiRuntimeConnectionStatus, VSCodePiRuntime } from './piRuntime';
import { PiRuntimeWebviewBridge } from './piRuntimeWebviewBridge';
import { getWebviewShikiThemes } from './shikiThemes';
import { getThemeKindName } from './theme';
import { resolveWebviewDevServerUrl } from './webviewDevServer';
import { getWebviewHtml } from './webviewHtml';

export class SettingsPanelProvider implements vscode.Disposable {
  public static readonly viewType = 'openchamber.settings';

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

  public createOrShow(settingsPage?: string): void {
    const normalizedSettingsPage = settingsPage?.trim() || undefined;
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.One);
      if (normalizedSettingsPage) {
        void this._panel.webview.postMessage({
          type: 'command',
          command: 'showSettingsPage',
          payload: { page: normalizedSettingsPage },
        });
      }
      return;
    }

    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel(
      SettingsPanelProvider.viewType,
      'Piarium Settings',
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
    panel.webview.html = this._getHtmlForWebview(panel.webview, normalizedSettingsPage);
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
      const response = await handleBridgeMessage(message, { context: this._context });
      void panel.webview.postMessage(response);
      if (message.type === 'api:settings:save' && response.success) {
        void vscode.commands.executeCommand('openchamber.internal.settingsSynced', response.data);
      }
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

  public notifySettingsSynced(settings: unknown): void {
    void this._panel?.webview.postMessage({ type: 'command', command: 'settingsSynced', payload: settings });
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
  }

  private _getHtmlForWebview(webview: vscode.Webview, initialSettingsPage?: string): string {
    return getWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      workspaceFolder: normalizeWindowsDriveLetter(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''),
      initialStatus: this._cachedStatus,
      cliAvailable: true,
      panelType: 'settings',
      initialSettingsPage,
      viewMode: 'editor',
      extensionVersion: String(this._context.extension?.packageJSON?.version || ''),
      devServerUrl: this._webviewDevServerUrl,
    });
  }
}
