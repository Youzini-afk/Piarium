import { createVSCodeAPIs } from './api';
import { onCommand, onThemeChange, sendBridgeMessage } from './api/bridge';
import { VSCodeRuntimeTransport } from './piRuntimeTransport';
import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';
import {
  buildVSCodeThemeFromPalette,
  readVSCodeThemePalette,
  type VSCodeThemeKind,
  type VSCodeThemePayload,
} from '@openchamber/ui/lib/theme/vscode/adapter';
import { configurePiRuntimeSurface } from '@openchamber/ui/lib/pi-runtime/client';
import type { VSCodeActiveEditorFile } from '@/sync/input-store';

type ConnectionStatus = 'connecting' | 'connected' | 'error' | 'disconnected';
type PanelType = 'chat' | 'agentManager' | 'settings';

declare const __OPENCHAMBER_WEBVIEW_BUILD_TIME__: string;

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
    __OPENCHAMBER_VSCODE_THEME__?: VSCodeThemePayload['theme'];
    __OPENCHAMBER_VSCODE_SHIKI_THEMES__?: {
      dark?: Record<string, unknown>;
      light?: Record<string, unknown>;
    } | null;
    __OPENCHAMBER_CONNECTION__?: { error?: string; status: ConnectionStatus };
    __OPENCHAMBER_HOME__?: string;
    __OPENCHAMBER_PANEL_TYPE__?: PanelType;
    __VSCODE_CONFIG__?: {
      arch?: string;
      connectionStatus?: string;
      extensionVersion?: string;
      initialSessionId?: string | null;
      initialSettingsPage?: string | null;
      panelType?: PanelType;
      platform?: string;
      theme?: string;
      viewMode?: 'sidebar' | 'editor';
      workspaceFolder: string;
      workspaceFolders?: Array<{ name: string; path: string }>;
    };
  }
}

console.log('[Piarium] VS Code webview starting...');
console.log('[Piarium] VS Code webview build:', __OPENCHAMBER_WEBVIEW_BUILD_TIME__);

window.__OPENCHAMBER_RUNTIME_APIS__ = createVSCodeAPIs();
window.__OPENCHAMBER_PANEL_TYPE__ = window.__VSCODE_CONFIG__?.panelType || 'chat';
window.__OPENCHAMBER_CONNECTION__ = {
  status: (window.__VSCODE_CONFIG__?.connectionStatus as ConnectionStatus | undefined) || 'connecting',
};

configurePiRuntimeSurface({
  clientName: 'piarium-vscode-webview',
  clientVersion: window.__VSCODE_CONFIG__?.extensionVersion || '0.1.0',
  createTransport: () => new VSCodeRuntimeTransport(),
  mode: 'vscode',
  runtimeKey: 'vscode:local',
});

const fadeOutLoadingScreen = () => {
  const element = document.getElementById('initial-loading');
  if (!element) return;
  element.classList.add('fade-out');
  window.setTimeout(() => element.remove(), 300);
};

const waitForUiMount = (timeoutMs = 8_000): Promise<boolean> => {
  const root = document.getElementById('root');
  if (!root) return Promise.resolve(false);
  if (root.childNodes.length > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (root.childNodes.length === 0) return;
      observer.disconnect();
      window.clearTimeout(timeout);
      resolve(true);
    });
    observer.observe(root, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, timeoutMs);
  });
};

window.addEventListener('message', (event) => {
  const message = event.data as { error?: unknown; status?: unknown; type?: unknown } | undefined;
  if (message?.type !== 'connectionStatus') return;
  const status = message.status;
  if (status !== 'connecting' && status !== 'connected' && status !== 'error' && status !== 'disconnected') return;
  const error = typeof message.error === 'string' ? message.error : undefined;
  window.__OPENCHAMBER_CONNECTION__ = { status, ...(error ? { error } : {}) };
  window.dispatchEvent(new CustomEvent('piarium:runtime-status', { detail: { error, status } }));
});

const applyInitialTheme = (theme: VSCodeThemePayload['theme']) => {
  const root = document.documentElement;
  const variant = theme.metadata?.variant === 'dark' ? 'dark' : 'light';
  root.classList.remove('light', 'dark');
  root.classList.add(variant);
  const background = theme.colors?.surface?.background;
  if (!background) return;
  document.body.style.backgroundColor = background;
  let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = background;
};

const emitVSCodeTheme = (preferredKind?: VSCodeThemeKind) => {
  const palette = readVSCodeThemePalette(preferredKind);
  if (!palette) return;
  const theme = buildVSCodeThemeFromPalette(palette);
  window.__OPENCHAMBER_VSCODE_THEME__ = theme;
  applyInitialTheme(theme);
  window.dispatchEvent(new CustomEvent<VSCodeThemePayload>('openchamber:vscode-theme', {
    detail: { palette, theme },
  }));
};

