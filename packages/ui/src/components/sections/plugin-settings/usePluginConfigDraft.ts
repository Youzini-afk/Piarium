import React from 'react';
import type {
  JsonValue,
  PiConfigScope,
  PiConfigTextDocumentSnapshot,
  PiConfigTextFormat,
  PiConfigTextRoot,
  PiConfigWatchTarget,
  RuntimeContextTarget,
} from '@piarium/protocol';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { toast } from '@/components/ui';
import {
  getPiConfigDocument,
  getPiConfigTextDocument,
  subscribePiConfig,
  updatePiConfigDocument,
  updatePiConfigTextDocument,
} from '@/lib/pi-runtime/config-documents';
import {
  createPiJsonObjectChanges,
  formatPiJsonObjectDocument,
  parsePiJsonObjectDocument,
} from '@/lib/pi-runtime/json-object-document';
import { getPiSettings, updatePiSettings } from '@/lib/pi-runtime/settings';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  notifyPiRuntimeCatalogChanged,
  subscribePiRuntimeCatalogChanged,
} from '@/lib/pi-runtime/catalog-events';
import { useI18n } from '@/lib/i18n';
import {
  asJsonObject,
  jsonObjectsEqual,
  removeJsoncPath,
  removeJsonPath,
  setJsonPath,
  updateJsoncPath,
  type JsonObject,
} from './plugin-config-model';

export interface PluginObjectDraft {
  dirty: boolean;
  draft: JsonObject;
  error: string | null;
  externalChanged: boolean;
  loaded: boolean;
  loading: boolean;
  path: string;
  projectTrusted: boolean;
  rawContent: string;
  rawError: string | null;
  removeValue: (path: readonly string[]) => void;
  reload: () => Promise<void>;
  save: () => Promise<void>;
  saving: boolean;
  setRawContent: (content: string) => void;
  setValue: (path: readonly string[], value: JsonValue) => void;
}

interface CommonDraftOptions {
  runtimeTarget: RuntimeContextTarget;
  targetKey: string;
}

interface SettingsDraftOptions extends CommonDraftOptions {
  property: string;
  scope: PiConfigScope;
}

interface DocumentDraftOptions extends CommonDraftOptions {
  path: string;
  scope: PiConfigScope;
}

interface TextDraftOptions extends CommonDraftOptions {
  format: PiConfigTextFormat;
  paths: readonly string[];
  root: PiConfigTextRoot;
}

interface DraftState {
  draft: JsonObject;
  error: string | null;
  externalChanged: boolean;
  loaded: boolean;
  loading: boolean;
  path: string;
  projectTrusted: boolean;
  rawContent: string;
  rawError: string | null;
  revision: string | null;
  saving: boolean;
  source: JsonObject;
  targetKey: string | null;
}

export interface DraftReloadOptions {
  preserveNewerDraft?: boolean;
}

export const shouldApplyPluginDraftReload = (
  _options: DraftReloadOptions,
  startedRevision: number,
  currentRevision: number,
): boolean => startedRevision === currentRevision;

type PluginDraftExternalChangeAction = 'reload' | 'preserve-dirty' | 'preserve-watch-error';

export const reconcilePluginDraftExternalChange = (
  dirty: boolean,
  reason: 'change' | 'error' | 'rename',
): PluginDraftExternalChangeAction => (
  reason === 'error' ? 'preserve-watch-error' : dirty ? 'preserve-dirty' : 'reload'
);

export const isPluginDraftActionCurrent = (
  action: { generation: number; runtimeKey: string; targetKey: string },
  current: { generation: number; runtimeKey: string; targetKey: string },
): boolean => (
  action.generation === current.generation
  && action.runtimeKey === current.runtimeKey
  && action.targetKey === current.targetKey
);

export const preservePluginDraftOnFailure = <T extends { error: string | null; loading: boolean }>(
  current: T,
  message: string,
): T => ({ ...current, error: message, loading: false });

