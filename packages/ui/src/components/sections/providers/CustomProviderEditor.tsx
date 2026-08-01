"use client";

import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { opencodeClient } from '@/lib/opencode/client';
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  mergeCustomProviderModelRows,
  normalizeCustomProviderModelRows,
  resolveCustomProviderApiKey,
} from './customProviderForm';
import type {
  CustomProviderApiTypeValue,
  CustomProviderEditableFormState,
  CustomProviderModelRowInput,
} from './customProviderForm';

interface CustomProviderEditorProps {
  mode: 'create' | 'edit';
  initialState?: CustomProviderEditableFormState;
  onSaved?: (providerId: string) => void;
  onCancel?: () => void;
}

const API_TYPES: CustomProviderApiTypeValue[] = [
  'openai-compatible',
  'openai-responses',
  'anthropic',
  'google',
];

const SCOPES: Array<'user' | 'project' | 'custom'> = ['user', 'project', 'custom'];

const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const MODEL_IMPORT_SORT_OPTIONS = [
  { value: 'id-asc', labelKey: 'settings.providers.page.modelImport.sort.idAsc' },
  { value: 'id-desc', labelKey: 'settings.providers.page.modelImport.sort.idDesc' },
  { value: 'fetched-order', labelKey: 'settings.providers.page.modelImport.sort.fetchedOrder' },
] as const;
type ModelImportSortValue = typeof MODEL_IMPORT_SORT_OPTIONS[number]['value'];

const shouldIgnoreToggleRowClick = (target: EventTarget | null): boolean => (
  target instanceof HTMLElement && Boolean(target.closest('[data-checkbox-control="true"]'))
);

const getCurrentDirectory = (): string | null => {
  const dir = opencodeClient.getDirectory();
  if (typeof dir === 'string' && dir.trim().length > 0) {
    return dir.trim();
  }
  return null;
};

const createEmptyState = (): CustomProviderEditableFormState => ({
  type: 'openai-compatible',
  id: '',
  name: '',
  baseURL: '',
  models: [
    {
      id: '',
      name: '',
      context: '',
      output: '',
      attachment: false,
      tool_call: false,
      reasoning: false,
      reasoningEffort: '',
    },
  ],
  apiKey: '',
  scope: 'user',
});

