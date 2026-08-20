import * as vscode from 'vscode';
import { ChatViewProvider } from './ChatViewProvider';
import { parseCompanionUri } from './companion-uri';
import {
  resolvePiNodeExecutable,
  resolveVSCodePiHostEntry,
  VSCodePiRuntime,
} from './piRuntime';
import { resolveWorkspaceFolders } from './workspaceResolver';

let chatViewProvider: ChatViewProvider | undefined;
let piRuntime: VSCodePiRuntime | undefined;
let outputChannel: vscode.OutputChannel | undefined;
let activeSessionId: string | null = null;

const t = vscode.l10n.t;
const CHAT_VIEW_BOOTSTRAP_DELAY_MS = 80;
const waitForChatViewBootstrap = () => new Promise<void>((resolve) => setTimeout(resolve, CHAT_VIEW_BOOTSTRAP_DELAY_MS));

const readSettingsPage = (settingsPage: unknown): string | undefined => {
  if (typeof settingsPage === 'string') {
    const page = settingsPage.trim();
    return page || undefined;
  }
  if (settingsPage && typeof settingsPage === 'object' && typeof (settingsPage as { page?: unknown }).page === 'string') {
    const page = String((settingsPage as { page: string }).page).trim();
    return page || undefined;
  }
  return undefined;
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('Piarium');
  piRuntime = new VSCodePiRuntime(context, outputChannel);
  context.subscriptions.push(piRuntime);

  chatViewProvider = new ChatViewProvider(context, context.extensionUri, piRuntime);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(
    ChatViewProvider.viewType,
    chatViewProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  ));

  const isCursorLikeHost = () => /\bcursor\b/i.test(vscode.env.appName);
  const findMoveToRightSidebarCommandId = async (): Promise<string | null> => {
    const commands = await vscode.commands.getCommands(true);
    const preferred = [
      'workbench.action.moveViewToSecondarySideBar',
      'workbench.action.moveViewToSecondarySidebar',
      'workbench.action.moveFocusedViewToSecondarySideBar',
      'workbench.action.moveFocusedViewToSecondarySidebar',
      'workbench.action.moveViewToAuxiliaryBar',
      'workbench.action.moveFocusedViewToAuxiliaryBar',
    ];
    for (const command of preferred) if (commands.includes(command)) return command;
    return commands.find((command) => {
      const id = command.toLowerCase();
      return id.includes('workbench.action')
        && id.includes('move')
        && id.includes('view')
        && ((id.includes('secondary') && id.includes('side') && id.includes('bar'))
          || (id.includes('auxiliary') && id.includes('bar')));
    }) ?? null;
  };

  const attemptMoveChatToRightSidebar = async (): Promise<void> => {
    const command = await findMoveToRightSidebarCommandId();
    if (!command) return;
    try {
      await vscode.commands.executeCommand('piarium.chatView.focus');
      await vscode.commands.executeCommand(command);
    } catch (error) {
      outputChannel?.appendLine(`[Piarium] Failed to move chat to the right sidebar: ${String(error)}`);
    }
  };

  if (!isCursorLikeHost() && !context.globalState.get<boolean>('piarium.sidebarAutoMoveAttempted')) {
    await context.globalState.update('piarium.sidebarAutoMoveAttempted', true);
    setTimeout(() => void attemptMoveChatToRightSidebar(), 800);
  }

  context.subscriptions.push(vscode.commands.registerCommand('piarium.openSidebar', async () => {
    try {
      await vscode.commands.executeCommand('workbench.view.extension.piarium');
    } catch (error) {
      outputChannel?.appendLine(`[Piarium] Failed to open the view container: ${String(error)}`);
    }
    try {
      await vscode.commands.executeCommand('piarium.chatView.focus');
    } catch (error) {
      vscode.window.showErrorMessage(t('Piarium: Failed to open sidebar - {0}', String(error)));
      return false;
    }
    if (!chatViewProvider?.hasResolvedView()) {
      vscode.window.showWarningMessage(t('Piarium: Chat sidebar is not ready'));
      return false;
    }
    return true;
  }));

  const revealChatViewForPayload = async (): Promise<boolean> => {
    if (!await vscode.commands.executeCommand<boolean>('piarium.openSidebar')) return false;
    await waitForChatViewBootstrap();
    if (chatViewProvider?.hasResolvedView()) return true;
    vscode.window.showWarningMessage(t('Piarium: Chat sidebar is not ready'));
    return false;
  };

  const openCompanionSession = async (sessionId: string): Promise<void> => {
    if (!await revealChatViewForPayload()) return;
    chatViewProvider?.openSession(sessionId);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('piarium.focusChat', () => vscode.commands.executeCommand('piarium.chatView.focus')),
    vscode.commands.registerCommand('piarium.openAgentManager', () => {
      vscode.window.showInformationMessage(
        t('Piarium: Agent groups and Fleet run in the Piarium Agent Profile on desktop or web'),
      );
    }),
    vscode.commands.registerCommand('piarium.internal.settingsSynced', (settings: unknown) => {
      chatViewProvider?.notifySettingsSynced(settings);
    }),
    vscode.commands.registerCommand('piarium.setActiveSession', (sessionId: unknown) => {
      activeSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
    }),
    vscode.commands.registerCommand('piarium.openActiveSessionInEditor', () => {
      if (!activeSessionId) {
        vscode.window.showInformationMessage(t('Piarium: No active session'));
        return;
      }
      return openCompanionSession(activeSessionId);
    }),
    vscode.commands.registerCommand('piarium.openSessionInEditor', (sessionId: unknown) => {
      if (typeof sessionId !== 'string' || !sessionId.trim()) return;
      return openCompanionSession(sessionId.trim());
    }),
    vscode.commands.registerCommand('piarium.openNewSessionInEditor', () => vscode.commands.executeCommand('piarium.newSession')),
    vscode.commands.registerCommand('piarium.openCurrentOrNewSessionInEditor', () => {
      if (activeSessionId) return openCompanionSession(activeSessionId);
      return vscode.commands.executeCommand('piarium.newSession');
    }),
    vscode.commands.registerCommand('piarium.restartRuntime', async () => {
      try {
        await piRuntime?.restart();
        chatViewProvider?.reloadPiRuntime();
        vscode.window.showInformationMessage(t('Piarium: Pi runtime restarted'));
      } catch (error) {
        vscode.window.showErrorMessage(t('Piarium: Failed to restart Pi runtime - {0}', String(error)));
      }
    }),
  );

  context.subscriptions.push(vscode.window.registerUriHandler({
    handleUri(uri) {
      const target = parseCompanionUri(uri);
      if (target.action === 'unknown') {
        vscode.window.showErrorMessage(t('Piarium: Unknown deep link {0}', target.path));
        return;
      }
      void (async () => {
        if (target.action === 'session') {
          await openCompanionSession(target.sessionId);
          return;
        }
        await revealChatViewForPayload();
      })();
    },
  }));

  context.subscriptions.push(vscode.commands.registerCommand('piarium.addToContext', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage(t('Piarium [Add to Context]: No active editor'));
      return;
    }
    const selectedText = editor.document.getText(editor.selection);
    if (!selectedText) {
      vscode.window.showWarningMessage(t('Piarium [Add to Context]: No text selected'));
      return;
    }
    const startLine = editor.selection.start.line + 1;
    const endLine = editor.selection.end.line + 1;
    const contextSelection = {
      filePath: editor.document.uri.fsPath,
      filename: `${vscode.workspace.asRelativePath(editor.document.uri, false)}:${startLine === endLine ? startLine : `${startLine}-${endLine}`}`,
      text: selectedText,
    };
    if (await revealChatViewForPayload()) chatViewProvider?.addContextSelection(contextSelection);
  }));

  context.subscriptions.push(vscode.commands.registerCommand(
    'piarium.attachExplorerToChat',
    async (resource?: vscode.Uri, resources?: vscode.Uri[]) => {
      const candidates = [
        ...(Array.isArray(resources) ? resources.filter((entry): entry is vscode.Uri => entry instanceof vscode.Uri) : []),
        ...(resource instanceof vscode.Uri ? [resource] : []),
      ];
      if (candidates.length === 0 && vscode.window.activeTextEditor?.document.uri) {
        candidates.push(vscode.window.activeTextEditor.document.uri);
      }
      const unique = Array.from(new Map(candidates.map((uri) => [uri.toString(), uri])).values());
      const files: Array<{ filePath: string; fileName: string; fileSize: number | null }> = [];
      let skipped = false;
      for (const uri of unique) {
        if (uri.scheme !== 'file') {
          skipped = true;
          continue;
        }
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if ((stat.type & vscode.FileType.Directory) !== 0) {
            skipped = true;
            continue;
          }
          const fileName = uri.fsPath.replace(/\\/g, '/').split('/').pop() || '';
          if (uri.fsPath.trim() && fileName) files.push({ filePath: uri.fsPath, fileName, fileSize: stat.size });
        } catch {
          skipped = true;
        }
      }
      if (files.length === 0) {
        vscode.window.showWarningMessage(t('Piarium: No file selected to mention'));
        return;
      }
      if (!await revealChatViewForPayload()) return;
      chatViewProvider?.addFileAttachments(files);
      if (skipped) vscode.window.showInformationMessage(t('Piarium: Some folders or unsupported resources were skipped'));
    },
  ));

  const promptFromEditor = (mode: 'explain' | 'improve'): string | null => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage(t(`Piarium [${mode === 'explain' ? 'Explain' : 'Improve Code'}]: No active editor`));
      return null;
    }
    const selectedText = editor.document.getText(editor.selection);
    if (mode === 'improve' && !selectedText) {
      vscode.window.showWarningMessage(t('Piarium [Improve Code]: No text selected'));
      return null;
    }
    const filePath = vscode.workspace.asRelativePath(editor.document.uri);
    if (!selectedText) return `${t('Explain the following Code / Text:')}\n\n${filePath}`;
    const startLine = editor.selection.start.line + 1;
    const endLine = editor.selection.end.line + 1;
    const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
    const instruction = mode === 'explain' ? t('Explain the following Code / Text:') : t('Improve the following Code:');
    return `${instruction}\n\n${filePath}:${lineRange}\n\`\`\`${editor.document.languageId}\n${selectedText}\n\`\`\``;
  };

  const createSessionWithEditorPrompt = async (mode: 'explain' | 'improve'): Promise<void> => {
    const prompt = promptFromEditor(mode);
    if (!prompt) return;
    if (await revealChatViewForPayload()) chatViewProvider?.createNewSessionWithPrompt(prompt);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('piarium.explain', () => createSessionWithEditorPrompt('explain')),
    vscode.commands.registerCommand('piarium.improveCode', () => createSessionWithEditorPrompt('improve')),
  );

  context.subscriptions.push(vscode.commands.registerCommand('piarium.newSession', async (directory?: unknown) => {
    const candidates = resolveWorkspaceFolders(vscode.workspace.workspaceFolders ?? []);
    let folderPath = typeof directory === 'string' && directory.trim() ? directory.trim() : undefined;
    if (!folderPath && candidates.length === 0) {
      vscode.window.showInformationMessage(t('Piarium: Open a folder to start a session'));
      return;
    }
    if (!folderPath) {
      folderPath = candidates.length === 1
        ? candidates[0]?.path
        : (await vscode.window.showQuickPick(
            candidates.map((folder) => ({ label: folder.name, description: folder.path, path: folder.path })),
            { placeHolder: t('Select a workspace folder for this session'), matchOnDescription: true },
          ))?.path;
    }
    if (!folderPath) return;
    const workspaceFolders = candidates.some((folder) => folder.path === folderPath)
      ? candidates
      : [...candidates, { name: folderPath.split(/[\\/]/).filter(Boolean).pop() ?? folderPath, path: folderPath }];
    if (!await revealChatViewForPayload()) return;
    chatViewProvider?.createNewSession({ directory: folderPath, workspaceFolders });
  }));

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      chatViewProvider?.syncWorkspaceFolders(resolveWorkspaceFolders(vscode.workspace.workspaceFolders ?? []));
    }),
    vscode.commands.registerCommand('piarium.showSettings', async (settingsPage?: unknown) => {
      if (!await revealChatViewForPayload()) return;
      const page = readSettingsPage(settingsPage);
      if (page) chatViewProvider?.showSettings(page);
      else chatViewProvider?.showSettings();
    }),
    vscode.commands.registerCommand('piarium.showRuntimeStatus', () => {
      const status = piRuntime?.getStatus();
      let nodePath = '(unavailable)';
      let hostPath = '(unavailable)';
      try { nodePath = resolvePiNodeExecutable(); } catch (error) { nodePath = String(error); }
      try { hostPath = resolveVSCodePiHostEntry(context.extensionPath); } catch (error) { hostPath = String(error); }
      outputChannel?.appendLine([
        `Time: ${new Date().toISOString()}`,
        `Piarium version: ${String(context.extension?.packageJSON?.version || '(unknown)')}`,
        `VS Code version: ${vscode.version}`,
        `Platform: ${process.platform} ${process.arch}`,
        `Pi runtime status: ${status?.status ?? 'unknown'}`,
        `Pi runtime error: ${status?.error ?? '(none)'}`,
        `Node.js: ${nodePath}`,
        `Pi host: ${hostPath}`,
        `Workspace folders: ${(vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath).join(', ') || '(none)'}`,
        '',
      ].join('\n'));
      outputChannel?.show(true);
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      chatViewProvider?.notifyWindowFocusChanged(state.focused);
    }),
    vscode.window.onDidChangeActiveColorTheme((theme) => {
      chatViewProvider?.updateTheme(theme.kind);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('workbench.colorTheme')
        && !event.affectsConfiguration('workbench.preferredLightColorTheme')
        && !event.affectsConfiguration('workbench.preferredDarkColorTheme')) return;
      chatViewProvider?.updateTheme(vscode.window.activeColorTheme.kind);
    }),
    piRuntime.onStatusChange(({ status, error }) => {
      chatViewProvider?.updateConnectionStatus(status, error);
    }),
  );

  void piRuntime.start().catch(() => {
    // VSCodePiRuntime publishes the actionable diagnostic and status.
  });
}

export async function deactivate(): Promise<void> {
  await piRuntime?.stop();
  piRuntime = undefined;
  chatViewProvider = undefined;
  outputChannel?.dispose();
  outputChannel = undefined;
}
