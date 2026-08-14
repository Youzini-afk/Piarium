import * as vscode from 'vscode';
import { handleBridgeMessage, type BridgeRequest, type BridgeResponse } from './bridge';
import { getThemeKindName } from './theme';
import { getWebviewShikiThemes } from './shikiThemes';
import { getWebviewHtml } from './webviewHtml';
import { resolveWebviewDevServerUrl } from './webviewDevServer';
import { normalizeWindowsDriveLetter } from './pathUtils';
import { resolveWorkspaceFolders, type WorkspaceFolderCandidate } from './workspaceResolver';
import type { PiRuntimeConnectionStatus, VSCodePiRuntime } from './piRuntime';
import { PiRuntimeWebviewBridge } from './piRuntimeWebviewBridge';

type ActiveEditorFilePayload = {
  filePath: string;
  fileName: string;
  relativePath: string;
  fileSize: number | null;
  selection: { startLine: number; endLine: number; text: string } | null;
};

const isSameActiveEditorFilePayload = (a: ActiveEditorFilePayload | null, b: ActiveEditorFilePayload | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.filePath === b.filePath
    && a.fileName === b.fileName
    && a.relativePath === b.relativePath
    && a.fileSize === b.fileSize
    && a.selection?.startLine === b.selection?.startLine
    && a.selection?.endLine === b.selection?.endLine
    && a.selection?.text === b.selection?.text;
};

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'piarium.chatView';

  private _view?: vscode.WebviewView;

  public isVisible() {
    return this._view?.visible ?? false;
  }

  public hasResolvedView() {
    return this._view !== undefined;
  }

  // Cache latest status/URL for when webview is resolved after connection is ready
  private _cachedStatus: PiRuntimeConnectionStatus = 'connecting';
  private _cachedError?: string;
  private _piRuntimeBridge?: PiRuntimeWebviewBridge;
  private readonly _webviewDevServerUrl: string | null;
  private _broadcastSelectionDebounce: ReturnType<typeof setTimeout> | undefined;
  private _clearActiveEditorFileTimer: ReturnType<typeof setTimeout> | undefined;
  private _lastActiveEditorFilePayload: ActiveEditorFilePayload | null = null;

  // Message delivery confirmation and retry
  private readonly _pendingMessages = new Set<string>();
  private readonly _messageTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly _MESSAGE_TIMEOUT = 5000; // 5 seconds
  private readonly _MAX_RETRIES = 3;

  private _createMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private _clearPendingMessages(): void {
    for (const timeout of this._messageTimeouts.values()) {
      clearTimeout(timeout);
    }
    this._messageTimeouts.clear();
    this._pendingMessages.clear();
  }

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

  public resolveWebviewView(
    webviewView: vscode.WebviewView
  ) {
    this._clearPendingMessages();
    this._view = webviewView;

    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri, distUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    this._piRuntimeBridge = new PiRuntimeWebviewBridge(webviewView.webview, this._piRuntime);
    // Send theme payload (including optional Shiki theme JSON) after the webview is set up.
    void this.updateTheme(vscode.window.activeColorTheme.kind);

    // Send cached connection status and API URL (may have been set before webview was resolved)
    this._sendCachedState();

    // Send current active editor file state to the new webview
    this._lastActiveEditorFilePayload = null;
    void this._broadcastActiveEditorFile();

    webviewView.onDidDispose(() => {
      if (this._view !== webviewView) return;
      if (this._broadcastSelectionDebounce !== undefined) {
        clearTimeout(this._broadcastSelectionDebounce);
        this._broadcastSelectionDebounce = undefined;
      }
      if (this._clearActiveEditorFileTimer !== undefined) {
        clearTimeout(this._clearActiveEditorFileTimer);
        this._clearActiveEditorFileTimer = undefined;
      }
      this._lastActiveEditorFilePayload = null;
      this._clearPendingMessages();
      this._piRuntimeBridge?.dispose();
      this._piRuntimeBridge = undefined;
      this._view = undefined;
    });

    webviewView.webview.onDidReceiveMessage(async (message: (BridgeRequest & { _msgId?: string }) | { type: 'bridge:ack'; _msgId: string }) => {
      if (this._piRuntimeBridge?.handleMessage(message)) return;
      if (message.type === 'bridge:ack' && typeof message._msgId === 'string') {
        this._confirmMessage(message._msgId);
        return;
      }

      if (!('id' in message) || typeof message.id !== 'string') {
        return;
      }

      const response = await handleBridgeMessage(message, { context: this._context, piRuntime: this._piRuntime });
      void this._sendMessageWithRetry(response);

      if (message.type === 'api:settings:save' && response.success) {
        void vscode.commands.executeCommand('piarium.internal.settingsSynced', response.data);
      }
    });
  }

  public updateTheme(kind: vscode.ColorThemeKind) {
    if (this._view) {
      const themeKind = getThemeKindName(kind);
      void getWebviewShikiThemes().then((shikiThemes) => {
        this._view?.webview.postMessage({
          type: 'themeChange',
          theme: { kind: themeKind, shikiThemes },
        });
      });
    }
  }

  public updateConnectionStatus(status: PiRuntimeConnectionStatus, error?: string) {
    // Cache the latest state
    this._cachedStatus = status;
    this._cachedError = error;

    // Send to webview if it exists
    this._sendCachedState();
  }

  public addTextToInput(text: string) {
    if (this._view) {
      // Reveal the webview panel
      this._view.show(true);

      this._view.webview.postMessage({
        type: 'command',
        command: 'addToContext',
        payload: { text }
      });
    }
  }

  public addContextSelection(selection: { filePath: string; filename: string; text: string }) {
    if (!this._view) {
      return;
    }

    this._view.show(true);
    this._view.webview.postMessage({
      type: 'command',
      command: 'addContextSelection',
      payload: selection,
    });
  }

  public addFileAttachments(files: Array<{ filePath: string; fileName: string; fileSize: number | null }>) {
    if (!this._view) {
      return;
    }

    const cleanedFiles = files.filter((entry) => entry.filePath.trim().length > 0 && entry.fileName.trim().length > 0);
    if (cleanedFiles.length === 0) {
      return;
    }

    this._view.show(true);
    this._view.webview.postMessage({
      type: 'command',
      command: 'addFileAttachments',
      payload: { files: cleanedFiles },
    });
  }

  public addFileMentions(paths: string[]) {
    if (!this._view) {
      return;
    }

    const cleanedPaths = paths
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (cleanedPaths.length === 0) {
      return;
    }

    this._view.show(true);
    this._view.webview.postMessage({
      type: 'command',
      command: 'addFileMentions',
      payload: { paths: cleanedPaths },
    });
  }

  public createNewSessionWithPrompt(prompt: string) {
    if (this._view) {
      // Reveal the webview panel
      this._view.show(true);

      this._view.webview.postMessage({
        type: 'command',
        command: 'createSessionWithPrompt',
        payload: { prompt }
      });
    }
  }

  public createNewSession(options?: { directory?: string; workspaceFolders?: WorkspaceFolderCandidate[] }) {
    if (this._view) {
      // Reveal the webview panel
      this._view.show(true);

      this._view.webview.postMessage({
        type: 'command',
        command: 'newSession',
        ...((options?.directory || options?.workspaceFolders?.length) && {
          payload: { directory: options?.directory, workspaceFolders: options?.workspaceFolders ?? [] },
        }),
      });
    }
  }

  public syncWorkspaceFolders(workspaceFolders: WorkspaceFolderCandidate[]) {
    this._view?.webview.postMessage({
      type: 'command',
      command: 'workspaceFoldersChanged',
      payload: { workspaceFolders },
    });
  }

  public showSettings() {
    if (this._view) {
      // Reveal the webview panel
      this._view.show(true);

      this._view.webview.postMessage({
        type: 'command',
        command: 'showSettings'
      });
    }
  }

  public postMessage(message: unknown): void {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  public notifySettingsSynced(settings: unknown): void {
    if (!this._view) {
      return;
    }

    this._view.webview.postMessage({
      type: 'command',
      command: 'settingsSynced',
      payload: settings,
    });
  }

  public notifyPermissionAutoAcceptSynced(snapshot: unknown): void {
    this._view?.webview.postMessage({
      type: 'command',
      command: 'permissionAutoAcceptSynced',
      payload: snapshot,
    });
  }

  /** Ask the webview to reconnect after the extension host restarts Pi. */
  public reloadPiRuntime(): boolean {
    if (!this._view) {
      return false;
    }

    this._view.webview.postMessage({
      type: 'command',
      command: 'reloadPiRuntime',
    });
    return true;
  }

  public notifyWindowFocusChanged(focused: boolean): void {
    if (!this._view) {
      return;
    }

    this._view.webview.postMessage({
      type: 'command',
      command: 'windowFocusChanged',
      payload: { focused },
    });
  }

  // Message delivery confirmation
  private _confirmMessage(messageId: string) {
    this._pendingMessages.delete(messageId);

    const timeout = this._messageTimeouts.get(messageId);
    if (timeout) {
      clearTimeout(timeout);
      this._messageTimeouts.delete(messageId);
    }
  }

  // Send message with retry mechanism
  private async _sendMessageWithRetry(response: BridgeResponse, retryCount: number = 0, messageId?: string): Promise<boolean> {
    if (!this._view) {
      return false;
    }

    const pendingMessageId = messageId ?? this._createMessageId();
    const existingTimeout = this._messageTimeouts.get(pendingMessageId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this._messageTimeouts.delete(pendingMessageId);
    }

    try {
      const delivered = await this._view.webview.postMessage({
        ...response,
        _msgId: pendingMessageId,
      });
      if (!delivered) {
        throw new Error('Webview rejected message delivery');
      }

      this._pendingMessages.add(pendingMessageId);

      const timeout = setTimeout(() => {
        if (!this._pendingMessages.has(pendingMessageId)) {
          return;
        }

        if (retryCount < this._MAX_RETRIES) {
          console.warn(`[Message Retry] Message ${pendingMessageId} not confirmed, retrying (${retryCount + 1}/${this._MAX_RETRIES})...`);
          void this._sendMessageWithRetry(response, retryCount + 1, pendingMessageId);
          return;
        }

        console.error(`[Message Retry] Message ${pendingMessageId} failed after ${this._MAX_RETRIES} retries`);
        this._pendingMessages.delete(pendingMessageId);
        this._messageTimeouts.delete(pendingMessageId);
      }, this._MESSAGE_TIMEOUT);

      this._messageTimeouts.set(pendingMessageId, timeout);
      return true;

    } catch (error) {
      console.error(`[Message Retry] Failed to send message:`, error);

      if (retryCount < this._MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (retryCount + 1)));
        return this._sendMessageWithRetry(response, retryCount + 1, pendingMessageId);
      }

      this._pendingMessages.delete(pendingMessageId);
      this._messageTimeouts.delete(pendingMessageId);

      return false;
    }
  }

  private _sendCachedState() {
    if (!this._view) {
      return;
    }

    this._view.webview.postMessage({
      type: 'connectionStatus',
      status: this._cachedStatus,
      error: this._cachedError,
    });
    this.notifyWindowFocusChanged(vscode.window.state.focused);
  }

  private _scheduleBroadcast(): void {
    if (this._broadcastSelectionDebounce !== undefined) {
      clearTimeout(this._broadcastSelectionDebounce);
    }
    this._broadcastSelectionDebounce = setTimeout(() => {
      this._broadcastSelectionDebounce = undefined;
      void this._broadcastActiveEditorFile();
    }, 150);
  }

  private _scheduleClearActiveEditorFile(): void {
    if (this._clearActiveEditorFileTimer !== undefined) {
      clearTimeout(this._clearActiveEditorFileTimer);
    }
    this._clearActiveEditorFileTimer = setTimeout(() => {
      this._clearActiveEditorFileTimer = undefined;
      if (!this._view || this._lastActiveEditorFilePayload === null) {
        return;
      }
      this._lastActiveEditorFilePayload = null;
      this._view.webview.postMessage({
        type: 'command',
        command: 'activeEditorFile',
        payload: null,
      });
    }, 200);
  }

  private async _broadcastActiveEditorFile() {
    if (!this._view) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      this._scheduleClearActiveEditorFile();
      return;
    }

    if (this._clearActiveEditorFileTimer !== undefined) {
      clearTimeout(this._clearActiveEditorFileTimer);
      this._clearActiveEditorFileTimer = undefined;
    }

    const editorUri = editor.document.uri;
    const filePath = normalizeWindowsDriveLetter(editorUri.fsPath);
    const rawFileName = editorUri.fsPath;
    const fileName = rawFileName.replace(/\\/g, '/').split('/').pop() || '';
    const relativePath = vscode.workspace.asRelativePath(editorUri, false);

    let fileSize: number | null = null;
    try {
      const stat = await vscode.workspace.fs.stat(editorUri);
      fileSize = stat.size;
    } catch {
      // File may not be saved yet or inaccessible
    }

    if (vscode.window.activeTextEditor?.document.uri.toString() !== editorUri.toString()) return;

    let selection: { startLine: number; endLine: number; text: string } | null = null;
    if (!editor.selection.isEmpty) {
      selection = {
        startLine: editor.selection.start.line + 1,
        endLine: editor.selection.end.line + 1,
        text: editor.document.getText(editor.selection),
      };
    }

    const payload: ActiveEditorFilePayload = { filePath, fileName, relativePath, fileSize, selection };
    if (isSameActiveEditorFilePayload(this._lastActiveEditorFilePayload, payload)) {
      return;
    }
    this._lastActiveEditorFilePayload = payload;

    this._view.webview.postMessage({
      type: 'command',
      command: 'activeEditorFile',
      payload,
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const workspaceFolder = normalizeWindowsDriveLetter(
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''
    );
    const workspaceFolders = resolveWorkspaceFolders(vscode.workspace.workspaceFolders ?? []);
    // Use cached values which are updated by onStatusChange callback
    const initialStatus = this._cachedStatus;

    return getWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      workspaceFolder,
      workspaceFolders,
      initialStatus,
      extensionVersion: String(this._context.extension?.packageJSON?.version || ''),
      devServerUrl: this._webviewDevServerUrl,
    });
  }
}