const initialState = (): DraftState => ({
  draft: {},
  error: null,
  externalChanged: false,
  loaded: false,
  loading: false,
  path: '',
  projectTrusted: false,
  rawContent: '{}\n',
  rawError: null,
  revision: null,
  saving: false,
  source: {},
  targetKey: null,
});

const useRefreshCleanDraft = (
  dirtyRef: React.MutableRefObject<boolean>,
  loaded: boolean,
  reload: (options?: DraftReloadOptions) => Promise<void>,
): void => {
  const loadedRef = React.useRef(loaded);
  loadedRef.current = loaded;
  React.useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'visible' && loadedRef.current && !dirtyRef.current) {
        void reload({ preserveNewerDraft: true });
      }
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const unsubscribe = subscribePiRuntimeCatalogChanged((reason) => {
      if (reason === 'plugin-config' || reason === 'reload') refresh();
    });
    return () => {
      unsubscribe();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [dirtyRef, reload]);
};

const useConfigDraftWatch = (
  dirtyRef: React.MutableRefObject<boolean>,
  enabled: boolean,
  reload: (options?: DraftReloadOptions) => Promise<void>,
  runtimeTarget: RuntimeContextTarget,
  watchTargets: readonly PiConfigWatchTarget[],
  watchRevision: number,
  onPreserve: (message: string) => void,
): void => {
  const { t } = useI18n();
  const watchTargetsKey = JSON.stringify(watchTargets);
  const watchTargetsRef = React.useRef(watchTargets);
  watchTargetsRef.current = watchTargets;
  React.useEffect(() => {
    if (!enabled || watchTargetsRef.current.length === 0) return;
    let active = true;
    let stops: Array<() => Promise<void>> = [];
    const onChange = (event: { reason: 'change' | 'error' | 'rename' }): void => {
      if (!active) return;
      const action = reconcilePluginDraftExternalChange(dirtyRef.current, event.reason);
      if (action === 'reload') {
        void reload({ preserveNewerDraft: true });
      } else {
        onPreserve(action === 'preserve-watch-error'
          ? t('settings.piarium.pluginSettings.source.watchFailed')
          : t('settings.piarium.pluginSettings.source.externalChanged'));
      }
    };
    void Promise.allSettled(watchTargetsRef.current.map((watchTarget) => (
      subscribePiConfig(runtimeTarget, watchTarget, onChange)
    ))).then((results) => {
      const unsubscribes = results.flatMap((result) => (
        result.status === 'fulfilled' ? [result.value] : []
      ));
      if (!active || results.some((result) => result.status === 'rejected')) {
        void Promise.allSettled(unsubscribes.map((unsubscribe) => unsubscribe()));
        if (active) onPreserve(t('settings.piarium.pluginSettings.source.watchFailed'));
        return;
      }
      stops = unsubscribes;
      // Subscribe before this read so a change in the load→watch gap cannot be lost.
      void reload({ preserveNewerDraft: true });
    });
    return () => {
      active = false;
      if (stops.length > 0) {
        void Promise.allSettled(stops.map((stop) => stop()));
      }
    };
  // watchTargetsKey is the stable semantic identity; the array is commonly rebuilt by callers.
  }, [dirtyRef, enabled, onPreserve, reload, runtimeTarget, t, watchRevision, watchTargetsKey]);
};

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const useDraftActions = (
  state: DraftState,
  setState: React.Dispatch<React.SetStateAction<DraftState>>,
  targetKey: string,
  mutationRevisionRef: React.MutableRefObject<number>,
  dirtyRef: React.MutableRefObject<boolean>,
) => {
  const active = state.targetKey === targetKey;
  const dirty = active && (
    state.rawError !== null || !jsonObjectsEqual(state.source, state.draft)
  );
  dirtyRef.current = dirty;
  const updateDraft = (
    current: DraftState,
    updater: (draft: JsonObject) => JsonObject,
  ): DraftState => {
    const draft = updater(current.draft);
    return {
      ...current,
      draft,
      rawContent: formatPiJsonObjectDocument(draft),
      rawError: null,
    };
  };
  return {
    dirty,
    draft: active ? state.draft : {},
    error: active ? state.error : null,
    externalChanged: active && state.externalChanged,
    loaded: active && state.loaded,
    loading: active ? state.loading : true,
    path: active ? state.path : '',
    projectTrusted: active && state.projectTrusted,
    rawContent: active ? state.rawContent : '{}\n',
    rawError: active ? state.rawError : null,
    removeValue: (path: readonly string[]) => {
      dirtyRef.current = true;
      mutationRevisionRef.current += 1;
      setState((current) => current.targetKey === targetKey
        ? updateDraft(current, (draft) => removeJsonPath(draft, path))
        : current);
    },
    saving: active && state.saving,
    setRawContent: (content: string) => {
      dirtyRef.current = true;
      mutationRevisionRef.current += 1;
      setState((current) => {
        if (current.targetKey !== targetKey) return current;
        try {
          return {
            ...current,
            draft: parsePiJsonObjectDocument(content),
            rawContent: content,
            rawError: null,
          };
        } catch (error) {
          return {
            ...current,
            rawContent: content,
            rawError: errorMessage(error),
          };
        }
      });
    },
    setValue: (path: readonly string[], value: JsonValue) => {
      dirtyRef.current = true;
      mutationRevisionRef.current += 1;
      setState((current) => current.targetKey === targetKey
        ? updateDraft(current, (draft) => setJsonPath(draft, path, value))
        : current);
    },
  };
};