emitVSCodeTheme(window.__VSCODE_CONFIG__?.theme as VSCodeThemeKind | undefined);
onThemeChange((payload) => {
  const kind = (typeof payload === 'string' ? payload : payload?.kind) as VSCodeThemeKind | undefined;
  if (typeof payload === 'object' && payload?.shikiThemes !== undefined) {
    window.__OPENCHAMBER_VSCODE_SHIKI_THEMES__ = payload.shikiThemes;
    window.dispatchEvent(new CustomEvent('openchamber:vscode-shiki-themes', {
      detail: { shikiThemes: payload.shikiThemes },
    }));
  }
  requestAnimationFrame(() => {
    emitVSCodeTheme(kind);
    requestAnimationFrame(() => emitVSCodeTheme(kind));
  });
});

const normalizeWorkspacePath = (value: string): string => {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^([a-z]):\//, (_, letter: string) => `${letter.toUpperCase()}:/`)
    .replace(/^\/([a-z]):\//, (_, letter: string) => `/${letter.toUpperCase()}:/`);
  if (normalized === '/') return '/';
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const normalizeWorkspaceFolders = (value: unknown): Array<{ name: string; path: string }> => {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const candidate = entry as { name?: unknown; path?: unknown };
    const path = typeof candidate.path === 'string' ? normalizeWorkspacePath(candidate.path) : '';
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    return path ? { name, path } : null;
  }).filter((entry): entry is { name: string; path: string } => entry !== null);
};

const configuredWorkspaceFolders = (): Array<{ name: string; path: string }> => {
  const folders = normalizeWorkspaceFolders(window.__VSCODE_CONFIG__?.workspaceFolders);
  if (folders.length > 0) return folders;
  const workspaceFolder = window.__VSCODE_CONFIG__?.workspaceFolder;
  return typeof workspaceFolder === 'string' && workspaceFolder.trim()
    ? [{ name: '', path: normalizeWorkspacePath(workspaceFolder) }]
    : [];
};

const persistWorkspace = (path: string) => {
  if (!path) return;
  window.__OPENCHAMBER_HOME__ = path;
  try {
    window.localStorage.setItem('lastDirectory', path);
    window.localStorage.setItem('homeDirectory', path);
    if (window.localStorage.getItem('directoryTreeShowHidden') === null) {
      window.localStorage.setItem('directoryTreeShowHidden', 'true');
    }
    if (window.localStorage.getItem('filesViewShowGitignored') === null) {
      window.localStorage.setItem('filesViewShowGitignored', 'false');
    }
  } catch (error) {
    console.warn('[Piarium] Failed to persist VS Code workspace', error);
  }
};

const syncVSCodeWorkspaceProjects = async (
  folders: Array<{ name: string; path: string }>,
  activePath?: string,
) => {
  if (window.__VSCODE_CONFIG__) window.__VSCODE_CONFIG__.workspaceFolders = folders;
  const [{ useProjectsStore }, { useDirectoryStore }] = await Promise.all([
    import('@/stores/useProjectsStore'),
    import('@/stores/useDirectoryStore'),
  ]);
  const project = useProjectsStore.getState().syncVSCodeWorkspaceFolders(folders, activePath);
  const path = project?.path || activePath || folders[0]?.path || '';
  if (path) {
    useDirectoryStore.getState().setDirectory(path, { showOverlay: false });
    persistWorkspace(path);
  }
  return project;
};

const navigate = (view: 'sessions' | 'chat' | 'settings') => {
  window.dispatchEvent(new CustomEvent('piarium:vscode:navigate', { detail: { view } }));
};

const ensurePiSession = async (options?: { directory?: string; forceNew?: boolean }): Promise<string> => {
  const [{ usePiSessionStore }, { useProjectsStore }, { useDirectoryStore }] = await Promise.all([
    import('@/stores/usePiSessionStore'),
    import('@/stores/useProjectsStore'),
    import('@/stores/useDirectoryStore'),
  ]);
  const sessions = usePiSessionStore.getState();
  if (!options?.forceNew && sessions.currentSessionId) return sessions.currentSessionId;
  const projects = useProjectsStore.getState();
  const activeProject = projects.projects.find((project) => project.id === projects.activeProjectId);
  const cwd = options?.directory?.trim()
    || activeProject?.path
    || useDirectoryStore.getState().currentDirectory
    || configuredWorkspaceFolders()[0]?.path
    || '';
  if (!cwd) throw new Error('Open a workspace folder before creating a Pi session.');
  useDirectoryStore.getState().setDirectory(cwd, { showOverlay: false });
  const snapshot = await sessions.createSession(cwd);
  return snapshot.sessionId;
};

const appendPiDraft = async (text: string): Promise<string> => {
  const normalized = text.trim();
  const sessionId = await ensurePiSession();
  if (normalized) {
    const { usePiDraftStore } = await import('@/stores/usePiDraftStore');
    usePiDraftStore.getState().appendText(sessionId, normalized);
  }
  navigate('chat');
  return sessionId;
};

const fenceSelection = (filePath: string, text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `Context from ${filePath}:\n${fence}\n${text}\n${fence}`;
};

onCommand('addContextSelection', (payload) => {
  const record = payload as { filePath?: unknown; text?: unknown } | undefined;
  if (typeof record?.filePath !== 'string' || typeof record.text !== 'string') return;
  void appendPiDraft(fenceSelection(record.filePath, record.text)).catch((error) => {
    console.error('[Piarium] Failed to add editor selection:', error);
  });
});

