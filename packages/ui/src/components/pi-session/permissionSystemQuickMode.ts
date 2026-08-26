import type {
  PiConfigTextDocumentSnapshot,
  RuntimeContextTarget,
} from '@piarium/protocol';
import {
  getPiConfigTextDocument,
  updatePiConfigTextDocument,
} from '@/lib/pi-runtime/config-documents';
import { notifyPiRuntimeCatalogChanged } from '@/lib/pi-runtime/catalog-events';
import { parseJsoncObject, updateJsoncPath } from '@/components/sections/plugin-settings/plugin-config-model';
import { permissionSystemDraftIssues } from '@/components/sections/plugin-settings/permission-system-config-model';

export type PermissionSystemQuickMode = 'ask' | 'auto';
export type PermissionSystemQuickModeScope = 'global' | 'project';

export interface PermissionSystemQuickModeState {
  mode: PermissionSystemQuickMode;
  scope: PermissionSystemQuickModeScope;
  source: PiConfigTextDocumentSnapshot;
}

interface PermissionSystemConfigSource {
  draft: Record<string, unknown>;
  snapshot: PiConfigTextDocumentSnapshot;
}

const GLOBAL_PATH = 'extensions/pi-permission-system/config.json';
const PROJECT_PATH = '.pi/extensions/pi-permission-system/config.json';

const readConfigSource = (snapshot: PiConfigTextDocumentSnapshot): PermissionSystemConfigSource => {
  const draft = parseJsoncObject(snapshot.content);
  if (permissionSystemDraftIssues(draft, snapshot.content).length > 0) {
    throw new Error('Permission configuration must be fixed before changing quick mode');
  }
  return { draft, snapshot };
};

export const resolvePermissionSystemQuickMode = (
  globalSnapshot: PiConfigTextDocumentSnapshot,
  projectSnapshot: PiConfigTextDocumentSnapshot | null,
  preferProject: boolean,
): PermissionSystemQuickModeState => {
  const global = readConfigSource(globalSnapshot);
  const projectActive = preferProject && projectSnapshot?.projectTrusted === true;
  const project = projectActive && projectSnapshot ? readConfigSource(projectSnapshot) : null;
  const yoloMode = projectActive && typeof project?.draft.yoloMode === 'boolean'
    ? project.draft.yoloMode
    : typeof global.draft.yoloMode === 'boolean'
      ? global.draft.yoloMode
      : false;
  const writeSource = projectActive && project ? project : global;
  return {
    mode: yoloMode ? 'auto' : 'ask',
    scope: projectActive ? 'project' : 'global',
    source: writeSource.snapshot,
  };
};

export const permissionSystemQuickModeContent = (
  source: PiConfigTextDocumentSnapshot,
  mode: PermissionSystemQuickMode,
): string => {
  const next = updateJsoncPath(source.content, ['yoloMode'], mode === 'auto');
  readConfigSource({ ...source, content: next });
  return next;
};

export const loadPermissionSystemQuickMode = async (
  target: RuntimeContextTarget,
  preferProject: boolean,
): Promise<PermissionSystemQuickModeState> => {
  const [globalSnapshot, projectSnapshot] = await Promise.all([
    getPiConfigTextDocument(target, 'agent', GLOBAL_PATH, 'jsonc'),
    preferProject
      ? getPiConfigTextDocument(target, 'project', PROJECT_PATH, 'jsonc')
      : Promise.resolve(null),
  ]);
  return resolvePermissionSystemQuickMode(globalSnapshot, projectSnapshot, preferProject);
};

export const savePermissionSystemQuickMode = async (
  target: RuntimeContextTarget,
  current: PermissionSystemQuickModeState,
  mode: PermissionSystemQuickMode,
): Promise<PermissionSystemQuickModeState> => {
  if (current.mode === mode) return current;
  const root = current.scope === 'project' ? 'project' : 'agent';
  const path = current.scope === 'project' ? PROJECT_PATH : GLOBAL_PATH;
  const snapshot = await updatePiConfigTextDocument(
    target,
    root,
    path,
    'jsonc',
    permissionSystemQuickModeContent(current.source, mode),
    current.source.revision,
  );
  notifyPiRuntimeCatalogChanged('plugin-config');
  return { mode, scope: current.scope, source: snapshot };
};