export const useSettingsObjectDraft = ({
  property,
  runtimeTarget,
  scope,
  targetKey,
}: SettingsDraftOptions): PluginObjectDraft => {
  const { t } = useI18n();
  const [state, setState] = React.useState<DraftState>(initialState);
  const [watchRevision, setWatchRevision] = React.useState(0);
  const generationRef = React.useRef(0);
  const mutationRevisionRef = React.useRef(0);
  const dirtyRef = React.useRef(false);
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;

  const reload = React.useCallback(async (options: DraftReloadOptions = {}) => {
    if (!options.preserveNewerDraft) setWatchRevision((revision) => revision + 1);
    const generation = ++generationRef.current;
    const mutationRevision = mutationRevisionRef.current;
    const runtimeKey = getRuntimeKey();
    const actionTargetKey = targetKey;
    setState((current) => current.targetKey === actionTargetKey
      ? { ...current, error: null, loading: true }
      : { ...initialState(), loading: true, targetKey: actionTargetKey });
    try {
      const snapshot = await getPiSettings(runtimeTarget);
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      if (!shouldApplyPluginDraftReload(options, mutationRevision, mutationRevisionRef.current)) {
        setState((current) => options.preserveNewerDraft
          ? {
              ...current,
              error: t('settings.piarium.pluginSettings.source.externalChanged'),
              externalChanged: true,
              loading: false,
            }
          : { ...current, loading: false });
        return;
      }
      const document = asJsonObject(snapshot[scope][property]);
      const rawContent = formatPiJsonObjectDocument(document);
      dirtyRef.current = false;
      setState({
        draft: document,
        error: null,
        externalChanged: false,
        loaded: true,
        loading: false,
        path: `${scope}:settings.json#${property}`,
        projectTrusted: snapshot.projectTrusted,
        rawContent,
        rawError: null,
        revision: scope === 'global' ? snapshot.globalRevision : snapshot.projectRevision,
        saving: false,
        source: document,
        targetKey: actionTargetKey,
      });
    } catch (error) {
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setState((current) => current.targetKey === actionTargetKey
        ? preservePluginDraftOnFailure(current, errorMessage(error))
        : { ...initialState(), error: errorMessage(error), targetKey: actionTargetKey });
    }
  }, [property, runtimeTarget, scope, t, targetKey]);

  React.useEffect(() => {
    setState(initialState());
    void reload();
  }, [reload]);

  const save = React.useCallback(async () => {
    if (
      state.targetKey !== targetKey
      || targetKey !== targetKeyRef.current
      || state.saving
      || state.externalChanged
      || state.rawError !== null
      || state.revision === null
      || jsonObjectsEqual(state.source, state.draft)
    ) return;
    const generation = generationRef.current;
    const runtimeKey = getRuntimeKey();
    const actionTargetKey = targetKey;
    setState((current) => ({ ...current, error: null, saving: true }));
    try {
      const changes = Object.keys(state.draft).length === 0
        ? { remove: [property], set: {} }
        : { remove: [], set: { [property]: state.draft } };
      const snapshot = await updatePiSettings(runtimeTarget, scope, changes, state.revision);
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      const document = asJsonObject(snapshot[scope][property]);
      const rawContent = formatPiJsonObjectDocument(document);
      dirtyRef.current = false;
      setState((current) => ({
        ...current,
        draft: document,
        error: null,
        externalChanged: false,
        loaded: true,
        projectTrusted: snapshot.projectTrusted,
        rawContent,
        rawError: null,
        revision: scope === 'global' ? snapshot.globalRevision : snapshot.projectRevision,
        saving: false,
        source: document,
      }));
      notifyPiRuntimeCatalogChanged('plugin-config');
    } catch (error) {
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      const message = errorMessage(error);
      setState((current) => ({ ...current, error: message, saving: false }));
      toast.error(t('settings.common.status.saveFailed'), { description: message });
    }
  }, [property, runtimeTarget, scope, state.draft, state.externalChanged, state.rawError, state.revision, state.saving, state.source, state.targetKey, t, targetKey]);

  const actions = useDraftActions(state, setState, targetKey, mutationRevisionRef, dirtyRef);
  const preserveExternal = React.useCallback((message: string) => {
    setState((current) => current.targetKey === targetKey
      ? { ...current, error: message, externalChanged: true }
      : current);
  }, [targetKey]);
  useRefreshCleanDraft(dirtyRef, actions.loaded, reload);
  useConfigDraftWatch(
    dirtyRef,
    actions.loaded && (scope !== 'project' || actions.projectTrusted),
    reload,
    runtimeTarget,
    [{ kind: 'settings', scope }],
    watchRevision,
    preserveExternal,
  );
  return { ...actions, reload, save };
};

