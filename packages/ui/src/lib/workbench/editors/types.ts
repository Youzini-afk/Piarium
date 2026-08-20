export type EditorViewState = {
  cursorLine?: number;
  cursorColumn?: number;
  scrollTop?: number;
  scrollLeft?: number;
  foldedLines?: number[];
  previewMode?: 'preview' | 'edit' | 'tree' | 'text';
};

export type EditorTab = {
  tabId: string;
  viewId: string;
  resourceId: string;
  preview: boolean;
  pinned: boolean;
  providerId: string;
  viewState: EditorViewState;
};

export type EditorGroupLeaf = {
  type: 'group';
  groupId: string;
  tabs: EditorTab[];
  activeTabId: string | null;
};

export type EditorGroupSplit = {
  type: 'split';
  splitId: string;
  direction: 'horizontal' | 'vertical';
  ratio: number;
  first: EditorGroupNode;
  second: EditorGroupNode;
};

export type EditorGroupNode = EditorGroupLeaf | EditorGroupSplit;

export type EditorWorkbenchState = {
  workspaceId: string;
  tree: EditorGroupNode;
  activeGroupId: string;
};

export type SnapshotRestoreResult =
  | { status: 'missing' }
  | { status: 'empty' }
  | { status: 'malformed' }
  | { status: 'failure'; errorMessage: string }
  | { status: 'ready'; state: EditorWorkbenchState };

export type EditorProviderContribution = {
  id: string;
  extensionId: string;
  enabled: boolean;
  languages?: string[];
  filenames?: string[];
  priority: number;
  fallback?: boolean;
};

export const BUILTIN_EDITOR_PROVIDER_IDS = {
  text: 'piarium.builtin.text',
  markdown: 'piarium.builtin.markdown',
  json: 'piarium.builtin.json',
  html: 'piarium.builtin.html',
  drawio: 'piarium.builtin.drawio',
  image: 'piarium.builtin.image',
  pdf: 'piarium.builtin.pdf',
  diff: 'piarium.builtin.diff',
} as const;

export type BuiltinEditorProviderId = typeof BUILTIN_EDITOR_PROVIDER_IDS[keyof typeof BUILTIN_EDITOR_PROVIDER_IDS];

export type WorkbenchPanelId = 'terminal' | 'problems' | 'output';

export type WorkbenchPanelLayout = {
  workspaceId: string;
  visible: boolean;
  activePanelId: WorkbenchPanelId;
  size: number;
};

export type WorkbenchProblemsSnapshot =
  | { status: 'empty' }
  | { status: 'ready'; items: Array<{ resourceId: string; message: string; severity: 'error' | 'warning' | 'info' }> }
  | { status: 'failure'; errorMessage: string };

export type WorkbenchOutputSnapshot =
  | { status: 'empty' }
  | { status: 'ready'; channels: Array<{ id: string; title: string }> }
  | { status: 'failure'; errorMessage: string };

export type WorkbenchMenuItem = {
  id: string;
  commandId: string;
  group: string;
  order: number;
  when?: Record<string, string | boolean | number>;
};

export type EditorProviderSelection =
  | { status: 'none' }
  | { status: 'selected'; providerId: string }
  | { status: 'ambiguous'; providerIds: string[] };

export const EDITOR_WORKBENCH_SNAPSHOT_VERSION = 1 as const;