export const CustomProviderEditor: React.FC<CustomProviderEditorProps> = ({
  mode,
  initialState,
  onSaved,
  onCancel,
}) => {
  const { t } = useI18n();
  const tUnsafe = React.useCallback(
    (key: string) => t(key as Parameters<typeof t>[0]),
    [t]
  );
  const [state, setState] = React.useState<CustomProviderEditableFormState>(() =>
    initialState ? { ...initialState, models: initialState.models.map((m) => ({ ...m })) } : createEmptyState()
  );
  const [saving, setSaving] = React.useState(false);
  const [fetchingModels, setFetchingModels] = React.useState(false);
  const [modelImportDialogOpen, setModelImportDialogOpen] = React.useState(false);
  const [fetchedModels, setFetchedModels] = React.useState<CustomProviderModelRowInput[]>([]);
  const [modelImportSearch, setModelImportSearch] = React.useState('');
  const [modelImportSort, setModelImportSort] = React.useState<ModelImportSortValue>('id-asc');
  const [modelImportSelectedIds, setModelImportSelectedIds] = React.useState<Set<string>>(new Set());
  const apiKeyFieldRef = React.useRef<HTMLDivElement | null>(null);
  const originalEditScopeRef = React.useRef<CustomProviderEditableFormState['scope'] | null>(
    mode === 'edit' && initialState ? initialState.scope : null,
  );

  React.useEffect(() => {
    if (initialState) {
      if (mode === 'edit') {
        originalEditScopeRef.current = initialState.scope;
      }
      setState({
        ...initialState,
        models: initialState.models.map((m) => ({ ...m })),
      });
    }
  }, [initialState, mode]);

  const readApiKey = React.useCallback(() => (
    resolveCustomProviderApiKey(
      state.apiKey,
      apiKeyFieldRef.current?.querySelector<HTMLInputElement>('input[type="password"]') ?? undefined,
    )
  ), [state.apiKey]);

  const updateField = <K extends keyof CustomProviderEditableFormState>(
    field: K,
    value: CustomProviderEditableFormState[K]
  ) => {
    setState((prev) => ({ ...prev, [field]: value }));
  };

  const updateModel = <K extends keyof CustomProviderEditableFormState['models'][number]>(
    index: number,
    field: K,
    value: CustomProviderEditableFormState['models'][number][K]
  ) => {
    setState((prev) => {
      const nextModels = prev.models.map((row, i) => (i === index ? { ...row, [field]: value } : row));
      return { ...prev, models: nextModels };
    });
  };

  const addModel = () => {
    setState((prev) => ({
      ...prev,
      models: [
        ...prev.models,
        {
          id: '',
          name: '',
          context: '',
          output: '',
          attachment: false,
          tool_call: false,
          reasoning: false,
          reasoningEffort: '',
        },
      ],
    }));
  };

  const removeModel = (index: number) => {
    setState((prev) => {
      const nextModels = prev.models.filter((_, i) => i !== index);
      return { ...prev, models: nextModels.length > 0 ? nextModels : [createEmptyState().models[0]] };
    });
  };

  const handleFetchModels = async () => {
    const baseURL = state.baseURL.trim();
    const apiKey = readApiKey();

    if (!baseURL || !apiKey) {
      toast.error(t('settings.providers.page.toast.customProviderFetchRequired'));
      return;
    }

    setFetchingModels(true);
    try {
      const response = await runtimeFetch('/api/provider/custom/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: state.type,
          baseURL,
          apiKey,
        }),
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error || t('settings.providers.page.toast.customProviderFetchFailed');
        toast.error(message);
        return;
      }

      const fetched = Array.isArray(payload?.models) ? payload.models : [];
      if (fetched.length === 0) {
        toast.error(t('settings.providers.page.toast.customProviderFetchNoModels'));
        return;
      }

      setFetchedModels(fetched);
      setModelImportSearch('');
      setModelImportSort('id-asc');
      setModelImportSelectedIds(() => {
        const next = new Set<string>();
        for (const model of fetched) {
          const id = String(model.id ?? '').trim();
          if (id && !existingModelIds.has(id)) {
            next.add(id);
          }
        }
        return next;
      });
      setModelImportDialogOpen(true);
    } catch (error) {
      console.error('Failed to fetch custom provider models:', error);
      toast.error(t('settings.providers.page.toast.customProviderFetchFailed'));
    } finally {
      setFetchingModels(false);
    }
  };

  const existingModelIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const row of state.models) {
      const id = row.id.trim();
      if (id) {
        ids.add(id);
      }
    }
    return ids;
  }, [state.models]);

  const modelImportSummary = React.useMemo(() => {
    const total = fetchedModels.length;
    let newCount = 0;
    for (const model of fetchedModels) {
      const id = String(model.id ?? '').trim();
      if (id && !existingModelIds.has(id)) {
        newCount += 1;
      }
    }
    return {
      total,
      newCount,
      existingCount: total - newCount,
    };
  }, [fetchedModels, existingModelIds]);

  const displayFetchedModels = React.useMemo(() => {
    const query = modelImportSearch.trim().toLowerCase();
    let rows = fetchedModels.map((model, index) => ({ model, index }));

    if (query) {
      rows = rows.filter(({ model }) => {
        const id = String(model.id ?? '').trim().toLowerCase();
        const name = String(model.name ?? '').trim().toLowerCase();
        return id.includes(query) || name.includes(query);
      });
    }

    switch (modelImportSort) {
      case 'id-asc':
        rows.sort((a, b) => {
          const idA = String(a.model.id ?? '').trim().toLowerCase();
          const idB = String(b.model.id ?? '').trim().toLowerCase();
          return idA.localeCompare(idB);
        });
        break;
      case 'id-desc':
        rows.sort((a, b) => {
          const idA = String(a.model.id ?? '').trim().toLowerCase();
          const idB = String(b.model.id ?? '').trim().toLowerCase();
          return idB.localeCompare(idA);
        });
        break;
      default:
        break;
    }

    return rows;
  }, [fetchedModels, modelImportSearch, modelImportSort]);

  const toggleModelImportSelection = (id: string) => {
    setModelImportSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAllVisibleFetchedModels = () => {
    setModelImportSelectedIds((prev) => {
      const next = new Set(prev);
      for (const { model } of displayFetchedModels) {
        const id = String(model.id ?? '').trim();
        if (id) {
          next.add(id);
        }
      }
      return next;
    });
  };

  const clearVisibleFetchedModels = () => {
    setModelImportSelectedIds((prev) => {
      const next = new Set(prev);
      for (const { model } of displayFetchedModels) {
        const id = String(model.id ?? '').trim();
        if (id) {
          next.delete(id);
        }
      }
      return next;
    });
  };

  const selectNewVisibleFetchedModels = () => {
    setModelImportSelectedIds((prev) => {
      const next = new Set(prev);
      for (const { model } of displayFetchedModels) {
        const id = String(model.id ?? '').trim();
        if (id && !existingModelIds.has(id)) {
          next.add(id);
        }
      }
      return next;
    });
  };

  const applyModelImport = () => {
    const selectedModels = fetchedModels.filter((model) => {
      const id = String(model.id ?? '').trim();
      return id && modelImportSelectedIds.has(id);
    });

    if (selectedModels.length === 0) {
      setModelImportDialogOpen(false);
      return;
    }

    setState((prev) => ({
      ...prev,
      models: mergeCustomProviderModelRows(prev.models, selectedModels),
    }));

    toast.success(
      t('settings.providers.page.toast.customProviderModelsImported', { count: selectedModels.length }),
    );
    setModelImportDialogOpen(false);
    setFetchedModels([]);
    setModelImportSelectedIds(new Set());
  };

  const renderModelImportSortLabel = (value: ModelImportSortValue) => {
    const option = MODEL_IMPORT_SORT_OPTIONS.find((opt) => opt.value === value);
    return option ? tUnsafe(option.labelKey) : '';
  };

  const validate = (): boolean => {
    const id = state.id.trim();
    const baseURL = state.baseURL.trim();
    const hasModelWithId = state.models.some((row) => row.id.trim().length > 0);

    if (!id || !baseURL || !hasModelWithId) {
      toast.error(t('settings.providers.page.toast.customProviderRequired'));
      return false;
    }

    return true;
  };

  const handleSave = async () => {
    if (!validate()) {
      return;
    }

    setSaving(true);
    try {
      const resolvedScope = mode === 'edit' ? (originalEditScopeRef.current ?? state.scope) : state.scope;
      const directory = resolvedScope === 'project' ? getCurrentDirectory() : null;
      const apiKey = readApiKey();
      const payload = {
        id: state.id.trim(),
        name: state.name.trim() || state.id.trim(),
        baseURL: state.baseURL.trim(),
        type: state.type,
        scope: resolvedScope,
        ...(apiKey ? { apiKey } : {}),
        models: normalizeCustomProviderModelRows(state.models),
      };

      const response = await runtimeFetch('/api/provider/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(directory ? { query: { directory } } : {}),
        body: JSON.stringify(payload),
      });

      const result = await response.json().catch(() => null);
      if (!response.ok) {
        const message = result?.error || t('settings.providers.page.toast.customProviderSaveFailed');
        toast.error(message);
        return;
      }

      toast.success(t('settings.providers.page.toast.customProviderSaved'));

      await reloadOpenCodeConfiguration({ scopes: ['providers'], mode: 'active' });

      const currentDirectory = getCurrentDirectory();
      await useConfigStore.getState().loadProviders({ directory: currentDirectory, force: true });

      const savedProviderId = typeof result?.providerId === 'string' ? result.providerId : state.id.trim();
      onSaved?.(savedProviderId);
    } catch (error) {
      console.error('Failed to save custom provider:', error);
      const message = error instanceof Error ? error.message : t('settings.providers.page.toast.customProviderSaveFailed');
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const renderTypeDescription = (type: CustomProviderApiTypeValue) => {
    switch (type) {
      case 'openai-compatible':
        return t('settings.providers.page.custom.type.openaiCompatible.description');
      case 'openai-responses':
        return t('settings.providers.page.custom.type.openaiResponses.description');
      case 'anthropic':
        return t('settings.providers.page.custom.type.anthropic.description');
      case 'google':
        return t('settings.providers.page.custom.type.google.description');
      default:
        return '';
    }
  };

  const getTypeLabelKey = (type: CustomProviderApiTypeValue) => {
    const suffix = type === 'openai-compatible' ? 'openaiCompatible' : type === 'openai-responses' ? 'openaiResponses' : type;
    return `settings.providers.page.custom.type.${suffix}.label`;
  };

  return (
    <div className="space-y-6">
      <div data-settings-item="providers.custom" className="space-y-4">
        <div className="space-y-4">
          <div className="flex flex-col gap-1.5">
            <label className="typography-ui-label text-foreground">
              {t('settings.providers.page.custom.field.type')}
            </label>
            <Select value={state.type} onValueChange={(value) => updateField('type', value as CustomProviderApiTypeValue)}>
              <SelectTrigger className="w-full sm:w-[280px]">
                <SelectValue>
                  {(value) =>
                    value && typeof value === 'string'
                      ? tUnsafe(getTypeLabelKey(value as CustomProviderApiTypeValue))
                      : ''
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {API_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    <div className="flex flex-col items-start">
                      <span className="typography-ui-label">
                        {tUnsafe(getTypeLabelKey(type))}
                      </span>
                      <span className="typography-micro text-muted-foreground">
                        {renderTypeDescription(type)}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label className="typography-ui-label text-foreground">
                {t('settings.providers.page.custom.field.id')}
              </label>
              <Input
                value={state.id}
                onChange={(event) => updateField('id', event.target.value)}
                placeholder={t('settings.providers.page.custom.placeholder.id')}
                className="h-7"
                disabled={mode === 'edit'}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="typography-ui-label text-foreground">
                {t('settings.providers.page.custom.field.name')}
              </label>
              <Input
                value={state.name}
                onChange={(event) => updateField('name', event.target.value)}
                placeholder={t('settings.providers.page.custom.placeholder.name')}
                className="h-7"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="typography-ui-label text-foreground">
              {t('settings.providers.page.custom.field.baseURL')}
            </label>
            <Input
              value={state.baseURL}
              onChange={(event) => updateField('baseURL', event.target.value)}
              placeholder={t('settings.providers.page.custom.placeholder.baseURL')}
              className="h-7"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="typography-ui-label text-foreground">
              {t('settings.providers.page.custom.field.scope')}
            </label>
            {mode === 'edit' ? (
              <div className="flex h-7 w-fit items-center rounded-lg border border-[var(--interactive-border)] px-2 typography-ui-label text-muted-foreground">
                {tUnsafe(`settings.providers.page.custom.scope.${originalEditScopeRef.current ?? state.scope}`)}
              </div>
            ) : (
              <Select
                value={state.scope}
                onValueChange={(value) => updateField('scope', value as 'user' | 'project' | 'custom')}
              >
                <SelectTrigger className="w-full sm:w-[200px]">
                  <SelectValue>
                    {(value) => (value ? tUnsafe(`settings.providers.page.custom.scope.${value}`) : '')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {SCOPES.map((scope) => (
                    <SelectItem key={scope} value={scope}>
                      {tUnsafe(`settings.providers.page.custom.scope.${scope}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div ref={apiKeyFieldRef} className="flex flex-col gap-1.5">
            <label className="typography-ui-label text-foreground">
              {t('settings.providers.page.custom.field.apiKey')}
            </label>
            <Input
              type="password"
              value={state.apiKey}
              onChange={(event) => updateField('apiKey', event.target.value)}
              placeholder={t('settings.providers.page.custom.placeholder.apiKey')}
              className="h-7 font-mono text-xs"
            />
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.providers.page.custom.field.models')}
            </h3>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={handleFetchModels}
                disabled={fetchingModels}
              >
                {fetchingModels
                  ? t('settings.providers.page.actions.fetchingModels')
                  : t('settings.providers.page.actions.fetchModels')}
              </Button>
              <Button variant="outline" size="xs" className="!font-normal" onClick={addModel}>
                {t('settings.providers.page.actions.addModel')}
              </Button>
            </div>
          </div>

          <div className="space-y-3">
            {state.models.map((row, index) => (
              <div
                key={`${index}-${row.id}`}
                className="rounded-lg border border-[var(--surface-subtle)] p-3"
              >
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <label className="typography-meta text-muted-foreground">
                      {t('settings.providers.page.custom.field.models')}
                    </label>
                    <Input
                      value={row.id}
                      onChange={(event) => updateModel(index, 'id', event.target.value)}
                      placeholder={t('settings.providers.page.custom.placeholder.modelId')}
                      className="h-7"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="typography-meta text-muted-foreground">
                      {t('settings.providers.page.custom.field.name')}
                    </label>
                    <Input
                      value={row.name}
                      onChange={(event) => updateModel(index, 'name', event.target.value)}
                      placeholder={t('settings.providers.page.custom.placeholder.modelName')}
                      className="h-7"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="typography-meta text-muted-foreground">
                      {t('settings.providers.page.models.tokenBadge.context')}
                    </label>
                    <Input
                      value={row.context}
                      onChange={(event) => updateModel(index, 'context', event.target.value)}
                      placeholder={t('settings.providers.page.custom.placeholder.contextLimit')}
                      className="h-7"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="typography-meta text-muted-foreground">
                      {t('settings.providers.page.models.tokenBadge.output')}
                    </label>
                    <Input
                      value={row.output}
                      onChange={(event) => updateModel(index, 'output', event.target.value)}
                      placeholder={t('settings.providers.page.custom.placeholder.outputLimit')}
                      className="h-7"
                    />
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-4">
                  <label
                    className="flex cursor-pointer items-center gap-2"
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      if (shouldIgnoreToggleRowClick(event.target)) return;
                      updateModel(index, 'attachment', !row.attachment);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        updateModel(index, 'attachment', !row.attachment);
                      }
                    }}
                  >
                    <span data-checkbox-control="true">
                      <Checkbox
                        checked={row.attachment}
                        onChange={(checked) => updateModel(index, 'attachment', checked)}
                        ariaLabel={t('settings.providers.page.models.capability.imageInput')}
                      />
                    </span>
                    <span className="typography-ui-label font-normal text-foreground">
                      {t('settings.providers.page.models.capability.imageInput')}
                    </span>
                  </label>

                  <label
                    className="flex cursor-pointer items-center gap-2"
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      if (shouldIgnoreToggleRowClick(event.target)) return;
                      updateModel(index, 'tool_call', !row.tool_call);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        updateModel(index, 'tool_call', !row.tool_call);
                      }
                    }}
                  >
                    <span data-checkbox-control="true">
                      <Checkbox
                        checked={row.tool_call}
                        onChange={(checked) => updateModel(index, 'tool_call', checked)}
                        ariaLabel={t('settings.providers.page.models.capability.toolCalling')}
                      />
                    </span>
                    <span className="typography-ui-label font-normal text-foreground">
                      {t('settings.providers.page.models.capability.toolCalling')}
                    </span>
                  </label>

                  <label
                    className="flex cursor-pointer items-center gap-2"
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      if (shouldIgnoreToggleRowClick(event.target)) return;
                      updateModel(index, 'reasoning', !row.reasoning);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        updateModel(index, 'reasoning', !row.reasoning);
                      }
                    }}
                  >
                    <span data-checkbox-control="true">
                      <Checkbox
                        checked={row.reasoning}
                        onChange={(checked) => updateModel(index, 'reasoning', checked)}
                        ariaLabel={t('settings.providers.page.models.capability.reasoning')}
                      />
                    </span>
                    <span className="typography-ui-label font-normal text-foreground">
                      {t('settings.providers.page.models.capability.reasoning')}
                    </span>
                  </label>

                  {row.reasoning && (
                    <Select
                      value={row.reasoningEffort || 'none'}
                      onValueChange={(value) => updateModel(index, 'reasoningEffort', value)}
                    >
                    <SelectTrigger className="w-[160px]">
                      <SelectValue>
                        {(value) =>
                          value ? tUnsafe(`settings.providers.page.custom.reasoningEffort.${value}`) : ''
                        }
                      </SelectValue>
                    </SelectTrigger>
                      <SelectContent>
                        {REASONING_EFFORTS.map((effort) => (
                          <SelectItem key={effort} value={effort}>
                            {tUnsafe(`settings.providers.page.custom.reasoningEffort.${effort}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                <div className="mt-3 flex justify-end">
                  <Button
                    variant="ghost"
                    size="xs"
                    className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
                    onClick={() => removeModel(index)}
                  >
                    {t('settings.providers.page.actions.removeModel')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <Button variant="outline" size="xs" className="!font-normal" onClick={onCancel} disabled={saving}>
            {t('settings.providers.page.actions.cancel')}
          </Button>
        )}
        <Button size="xs" className="!font-normal" onClick={handleSave} disabled={saving}>
          {saving ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.saveProvider')}
        </Button>
      </div>

      <Dialog open={modelImportDialogOpen} onOpenChange={setModelImportDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('settings.providers.page.modelImport.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.providers.page.modelImport.description')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="typography-small text-muted-foreground">
                {t('settings.providers.page.modelImport.summary', {
                  total: modelImportSummary.total,
                  newCount: modelImportSummary.newCount,
                  existingCount: modelImportSummary.existingCount,
                })}
              </span>
              <div className="flex items-center gap-2">
                <Select value={modelImportSort} onValueChange={(value) => setModelImportSort(value as ModelImportSortValue)}>
                  <SelectTrigger className="h-7 w-[160px]">
                    <SelectValue>{renderModelImportSortLabel(modelImportSort)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {MODEL_IMPORT_SORT_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {tUnsafe(option.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Input
              value={modelImportSearch}
              onChange={(event) => setModelImportSearch(event.target.value)}
              placeholder={t('settings.providers.page.modelImport.field.searchPlaceholder')}
              aria-label={t('settings.providers.page.modelImport.field.searchAria')}
              className="h-7"
            />

            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={selectAllVisibleFetchedModels}
              >
                {t('settings.providers.page.modelImport.actions.selectAll')}
              </Button>
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={selectNewVisibleFetchedModels}
              >
                {t('settings.providers.page.modelImport.actions.selectNew')}
              </Button>
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={clearVisibleFetchedModels}
              >
                {t('settings.providers.page.modelImport.actions.clear')}
              </Button>
            </div>

            <div className="max-h-[320px] overflow-y-auto rounded-lg border border-[var(--surface-subtle)] p-1">
              {displayFetchedModels.length === 0 ? (
                <div className="px-3 py-4 text-center typography-ui-label text-muted-foreground">
                  {t('settings.providers.page.modelImport.empty.noMatches')}
                </div>
              ) : (
                <div className="space-y-0.5">
                  {displayFetchedModels.map(({ model, index }) => {
                    const id = String(model.id ?? '').trim();
                    const name = String(model.name ?? '').trim();
                    const isExisting = existingModelIds.has(id);
                    const isSelected = id ? modelImportSelectedIds.has(id) : false;

                    return (
                      <div
                        key={`${index}-${id}`}
                        role="button"
                        tabIndex={0}
                        className="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--interactive-hover)]"
                        onClick={() => id && toggleModelImportSelection(id)}
                        onKeyDown={(event) => {
                          if ((event.key === 'Enter' || event.key === ' ') && id) {
                            event.preventDefault();
                            toggleModelImportSelection(id);
                          }
                        }}
                      >
                        <span data-checkbox-control="true" onClick={(event) => event.stopPropagation()}>
                          <Checkbox
                            checked={isSelected}
                            onChange={() => id && toggleModelImportSelection(id)}
                            ariaLabel={id}
                          />
                        </span>
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="typography-ui-label truncate">{id}</span>
                          {name && name !== id && (
                            <span className="typography-small text-muted-foreground truncate">{name}</span>
                          )}
                        </div>
                        {isExisting ? (
                          <span className="typography-micro rounded bg-[var(--surface-subtle)] px-1.5 py-0.5 text-muted-foreground">
                            {t('settings.providers.page.modelImport.badge.existing')}
                          </span>
                        ) : (
                          <span className="typography-micro rounded bg-[var(--surface-subtle)] px-1.5 py-0.5 text-muted-foreground">
                            {t('settings.providers.page.modelImport.badge.new')}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => setModelImportDialogOpen(false)}
            >
              {t('settings.providers.page.actions.cancel')}
            </Button>
            <Button
              size="xs"
              className="!font-normal"
              onClick={applyModelImport}
              disabled={modelImportSelectedIds.size === 0}
            >
              {t('settings.providers.page.modelImport.actions.apply', { count: modelImportSelectedIds.size })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
