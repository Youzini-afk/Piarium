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

type SessionPanelState = {
  panel: vscode.WebviewPanel;
  piRuntimeBridge: PiRuntimeWebviewBridge;
};

type ActiveEditorFilePayload = {
  filePath: string;
  fileName: string;
  relativePath: string;
  fileSize: number | null;
  dirty: boolean;
  selection: { startLine: number; endLine: number; text: string } | null;
};

const isSameActiveEditorFilePayload = (a: ActiveEditorFilePayload | null, b: ActiveEditorFilePayload | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.filePath === b.filePath
    && a.fileName === b.fileName
    && a.relativePath === b.relativePath
    && a.fileSize === b.fileSize
    && a.dirty === b.dirty
    && a.selection?.startLine === b.selection?.startLine
    && a.selection?.endLine === b.selection?.endLine
    && a.selection?.text === b.selection?.text;
};

export class SessionEditorPanelProvider implements vscode.Disposable {
  public static readonly viewType = 'piarium.sessionEditor';

  private _cachedStatus: PiRuntimeConnectionStatus = 'connecting';
  private _cachedError?: string;
  private _panels = new Map<string, SessionPanelState>();
  private _lastActivePanelId: string | null = null;
  private _broadcastSelectionDebounce: ReturnType<typeof setTimeout> | undefined;
  private _clearActiveEditorFileTimer: ReturnType<typeof setTimeout> | undefined;
  private _lastActiveEditorFilePayload: ActiveEditorFilePayload | null = null;
  private readonly _webviewDevServerUrl: string | null;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _piRuntime: VSCodePiRuntime,
  ) {
    this._webviewDevServerUrl = resolveWebviewDevServerUrl(this._context);
    this._context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => void this._broadcastActiveEditorFile()),
      vscode.window.onDidChangeTextEditorSelection(() => this._scheduleBroadcast()),
    );
  }

  public createOrShowNewSession(): void {
    const panelId = `new_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this._createPanel(panelId, t('New Session'), null);
  }

  public createOrShow(sessionId: string, title?: string): void {
    if (!sessionId?.trim()) return;
    const normalizedId = sessionId.trim();
    const sessionTitle = title?.trim() || t('Session');
    const existing = this._panels.get(normalizedId);
    if (existing) {
      existing.panel.title = sessionTitle;
      existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Active);
      return;
    }
    this._createPanel(normalizedId, sessionTitle, normalizedId);
  }

  public updateTheme(kind: vscode.ColorThemeKind): void {
    const themeKind = getThemeKindName(kind);
    void getWebviewShikiThemes().then((shikiThemes) => {
      for (const { panel } of this._panels.values()) {
        void panel.webview.postMessage({ type: 'themeChange', theme: { kind: themeKind, shikiThemes } });
      }
    });
  }

  public updateConnectionStatus(status: PiRuntimeConnectionStatus, error?: string): void {
    this._cachedStatus = status;
    this._cachedError = error;
    for (const entry of this._panels.values()) this._sendCachedStateToPanel(entry);
  }

  public notifySettingsSynced(settings: unknown): void {
    this._postCommandToPanels('settingsSynced', settings);
  }

  public notifyWindowFocusChanged(focused: boolean): void {
    this._postCommandToPanels('windowFocusChanged', { focused });
  }

  public addContextSelectionToActivePanel(selection: { filePath: string; filename: string; text: string }): boolean {
    if (!selection.filePath.trim() || !selection.filename.trim() || !selection.text.trim()) return false;
    return this._postToActivePanel('addContextSelection', selection);
  }

  public createSessionWithPromptInActivePanel(prompt: string): boolean {
    return prompt.trim() ? this._postToActivePanel('createSessionWithPrompt', { prompt }) : false;
  }

  public addFileAttachmentsToActivePanel(
    files: Array<{ filePath: string; fileName: string; fileSize: number | null }>,
  ): boolean {
    const cleaned = files.filter((entry) => entry.filePath.trim() && entry.fileName.trim());
    return cleaned.length > 0 && this._postToActivePanel('addFileAttachments', { files: cleaned });
  }

  public dispose(): void {
    if (this._broadcastSelectionDebounce !== undefined) clearTimeout(this._broadcastSelectionDebounce);
    if (this._clearActiveEditorFileTimer !== undefined) clearTimeout(this._clearActiveEditorFileTimer);
    for (const [panelId, entry] of [...this._panels]) {
      entry.panel.dispose();
      this._disposePanel(panelId);
    }
  }

  private _createPanel(panelId: string, title: string, initialSessionId: string | null): void {
    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel(
      SessionEditorPanelProvider.viewType,
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._extensionUri, distUri],
      },
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(this._extensionUri, 'assets', 'icon.svg'),
      dark: vscode.Uri.joinPath(this._extensionUri, 'assets', 'icon-titlebar.svg'),
    };
    const state: SessionPanelState = {
      panel,
      piRuntimeBridge: new PiRuntimeWebviewBridge(panel.webview, this._piRuntime),
    };
    this._panels.set(panelId, state);
    this._lastActivePanelId = panelId;
    panel.webview.html = this._getHtmlForWebview(panel.webview, initialSessionId);
    void this.updateTheme(vscode.window.activeColorTheme.kind);
    this._sendCachedStateToPanel(state);
    void this._broadcastActiveEditorFile();

    panel.onDidDispose(() => this._disposePanel(panelId), null, this._context.subscriptions);
    panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) this._lastActivePanelId = panelId;
    }, null, this._context.subscriptions);
    panel.webview.onDidReceiveMessage(async (message: BridgeRequest) => {
      if (state.piRuntimeBridge.handleMessage(message)) return;
      if (message.type === 'vscode:command') {
        const { command, args } = (message.payload || {}) as { command?: unknown; args?: unknown[] };
        if (command === 'piarium.updateSessionEditorTitle') {
          state.panel.title = typeof args?.[1] === 'string' && args[1].trim() ? args[1].trim() : t('Session');
          void state.panel.webview.postMessage({
            id: message.id,
            type: message.type,
            success: true,
            data: { result: true },
          });
          return;
        }
      }
      const response = await handleBridgeMessage(message, { context: this._context, piRuntime: this._piRuntime, webview: state.panel.webview });
      void state.panel.webview.postMessage(response);
      if (message.type === 'api:settings:save' && response.success) {
        void vscode.commands.executeCommand('piarium.internal.settingsSynced', response.data);
      }
    }, null, this._context.subscriptions);
  }

  private _getActivePanelEntry(): SessionPanelState | null {
    const active = Array.from(this._panels.entries()).find(([, entry]) => entry.panel.active);
    return this._panels.get(active?.[0] ?? this._lastActivePanelId ?? '') ?? null;
  }

  private _postToActivePanel(command: string, payload: unknown): boolean {
    const entry = this._getActivePanelEntry();
    if (!entry) return false;
    entry.panel.reveal(entry.panel.viewColumn ?? vscode.ViewColumn.Active, true);
    void entry.panel.webview.postMessage({ type: 'command', command, payload });
    return true;
  }

  private _sendCachedStateToPanel(entry: SessionPanelState): void {
    void entry.panel.webview.postMessage({
      type: 'connectionStatus',
      status: this._cachedStatus,
      error: this._cachedError,
    });
    void entry.panel.webview.postMessage({
      type: 'command',
      command: 'windowFocusChanged',
      payload: { focused: vscode.window.state.focused },
    });
    void entry.panel.webview.postMessage({
      type: 'command',
      command: 'activeEditorFile',
      payload: this._lastActiveEditorFilePayload,
    });
  }

  private _postCommandToPanels(command: string, payload: unknown): void {
    for (const { panel } of this._panels.values()) {
      void panel.webview.postMessage({ type: 'command', command, payload });
    }
  }

  private _scheduleBroadcast(): void {
    if (this._broadcastSelectionDebounce !== undefined) clearTimeout(this._broadcastSelectionDebounce);
    this._broadcastSelectionDebounce = setTimeout(() => {
      this._broadcastSelectionDebounce = undefined;
      void this._broadcastActiveEditorFile();
    }, 150);
  }

  private _scheduleClearActiveEditorFile(): void {
    if (this._clearActiveEditorFileTimer !== undefined) clearTimeout(this._clearActiveEditorFileTimer);
    this._clearActiveEditorFileTimer = setTimeout(() => {
      this._clearActiveEditorFileTimer = undefined;
      if (this._panels.size === 0 || this._lastActiveEditorFilePayload === null) return;
      this._lastActiveEditorFilePayload = null;
      this._postCommandToPanels('activeEditorFile', null);
    }, 200);
  }

  private async _broadcastActiveEditorFile(): Promise<void> {
    if (this._panels.size === 0) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      this._scheduleClearActiveEditorFile();
      return;
    }
    const editorUri = editor.document.uri;
    if (this._clearActiveEditorFileTimer !== undefined) clearTimeout(this._clearActiveEditorFileTimer);
    this._clearActiveEditorFileTimer = undefined;
    let fileSize: number | null = null;
    try {
      fileSize = (await vscode.workspace.fs.stat(editorUri)).size;
    } catch {
      // Unsaved or inaccessible documents have no stable file size.
    }
    if (vscode.window.activeTextEditor?.document.uri.toString() !== editorUri.toString()) return;
    const selection = editor.selection.isEmpty
      ? null
      : {
          startLine: editor.selection.start.line + 1,
          endLine: editor.selection.end.line + 1,
          text: editor.document.getText(editor.selection),
        };
    const payload: ActiveEditorFilePayload = {
      filePath: normalizeWindowsDriveLetter(editorUri.fsPath),
      fileName: editorUri.fsPath.replace(/\\/g, '/').split('/').pop() || '',
      relativePath: vscode.workspace.asRelativePath(editorUri, false),
      fileSize,
      dirty: editor.document.isDirty,
      selection,
    };
    if (isSameActiveEditorFilePayload(this._lastActiveEditorFilePayload, payload)) return;
    this._lastActiveEditorFilePayload = payload;
    this._postCommandToPanels('activeEditorFile', payload);
  }

  private _disposePanel(panelId: string): void {
    const entry = this._panels.get(panelId);
    if (!entry) return;
    entry.piRuntimeBridge.dispose();
    this._panels.delete(panelId);
    if (this._lastActivePanelId === panelId) this._lastActivePanelId = null;
  }

  private _getHtmlForWebview(webview: vscode.Webview, sessionId: string | null): string {
    return getWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      workspaceFolder: normalizeWindowsDriveLetter(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''),
      workspaceFolders: resolveWorkspaceFolders(vscode.workspace.workspaceFolders ?? []),
      initialStatus: this._cachedStatus,
      panelType: 'chat',
      initialSessionId: sessionId ?? undefined,
      viewMode: 'editor',
      extensionVersion: String(this._context.extension?.packageJSON?.version || ''),
      devServerUrl: this._webviewDevServerUrl,
    });
  }
}