export const useConfigDocumentObjectDraft = ({
  path,
  runtimeTarget,
  scope,
  targetKey,
}: DocumentDraftOptions): PluginObjectDraft => {
  const { t } = useI18n();
  const [state, setState] = React.useState<DraftState>(initialState);
  const [watchRevision, setWatchRevision] = React.useState(0);
  const generationRef = React.useRef(0);
  const mutationRevisionRef = React.useRef(0);
  const dirtyRef = React.useRef(false);
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;

  const reload = React.useCallback(async (options: DraftReloadOptions = {}) => {
    if (!options.preserveNewerDraft) setWatchRevision((revision) => revision + 1);
    const generation = ++generationRef.current;
    const mutationRevision = mutationRevisionRef.current;
    const runtimeKey = getRuntimeKey();
    const actionTargetKey = targetKey;
    setState((current) => current.targetKey === actionTargetKey
      ? { ...current, error: null, loading: true }
      : { ...initialState(), loading: true, targetKey: actionTargetKey });
    try {
      const snapshot = await getPiConfigDocument(runtimeTarget, scope, path);
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      if (!shouldApplyPluginDraftReload(options, mutationRevision, mutationRevisionRef.current)) {
        setState((current) => options.preserveNewerDraft
          ? {
              ...current,
              error: t('settings.piarium.pluginSettings.source.externalChanged'),
              externalChanged: true,
              loading: false,
            }
          : { ...current, loading: false });
        return;
      }
      dirtyRef.current = false;
      setState({
        draft: snapshot.document,
        error: null,
        externalChanged: false,
        loaded: true,
        loading: false,
        path: `${snapshot.scope}:${snapshot.path}`,
        projectTrusted: snapshot.projectTrusted,
        rawContent: formatPiJsonObjectDocument(snapshot.document),
        rawError: null,
        revision: snapshot.revision,
        saving: false,
        source: snapshot.document,
        targetKey: actionTargetKey,
      });
    } catch (error) {
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setState((current) => current.targetKey === actionTargetKey
        ? preservePluginDraftOnFailure(current, errorMessage(error))
        : { ...initialState(), error: errorMessage(error), targetKey: actionTargetKey });
    }
  }, [path, runtimeTarget, scope, t, targetKey]);

  React.useEffect(() => {
    setState(initialState());
    void reload();
  }, [reload]);

  const save = React.useCallback(async () => {
    if (
      state.targetKey !== targetKey
      || targetKey !== targetKeyRef.current
      || state.saving
      || state.externalChanged
      || state.rawError !== null
      || state.revision === null
      || jsonObjectsEqual(state.source, state.draft)
    ) return;
    const generation = generationRef.current;
    const runtimeKey = getRuntimeKey();
    const actionTargetKey = targetKey;
    setState((current) => ({ ...current, error: null, saving: true }));
    try {
      const snapshot = await updatePiConfigDocument(
        runtimeTarget,
        scope,
        path,
        createPiJsonObjectChanges(state.source, state.draft),
        state.revision,
      );
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      dirtyRef.current = false;
      setState({
        draft: snapshot.document,
        error: null,
        externalChanged: false,
        loaded: true,
        loading: false,
        path: `${snapshot.scope}:${snapshot.path}`,
        projectTrusted: snapshot.projectTrusted,
        rawContent: formatPiJsonObjectDocument(snapshot.document),
        rawError: null,
        revision: snapshot.revision,
        saving: false,
        source: snapshot.document,
        targetKey: actionTargetKey,
      });
      notifyPiRuntimeCatalogChanged('plugin-config');
    } catch (error) {
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      const message = errorMessage(error);
      setState((current) => ({ ...current, error: message, saving: false }));
      toast.error(t('settings.common.status.saveFailed'), { description: message });
    }
  }, [path, runtimeTarget, scope, state.draft, state.externalChanged, state.rawError, state.revision, state.saving, state.source, state.targetKey, t, targetKey]);

  const actions = useDraftActions(state, setState, targetKey, mutationRevisionRef, dirtyRef);
  const preserveExternal = React.useCallback((message: string) => {
    setState((current) => current.targetKey === targetKey
      ? { ...current, error: message, externalChanged: true }
      : current);
  }, [targetKey]);
  useRefreshCleanDraft(dirtyRef, actions.loaded, reload);
  useConfigDraftWatch(
    dirtyRef,
    actions.loaded && (scope !== 'project' || actions.projectTrusted),
    reload,
    runtimeTarget,
    [{ kind: 'document', path, scope }],
    watchRevision,
    preserveExternal,
  );
  return { ...actions, reload, save };
};

