import React from 'react';
import type { ModelDescriptor, ThinkingLevel } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { usePiProviderStore } from '@/stores/usePiProviderStore';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useUIStore } from '@/stores/useUIStore';

const modelKey = (model: Pick<ModelDescriptor, 'id' | 'provider'>): string => (
  `${model.provider}\n${model.id}`
);

export const PiModelSelectorDialog: React.FC = () => {
  const open = useUIStore((state) => state.isModelSelectorOpen);
  const setOpen = useUIStore((state) => state.setModelSelectorOpen);
  const favoriteModels = useUIStore((state) => state.favoriteModels);
  const toggleFavorite = useUIStore((state) => state.toggleFavoriteModel);
  const addRecentModel = useUIStore((state) => state.addRecentModel);
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const snapshot = usePiSessionStore((state) => (
    state.currentSessionId === null ? undefined : state.records[state.currentSessionId]?.snapshot
  ));
  const providers = usePiProviderStore((state) => state.allProviders);
  const loading = usePiProviderStore((state) => state.isLoading);
  const error = usePiProviderStore((state) => state.error);
  const load = usePiProviderStore((state) => state.load);
  const [query, setQuery] = React.useState('');
  const [selectingKey, setSelectingKey] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open || !snapshot?.cwd) return;
    void load(snapshot.cwd).catch(() => undefined);
  }, [load, open, snapshot?.cwd]);

  React.useEffect(() => {
    if (open && (!currentSessionId || !snapshot)) setOpen(false);
  }, [currentSessionId, open, setOpen, snapshot]);

  React.useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const favoriteKeys = React.useMemo(() => new Set(
    favoriteModels.map((favorite) => `${favorite.providerID}\n${favorite.modelID}`),
  ), [favoriteModels]);
  const normalizedQuery = query.trim().toLowerCase();
  const models = React.useMemo(() => providers
    .flatMap((provider) => provider.models)
    .filter((model) => model.available)
    .filter((model) => {
      if (!normalizedQuery) return true;
      return `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(normalizedQuery);
    })
    .sort((left, right) => {
      const favoriteDifference = Number(favoriteKeys.has(modelKey(right))) - Number(favoriteKeys.has(modelKey(left)));
      if (favoriteDifference !== 0) return favoriteDifference;
      return `${left.provider}/${left.name}`.localeCompare(`${right.provider}/${right.name}`);
    }), [favoriteKeys, normalizedQuery, providers]);

  const selectModel = React.useCallback(async (model: ModelDescriptor) => {
    if (!currentSessionId) return;
    const key = modelKey(model);
    setSelectingKey(key);
    try {
      await usePiSessionStore.getState().selectModel(currentSessionId, model);
      addRecentModel(model.provider, model.id);
      setOpen(false);
    } catch (selectionError) {
      toast.error('Failed to select Pi model', {
        description: selectionError instanceof Error ? selectionError.message : String(selectionError),
      });
    } finally {
      setSelectingKey(null);
    }
  }, [addRecentModel, currentSessionId, setOpen]);

  const selectThinking = React.useCallback(async (level: ThinkingLevel) => {
    if (!currentSessionId) return;
    try {
      await usePiSessionStore.getState().selectThinking(currentSessionId, level);
    } catch (selectionError) {
      toast.error('Failed to select Pi thinking level', {
        description: selectionError instanceof Error ? selectionError.message : String(selectionError),
      });
    }
  }, [currentSessionId]);

  const thinkingLevels = snapshot?.model?.supportedThinkingLevels ?? [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl gap-4">
        <DialogHeader>
          <DialogTitle>Select Pi model</DialogTitle>
          <DialogDescription>
            Models are read from the active Pi runtime for {snapshot?.cwd ?? 'the current workspace'}.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search models"
          aria-label="Search Pi models"
        />
        {thinkingLevels.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 pb-3">
            <span className="mr-1 typography-meta text-muted-foreground">Thinking</span>
            {thinkingLevels.map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => { void selectThinking(level); }}
                className={cn(
                  'rounded-md border px-2 py-1 typography-micro transition-colors',
                  snapshot?.thinkingLevel === level
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                )}
              >
                {level}
              </button>
            ))}
          </div>
        )}
        <div className="max-h-[min(60vh,38rem)] overflow-y-auto rounded-lg border border-border/70">
          {loading && models.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-muted-foreground">
              <Icon name="loader-4" className="size-4 animate-spin" />
              Loading Pi models
            </div>
          ) : error && models.length === 0 ? (
            <div className="px-4 py-10 text-center typography-ui-label text-[var(--status-error)]">{error}</div>
          ) : models.length === 0 ? (
            <div className="px-4 py-10 text-center typography-ui-label text-muted-foreground">No matching Pi models</div>
          ) : (
            models.map((model) => {
              const key = modelKey(model);
              const selected = snapshot?.model?.provider === model.provider && snapshot.model.id === model.id;
              const favorite = favoriteKeys.has(key);
              return (
                <div key={key} className="flex items-center border-b border-border/50 last:border-b-0 hover:bg-interactive-hover/50">
                  <button
                    type="button"
                    onClick={() => { void selectModel(model); }}
                    disabled={selectingKey !== null}
                    className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left disabled:opacity-50"
                  >
                    <span className={cn('flex size-5 items-center justify-center', selected ? 'text-primary' : 'text-transparent')}>
                      <Icon name={selectingKey === key ? 'loader-4' : 'check'} className={cn('size-3.5', selectingKey === key && 'animate-spin text-primary')} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate typography-ui-label text-foreground">{model.name}</span>
                      <span className="block truncate typography-micro text-muted-foreground">{model.provider}/{model.id}</span>
                    </span>
                    <span className="hidden typography-micro text-muted-foreground sm:block">
                      {model.contextWindow.toLocaleString()} ctx
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleFavorite(model.provider, model.id)}
                    className={cn(
                      'mr-2 flex size-8 items-center justify-center rounded-md hover:bg-interactive-hover',
                      favorite ? 'text-[var(--status-warning)]' : 'text-muted-foreground',
                    )}
                    aria-label={favorite ? `Remove ${model.name} from favorites` : `Add ${model.name} to favorites`}
                  >
                    <Icon name={favorite ? 'star-fill' : 'star'} className="size-4" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