onCommand('addFileMentions', (payload) => {
  const paths = Array.isArray((payload as { paths?: unknown[] } | undefined)?.paths)
    ? (payload as { paths: unknown[] }).paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  if (paths.length === 0) return;
  void appendPiDraft(`Use these files as context:\n${paths.map((path) => `- ${path.trim()}`).join('\n')}`);
});

onCommand('addFileAttachments', (payload) => {
  const files = Array.isArray((payload as { files?: unknown[] } | undefined)?.files)
    ? (payload as { files: unknown[] }).files
        .map((value) => value as { fileName?: unknown; filePath?: unknown })
        .map((file) => typeof file.filePath === 'string' && file.filePath.trim()
          ? file.filePath.trim()
          : typeof file.fileName === 'string' ? file.fileName.trim() : '')
        .filter(Boolean)
    : [];
  if (files.length === 0) return;
  void appendPiDraft(`Use these files as context:\n${files.map((path) => `- ${path}`).join('\n')}`);
});

onCommand('createSessionWithPrompt', (payload) => {
  const prompt = typeof (payload as { prompt?: unknown } | undefined)?.prompt === 'string'
    ? (payload as { prompt: string }).prompt.trim()
    : '';
  if (!prompt) return;
  void (async () => {
    const sessionId = await ensurePiSession({ forceNew: true });
    const { usePiSessionStore } = await import('@/stores/usePiSessionStore');
    navigate('chat');
    await usePiSessionStore.getState().prompt(sessionId, prompt);
  })().catch((error) => console.error('[Piarium] Failed to run editor prompt:', error));
});

onCommand('workspaceFoldersChanged', (payload) => {
  const folders = normalizeWorkspaceFolders((payload as { workspaceFolders?: unknown } | undefined)?.workspaceFolders);
  void syncVSCodeWorkspaceProjects(folders);
});

onCommand('newSession', (payload) => {
  const record = payload as { directory?: unknown; workspaceFolders?: unknown } | undefined;
  const folders = normalizeWorkspaceFolders(record?.workspaceFolders);
  const directory = typeof record?.directory === 'string' ? normalizeWorkspacePath(record.directory) : undefined;
  void (async () => {
    if (folders.length > 0) await syncVSCodeWorkspaceProjects(folders, directory);
    await ensurePiSession({ directory, forceNew: true });
    navigate('chat');
  })().catch((error) => console.error('[Piarium] Failed to create session:', error));
});

onCommand('showSettings', () => navigate('settings'));
onCommand('showSettingsPage', (payload) => {
  const page = typeof payload === 'string'
    ? payload.trim()
    : typeof (payload as { page?: unknown } | undefined)?.page === 'string'
      ? String((payload as { page: string }).page).trim()
      : '';
  if (!page) return;
  void import('@/stores/useUIStore').then(({ useUIStore }) => useUIStore.getState().setSettingsPage(page));
});

onCommand('reloadPiRuntime', () => {
  void (async () => {
    const [{ disconnectPiRuntime }, { usePiSessionStore }] = await Promise.all([
      import('@openchamber/ui/lib/pi-runtime/client'),
      import('@/stores/usePiSessionStore'),
    ]);
    await disconnectPiRuntime();
    usePiSessionStore.getState().reset();
    await usePiSessionStore.getState().loadCatalog();
  })().catch((error) => console.error('[Piarium] Failed to reconnect runtime:', error));
});

onCommand('settingsSynced', () => {
  void import('@/lib/persistence').then(({ syncDesktopSettings }) => syncDesktopSettings());
});

onCommand('activeEditorFile', (payload) => {
  void import('@/sync/input-store').then(({ useInputStore }) => {
    useInputStore.getState().setActiveEditorFile((payload as VSCodeActiveEditorFile | null) ?? null);
  });
});

onCommand('showNotification', (payload) => {
  if (typeof Notification === 'undefined') return;
  const record = payload as { body?: unknown; title?: unknown } | undefined;
  const title = typeof record?.title === 'string' && record.title.trim() ? record.title.trim() : 'Piarium';
  const body = typeof record?.body === 'string' ? record.body : '';
  if (Notification.permission === 'granted') new Notification(title, { body });
});

const bootstrap = async () => {
  const folders = configuredWorkspaceFolders();
  if (folders.length > 0) await syncVSCodeWorkspaceProjects(folders);
  const { renderVSCodeApp } = await import('@openchamber/ui/apps/renderVSCodeApp');
  renderVSCodeApp(window.__OPENCHAMBER_RUNTIME_APIS__ ?? createVSCodeAPIs());
  await waitForUiMount();
  fadeOutLoadingScreen();
};

void bootstrap().catch((error) => {
  console.error('[Piarium] Failed to bootstrap VS Code UI:', error);
  fadeOutLoadingScreen();
  void sendBridgeMessage('vscode:log', { level: 'error', message: String(error) }).catch(() => undefined);
});