const parseTextObject = (content: string, format: PiConfigTextFormat): JsonObject => {
  const errors: ParseError[] = [];
  const value = parse(content.replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: format === 'jsonc',
    disallowComments: format === 'json',
  }) as JsonValue | undefined;
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(first
      ? `${printParseErrorCode(first.error)} at offset ${first.offset}`
      : `Invalid ${format.toUpperCase()}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Configuration root must be an object');
  }
  return value as JsonObject;
};

export const parsePluginTextObjectDraft = (
  content: string,
  format: PiConfigTextFormat,
): { draft: JsonObject; rawError: string | null } => {
  try {
    return { draft: parseTextObject(content, format), rawError: null };
  } catch (error) {
    return { draft: {}, rawError: errorMessage(error) };
  }
};

const loadTextDocument = async (
  runtimeTarget: RuntimeContextTarget,
  options: Pick<TextDraftOptions, 'format' | 'paths' | 'root'>,
): Promise<PiConfigTextDocumentSnapshot> => {
  let fallback: PiConfigTextDocumentSnapshot | undefined;
  for (const path of options.paths) {
    const snapshot = await getPiConfigTextDocument(runtimeTarget, options.root, path, options.format);
    fallback ??= snapshot;
    if (snapshot.exists) return snapshot;
  }
  if (fallback) return fallback;
  throw new Error('Could not resolve the plugin configuration path');
};

export const useTextObjectDraft = ({
  format,
  paths,
  root,
  runtimeTarget,
  targetKey,
}: TextDraftOptions): PluginObjectDraft => {
  const { t } = useI18n();
  const pathsKey = paths.join('\0');
  const pathsRef = React.useRef(paths);
  pathsRef.current = paths;
  const pathsKeyRef = React.useRef(pathsKey);
  pathsKeyRef.current = pathsKey;
  const [state, setState] = React.useState<DraftState>(initialState);
  const [watchRevision, setWatchRevision] = React.useState(0);
  const [content, setContent] = React.useState('{}\n');
  const [rawError, setRawError] = React.useState<string | null>(null);
  const [snapshot, setSnapshot] = React.useState<PiConfigTextDocumentSnapshot | null>(null);
  const contentRef = React.useRef('{}\n');
  const generationRef = React.useRef(0);
  const mutationRevisionRef = React.useRef(0);
  const dirtyRef = React.useRef(false);
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;

  const reload = React.useCallback(async (options: DraftReloadOptions = {}) => {
    if (!options.preserveNewerDraft) setWatchRevision((revision) => revision + 1);
    const generation = ++generationRef.current;
    const mutationRevision = mutationRevisionRef.current;
    const runtimeKey = getRuntimeKey();
    const actionTargetKey = targetKey;
    const actionPathsKey = pathsKey;
    setState((current) => current.targetKey === actionTargetKey
      ? { ...current, error: null, loading: true }
      : { ...initialState(), loading: true, targetKey: actionTargetKey });
    try {
      const nextSnapshot = await loadTextDocument(runtimeTarget, {
        format,
        paths: pathsRef.current,
        root,
      });
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || actionPathsKey !== pathsKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      if (!shouldApplyPluginDraftReload(options, mutationRevision, mutationRevisionRef.current)) {
        setState((current) => options.preserveNewerDraft
          ? {
              ...current,
              error: t('settings.piarium.pluginSettings.source.externalChanged'),
              externalChanged: true,
              loading: false,
            }
          : { ...current, loading: false });
        return;
      }
      const parsed = parsePluginTextObjectDraft(nextSnapshot.content, format);
      dirtyRef.current = false;
      setSnapshot(nextSnapshot);
      contentRef.current = nextSnapshot.content;
      setContent(nextSnapshot.content);
      setRawError(parsed.rawError);
      setState({
        draft: parsed.draft,
        error: null,
        externalChanged: false,
        loaded: true,
        loading: false,
        path: `${nextSnapshot.root}:${nextSnapshot.path}`,
        projectTrusted: nextSnapshot.projectTrusted,
        rawContent: nextSnapshot.content,
        rawError: parsed.rawError,
        revision: nextSnapshot.revision,
        saving: false,
        source: parsed.draft,
        targetKey: actionTargetKey,
      });
    } catch (error) {
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || actionPathsKey !== pathsKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setState((current) => current.targetKey === actionTargetKey
        ? preservePluginDraftOnFailure(current, errorMessage(error))
        : { ...initialState(), error: errorMessage(error), targetKey: actionTargetKey });
    }
  }, [format, pathsKey, root, runtimeTarget, t, targetKey]);

  React.useEffect(() => {
    setState(initialState());
    setSnapshot(null);
    contentRef.current = '{}\n';
    setContent('{}\n');
    setRawError(null);
    void reload();
  }, [reload]);

  const setValue = React.useCallback((path: readonly string[], value: JsonValue) => {
    if (state.targetKey !== targetKey || targetKey !== targetKeyRef.current) return;
    dirtyRef.current = true;
    mutationRevisionRef.current += 1;
    const next = updateJsoncPath(contentRef.current, path, value);
    contentRef.current = next;
    setContent(next);
    setRawError(null);
    setState((current) => ({ ...current, draft: parseTextObject(next, format) }));
  }, [format, state.targetKey, targetKey]);

  const removeValue = React.useCallback((path: readonly string[]) => {
    if (state.targetKey !== targetKey || targetKey !== targetKeyRef.current) return;
    dirtyRef.current = true;
    mutationRevisionRef.current += 1;
    const next = removeJsoncPath(contentRef.current, path);
    contentRef.current = next;
    setContent(next);
    setRawError(null);
    setState((current) => ({ ...current, draft: parseTextObject(next, format) }));
  }, [format, state.targetKey, targetKey]);

  const setRawContent = React.useCallback((next: string) => {
    if (state.targetKey !== targetKey || targetKey !== targetKeyRef.current) return;
    dirtyRef.current = true;
    mutationRevisionRef.current += 1;
    contentRef.current = next;
    setContent(next);
    try {
      const draft = parseTextObject(next, format);
      setRawError(null);
      setState((current) => ({ ...current, draft }));
    } catch (error) {
      setRawError(errorMessage(error));
    }
  }, [format, state.targetKey, targetKey]);

  const save = React.useCallback(async () => {
    if (
      state.targetKey !== targetKey
      || targetKey !== targetKeyRef.current
      || state.saving
      || state.externalChanged
      || rawError !== null
      || content === snapshot?.content
      || !snapshot
    ) return;
    const generation = generationRef.current;
    const runtimeKey = getRuntimeKey();
    const actionTargetKey = targetKey;
    setState((current) => ({ ...current, error: null, saving: true }));
    try {
      const nextSnapshot = await updatePiConfigTextDocument(
        runtimeTarget,
        snapshot.root,
        snapshot.path,
        snapshot.format,
        content,
        snapshot.revision,
      );
      const document = parseTextObject(nextSnapshot.content, format);
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      dirtyRef.current = false;
      setSnapshot(nextSnapshot);
      contentRef.current = nextSnapshot.content;
      setContent(nextSnapshot.content);
      setRawError(null);
      setState({
        draft: document,
        error: null,
        externalChanged: false,
        loaded: true,
        loading: false,
        path: `${nextSnapshot.root}:${nextSnapshot.path}`,
        projectTrusted: nextSnapshot.projectTrusted,
        rawContent: nextSnapshot.content,
        rawError: null,
        revision: nextSnapshot.revision,
        saving: false,
        source: document,
        targetKey: actionTargetKey,
      });
      notifyPiRuntimeCatalogChanged('plugin-config');
    } catch (error) {
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      const message = errorMessage(error);
      setState((current) => ({ ...current, error: message, saving: false }));
      toast.error(t('settings.common.status.saveFailed'), { description: message });
    }
  }, [content, format, rawError, runtimeTarget, snapshot, state.externalChanged, state.saving, state.targetKey, t, targetKey]);

  const active = state.targetKey === targetKey;
  const result = {
    dirty: active && snapshot !== null && content !== snapshot.content,
    draft: active ? state.draft : {},
    error: active ? state.error : null,
    externalChanged: active && state.externalChanged,
    loaded: active && state.loaded,
    loading: active ? state.loading : true,
    path: active ? state.path : '',
    projectTrusted: active && state.projectTrusted,
    rawContent: active ? content : '{}\n',
    rawError: active ? rawError : null,
    reload,
    removeValue,
    save,
    saving: active && state.saving,
    setRawContent,
    setValue,
  };
  dirtyRef.current = result.dirty;
  const preserveExternal = React.useCallback((message: string) => {
    setState((current) => current.targetKey === targetKey
      ? { ...current, error: message, externalChanged: true }
      : current);
  }, [targetKey]);
  useRefreshCleanDraft(dirtyRef, result.loaded, reload);
  useConfigDraftWatch(
    dirtyRef,
    result.loaded,
    reload,
    runtimeTarget,
    active && snapshot
      ? pathsRef.current.map((candidatePath) => ({
          format,
          kind: 'text' as const,
          path: candidatePath,
          root,
        }))
      : [],
    watchRevision,
    preserveExternal,
  );
  return result;
};
