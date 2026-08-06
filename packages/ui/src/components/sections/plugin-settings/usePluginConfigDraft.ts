import React from 'react';
import type {
  JsonValue,
  PiConfigScope,
  PiConfigTextDocumentSnapshot,
  PiConfigTextFormat,
  PiConfigTextRoot,
  RuntimeContextTarget,
} from '@piarium/protocol';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { toast } from '@/components/ui';
import {
  getPiConfigDocument,
  getPiConfigTextDocument,
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
import { notifyPiRuntimeCatalogChanged } from '@/lib/pi-runtime/catalog-events';
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
  loaded: boolean;
  loading: boolean;
  path: string;
  projectTrusted: boolean;
  rawContent: string;
  rawError: string | null;
  saving: boolean;
  source: JsonObject;
  targetKey: string | null;
}

const initialState = (): DraftState => ({
  draft: {},
  error: null,
  loaded: false,
  loading: false,
  path: '',
  projectTrusted: false,
  rawContent: '{}\n',
  rawError: null,
  saving: false,
  source: {},
  targetKey: null,
});

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const useDraftActions = (
  state: DraftState,
  setState: React.Dispatch<React.SetStateAction<DraftState>>,
  targetKey: string,
) => {
  const active = state.targetKey === targetKey;
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
    dirty: active && !jsonObjectsEqual(state.source, state.draft),
    draft: active ? state.draft : {},
    error: active ? state.error : null,
    loaded: active && state.loaded,
    loading: active ? state.loading : true,
    path: active ? state.path : '',
    projectTrusted: active && state.projectTrusted,
    rawContent: active ? state.rawContent : '{}\n',
    rawError: active ? state.rawError : null,
    removeValue: (path: readonly string[]) => {
      setState((current) => current.targetKey === targetKey
        ? updateDraft(current, (draft) => removeJsonPath(draft, path))
        : current);
    },
    saving: active && state.saving,
    setRawContent: (content: string) => {
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
  const generationRef = React.useRef(0);
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;

  const reload = React.useCallback(async () => {
    const generation = ++generationRef.current;
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
      const document = asJsonObject(snapshot[scope][property]);
      const rawContent = formatPiJsonObjectDocument(document);
      setState({
        draft: document,
        error: null,
        loaded: true,
        loading: false,
        path: `${scope}:settings.json#${property}`,
        projectTrusted: snapshot.projectTrusted,
        rawContent,
        rawError: null,
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
      setState({
        ...initialState(),
        error: errorMessage(error),
        targetKey: actionTargetKey,
      });
    }
  }, [property, runtimeTarget, scope, targetKey]);

  React.useEffect(() => {
    setState(initialState());
    void reload();
  }, [reload]);

  const save = React.useCallback(async () => {
    if (
      state.targetKey !== targetKey
      || targetKey !== targetKeyRef.current
      || state.saving
      || state.rawError !== null
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
      const snapshot = await updatePiSettings(runtimeTarget, scope, changes);
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      const document = asJsonObject(snapshot[scope][property]);
      const rawContent = formatPiJsonObjectDocument(document);
      setState((current) => ({
        ...current,
        draft: document,
        error: null,
        loaded: true,
        projectTrusted: snapshot.projectTrusted,
        rawContent,
        rawError: null,
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
  }, [property, runtimeTarget, scope, state.draft, state.rawError, state.saving, state.source, state.targetKey, t, targetKey]);

  return { ...useDraftActions(state, setState, targetKey), reload, save };
};

export const useConfigDocumentObjectDraft = ({
  path,
  runtimeTarget,
  scope,
  targetKey,
}: DocumentDraftOptions): PluginObjectDraft => {
  const { t } = useI18n();
  const [state, setState] = React.useState<DraftState>(initialState);
  const generationRef = React.useRef(0);
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;

  const reload = React.useCallback(async () => {
    const generation = ++generationRef.current;
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
      setState({
        draft: snapshot.document,
        error: null,
        loaded: true,
        loading: false,
        path: `${snapshot.scope}:${snapshot.path}`,
        projectTrusted: snapshot.projectTrusted,
        rawContent: formatPiJsonObjectDocument(snapshot.document),
        rawError: null,
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
      setState({
        ...initialState(),
        error: errorMessage(error),
        targetKey: actionTargetKey,
      });
    }
  }, [path, runtimeTarget, scope, targetKey]);

  React.useEffect(() => {
    setState(initialState());
    void reload();
  }, [reload]);

  const save = React.useCallback(async () => {
    if (
      state.targetKey !== targetKey
      || targetKey !== targetKeyRef.current
      || state.saving
      || state.rawError !== null
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
      );
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setState({
        draft: snapshot.document,
        error: null,
        loaded: true,
        loading: false,
        path: `${snapshot.scope}:${snapshot.path}`,
        projectTrusted: snapshot.projectTrusted,
        rawContent: formatPiJsonObjectDocument(snapshot.document),
        rawError: null,
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
  }, [path, runtimeTarget, scope, state.draft, state.rawError, state.saving, state.source, state.targetKey, t, targetKey]);

  return { ...useDraftActions(state, setState, targetKey), reload, save };
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
  const [state, setState] = React.useState<DraftState>(initialState);
  const [content, setContent] = React.useState('{}\n');
  const [rawError, setRawError] = React.useState<string | null>(null);
  const [snapshot, setSnapshot] = React.useState<PiConfigTextDocumentSnapshot | null>(null);
  const contentRef = React.useRef('{}\n');
  const generationRef = React.useRef(0);
  const targetKeyRef = React.useRef(targetKey);
  targetKeyRef.current = targetKey;

  const reload = React.useCallback(async () => {
    const generation = ++generationRef.current;
    const runtimeKey = getRuntimeKey();
    const actionTargetKey = targetKey;
    setState((current) => current.targetKey === actionTargetKey
      ? { ...current, error: null, loading: true }
      : { ...initialState(), loading: true, targetKey: actionTargetKey });
    try {
      const nextSnapshot = await loadTextDocument(runtimeTarget, { format, paths, root });
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      const parsed = parsePluginTextObjectDraft(nextSnapshot.content, format);
      setSnapshot(nextSnapshot);
      contentRef.current = nextSnapshot.content;
      setContent(nextSnapshot.content);
      setRawError(parsed.rawError);
      setState({
        draft: parsed.draft,
        error: null,
        loaded: true,
        loading: false,
        path: `${nextSnapshot.root}:${nextSnapshot.path}`,
        projectTrusted: nextSnapshot.projectTrusted,
        rawContent: nextSnapshot.content,
        rawError: parsed.rawError,
        saving: false,
        source: parsed.draft,
        targetKey: actionTargetKey,
      });
    } catch (error) {
      if (
        generation !== generationRef.current
        || actionTargetKey !== targetKeyRef.current
        || runtimeKey !== getRuntimeKey()
      ) return;
      setState({
        ...initialState(),
        error: errorMessage(error),
        targetKey: actionTargetKey,
      });
    }
  }, [format, paths, root, runtimeTarget, targetKey]);

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
    const next = updateJsoncPath(contentRef.current, path, value);
    contentRef.current = next;
    setContent(next);
    setRawError(null);
    setState((current) => ({ ...current, draft: parseTextObject(next, format) }));
  }, [format, state.targetKey, targetKey]);

  const removeValue = React.useCallback((path: readonly string[]) => {
    if (state.targetKey !== targetKey || targetKey !== targetKeyRef.current) return;
    const next = removeJsoncPath(contentRef.current, path);
    contentRef.current = next;
    setContent(next);
    setRawError(null);
    setState((current) => ({ ...current, draft: parseTextObject(next, format) }));
  }, [format, state.targetKey, targetKey]);

  const setRawContent = React.useCallback((next: string) => {
    if (state.targetKey !== targetKey || targetKey !== targetKeyRef.current) return;
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
      setSnapshot(nextSnapshot);
      contentRef.current = nextSnapshot.content;
      setContent(nextSnapshot.content);
      setRawError(null);
      setState({
        draft: document,
        error: null,
        loaded: true,
        loading: false,
        path: `${nextSnapshot.root}:${nextSnapshot.path}`,
        projectTrusted: nextSnapshot.projectTrusted,
        rawContent: nextSnapshot.content,
        rawError: null,
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
  }, [content, format, rawError, runtimeTarget, snapshot, state.saving, state.targetKey, t, targetKey]);

  const active = state.targetKey === targetKey;
  return {
    dirty: active && snapshot !== null && content !== snapshot.content,
    draft: active ? state.draft : {},
    error: active ? state.error : null,
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
};
