"use client";

import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { THINKING_LEVELS, type ProviderModelConfigInput, type ThinkingLevel } from '@piarium/protocol';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  isCustomProviderThinkingLevelEnabled,
  setCustomProviderThinkingLevelEnabled,
  setCustomProviderThinkingLevelMapping,
} from './customProviderForm';

interface CustomProviderReasoningLevelsProps {
  onChange(map: ProviderModelConfigInput['thinkingLevelMap']): void;
  value: ProviderModelConfigInput['thinkingLevelMap'];
}

const levelTranslationKey = (level: ThinkingLevel) => (
  `settings.providers.page.custom.reasoningEffort.${level === 'off' ? 'none' : level}` as const
);

const defaultProviderValue = (level: ThinkingLevel): string => (
  level === 'off' ? '' : level
);

const resolvePortalContainer = (node: HTMLElement | null): HTMLElement | null => (
  node?.closest('[data-slot="dialog-content"], [role="dialog"]') as HTMLElement | null
);

export const CustomProviderReasoningLevels: React.FC<CustomProviderReasoningLevelsProps> = ({
  onChange,
  value,
}) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null);
  const [customOpen, setCustomOpen] = React.useState(false);
  const [customLevel, setCustomLevel] = React.useState<ThinkingLevel>('max');
  const [customValue, setCustomValue] = React.useState('');
  const customDirtyRef = React.useRef(false);
  const valueRef = React.useRef(value);
  valueRef.current = value;

  const enabledCount = THINKING_LEVELS.reduce(
    (count, level) => count + (isCustomProviderThinkingLevelEnabled(value, level) ? 1 : 0),
    0,
  );

  const emitChange = React.useCallback((next: ProviderModelConfigInput['thinkingLevelMap']) => {
    valueRef.current = next;
    onChange(next);
  }, [onChange]);

  const commitCustomMapping = React.useCallback(() => {
    if (!customDirtyRef.current) return;
    customDirtyRef.current = false;
    emitChange(setCustomProviderThinkingLevelMapping(valueRef.current, customLevel, customValue));
  }, [customLevel, customValue, emitChange]);

  const resetCustomDraft = React.useCallback((level: ThinkingLevel) => {
    const mapped = valueRef.current?.[level];
    setCustomLevel(level);
    setCustomValue(typeof mapped === 'string' ? mapped : defaultProviderValue(level));
    customDirtyRef.current = false;
  }, []);

  const handleTriggerRef = React.useCallback((node: HTMLButtonElement | null) => {
    setPortalContainer(resolvePortalContainer(node));
  }, []);

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      commitCustomMapping();
      setCustomOpen(false);
    }
    setOpen(nextOpen);
  }, [commitCustomMapping]);

  const beginCustomMapping = () => {
    resetCustomDraft(customLevel);
    setCustomOpen(true);
  };

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        ref={handleTriggerRef}
        className="flex h-9 min-w-[154px] items-center justify-between gap-3 rounded-lg border border-[var(--interactive-border)] bg-transparent px-3 typography-ui-label text-foreground transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
        aria-label={t('settings.providers.page.custom.reasoningEffort.levels')}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Icon name="brain-ai-3" className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {t('settings.providers.page.custom.reasoningEffort.levels')}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
          <span className="typography-micro tabular-nums">{enabledCount}/{THINKING_LEVELS.length}</span>
          <Icon
            name="arrow-down-s"
            className={cn('size-4 transition-transform duration-200', open && 'rotate-180')}
          />
        </span>
      </Popover.Trigger>

      <Popover.Portal container={portalContainer ?? undefined}>
        <Popover.Positioner align="start" side="bottom" sideOffset={6} className="app-region-no-drag z-50">
          <Popover.Popup
            initialFocus={false}
            className="w-[min(280px,calc(100vw-2rem))] origin-top overflow-hidden rounded-xl border border-border bg-[var(--surface-elevated)] p-1 text-[var(--surface-elevated-foreground)] shadow-lg outline-none transition-[opacity,transform] duration-150 ease-out data-[starting-style]:-translate-y-1 data-[starting-style]:scale-y-95 data-[starting-style]:opacity-0 data-[ending-style]:-translate-y-1 data-[ending-style]:scale-y-95 data-[ending-style]:opacity-0"
          >
            <Popover.Title className="px-2 py-1.5 typography-ui-label font-medium">
              {t('settings.providers.page.custom.reasoningEffort.levels')}
            </Popover.Title>

            <div className="space-y-0.5">
              {THINKING_LEVELS.map((level) => {
                const enabled = isCustomProviderThinkingLevelEnabled(value, level);
                const mapped = value?.[level];
                const customMapping = typeof mapped === 'string'
                  && mapped !== level
                  && !(level === 'off' && mapped === 'none')
                  ? mapped
                  : null;
                return (
                  <button
                    key={level}
                    type="button"
                    role="checkbox"
                    aria-checked={enabled}
                    className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left typography-ui-label text-foreground outline-none transition-colors hover:bg-interactive-hover focus-visible:bg-interactive-hover"
                    onClick={() => emitChange(setCustomProviderThinkingLevelEnabled(
                      valueRef.current,
                      level,
                      !isCustomProviderThinkingLevelEnabled(valueRef.current, level),
                    ))}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
                        enabled
                          ? 'border-[color:color-mix(in_srgb,var(--primary-base)_65%,var(--interactive-border))] text-[var(--primary-base)]'
                          : 'border-[var(--interactive-border)] text-transparent',
                      )}
                    >
                      <Icon name="check" className="size-3" />
                    </span>
                    <span className="min-w-0 flex-1 truncate">{t(levelTranslationKey(level))}</span>
                    {customMapping ? (
                      <span className="max-w-[112px] truncate font-mono typography-micro text-muted-foreground">
                        → {customMapping}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            <div className="mx-1 my-1 h-px bg-border" />

            {customOpen ? (
              <div className="space-y-2 rounded-lg bg-[var(--surface-subtle)] p-2">
                <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-2">
                  <div className="relative min-w-0">
                    <select
                      value={customLevel}
                      onChange={(event) => {
                        const next = event.target.value as ThinkingLevel;
                        if (!THINKING_LEVELS.includes(next)) return;
                        commitCustomMapping();
                        resetCustomDraft(next);
                      }}
                      aria-label={t('settings.providers.page.custom.reasoningEffort.levels')}
                      className="h-8 w-full appearance-none rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 pr-7 typography-ui-label text-foreground outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
                    >
                      {THINKING_LEVELS.map((level) => (
                        <option key={level} value={level}>
                          {t(levelTranslationKey(level))}
                        </option>
                      ))}
                    </select>
                    <Icon
                      name="arrow-down-s"
                      className="pointer-events-none absolute right-1.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                  </div>
                  <Input
                    autoFocus
                    value={customValue}
                    onChange={(event) => {
                      setCustomValue(event.target.value);
                      customDirtyRef.current = true;
                    }}
                    onBlur={() => {
                      commitCustomMapping();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitCustomMapping();
                        setCustomOpen(false);
                      }
                    }}
                    aria-label={t('settings.providers.page.custom.reasoningEffort.providerValue')}
                    placeholder={t('settings.providers.page.custom.reasoningEffort.customPlaceholder')}
                    className="h-8 min-w-0 font-mono text-xs"
                  />
                </div>
                <p className="px-0.5 typography-micro text-muted-foreground">
                  {t('settings.providers.page.custom.reasoningEffort.customDescription')}
                </p>
              </div>
            ) : (
              <button
                type="button"
                className="flex min-h-8 w-full items-center rounded-lg px-2 py-1.5 text-left typography-ui-label text-foreground outline-none transition-colors hover:bg-interactive-hover focus-visible:bg-interactive-hover"
                onClick={beginCustomMapping}
              >
                {t('settings.providers.page.custom.reasoningEffort.custom')}
              </button>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
