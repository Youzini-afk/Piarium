import type { RuntimeAPIs } from '@/lib/api/types';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';

type OpenFileInMainEditorOptions = {
  line?: number;
  column?: number;
  focus?: boolean;
};

const normalizePath = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+/g, '/');

  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  const isUnixRoot = normalized === '/';
  const isWindowsDriveRoot = /^[A-Za-z]:\/$/.test(normalized);
  if (!isUnixRoot && !isWindowsDriveRoot) {
    normalized = normalized.replace(/\/+$/g, '');
  }

  return normalized;
};

const toComparablePath = (value: string): string => (
  /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value
);

const isPathWithinRoot = (path: string, root: string): boolean => {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (!normalizedRoot || !normalizedPath) return false;

  const comparableRoot = toComparablePath(normalizedRoot);
  const comparablePath = toComparablePath(normalizedPath);
  return comparablePath === comparableRoot || comparablePath.startsWith(`${comparableRoot}/`);
};

const getVSCodeRuntimeEditor = (): RuntimeAPIs['editor'] | undefined => {
  if (typeof window === 'undefined') {
    return undefined;
  }

  const apis = (window as typeof window & { __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs })
    .__OPENCHAMBER_RUNTIME_APIS__;
  if (!apis?.runtime?.isVSCode || !apis.editor?.openFile) {
    return undefined;
  }

  return apis.editor;
};

export const openFileInMainEditor = (
  directory: string | null | undefined,
  filePath: string | null | undefined,
  options: OpenFileInMainEditorOptions = {},
): boolean => {
  const root = normalizePath((directory || '').trim());
  const targetPath = normalizePath((filePath || '').trim());

  const vscodeEditor = getVSCodeRuntimeEditor();
  if (vscodeEditor && targetPath) {
    const line = Number.isFinite(options.line ?? Number.NaN)
      ? Math.max(1, Math.trunc(options.line as number))
      : undefined;
    const column = Number.isFinite(options.column ?? Number.NaN)
      ? Math.max(1, Math.trunc(options.column as number))
      : undefined;

    void vscodeEditor.openFile(targetPath, line, column).catch(() => {});
    return true;
  }

  if (!root || !targetPath || !isPathWithinRoot(targetPath, root)) {
    return false;
  }

  const filesViewTabsStore = useFilesViewTabsStore.getState();
  filesViewTabsStore.setSelectedPath(root, targetPath);
  filesViewTabsStore.addOpenPath(root, targetPath);

  const uiStore = useUIStore.getState();
  if (Number.isFinite(options.line ?? Number.NaN)) {
    uiStore.setPendingFileFocusPath(null);
    uiStore.setPendingFileNavigation({
      path: targetPath,
      line: Math.max(1, Math.trunc(options.line as number)),
      column: Number.isFinite(options.column ?? Number.NaN)
        ? Math.max(1, Math.trunc(options.column as number))
        : 1,
    });
  } else if (options.focus !== false) {
    uiStore.setPendingFileNavigation(null);
    uiStore.setPendingFileFocusPath(targetPath);
  }

  uiStore.setActiveMainTab('files');
  return true;
};
