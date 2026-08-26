import React from 'react';
import {
  THINKING_LEVELS,
  type JsonValue,
  type PiSettingsSnapshot,
  type ThinkingLevel,
} from '@piarium/protocol';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { getPiSettings } from '@/lib/pi-runtime/settings';
import type { PiComposerModelSelection } from './piComposerSessionConfig';

export interface PiComposerDefaults {
  model?: PiComposerModelSelection;
  thinkingLevel?: ThinkingLevel;
}

const readString = (value: JsonValue | undefined): string | undefined => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
);

const isThinkingLevel = (value: string | undefined): value is ThinkingLevel => (
  value !== undefined && (THINKING_LEVELS as readonly string[]).includes(value)
);

export const resolvePiComposerDefaults = (
  snapshot: PiSettingsSnapshot | null,
  projectDefaultModel?: string,
): PiComposerDefaults => {
  const effectiveSettings = snapshot
    ? { ...snapshot.global, ...snapshot.project }
    : {};
  const settingsProvider = readString(effectiveSettings.defaultProvider);
  const settingsModel = readString(effectiveSettings.defaultModel);
  const projectModel = parseModelIdentifier(projectDefaultModel);
  const settingsThinking = readString(effectiveSettings.defaultThinkingLevel);

  const model = projectModel
    ? { id: projectModel.modelId, provider: projectModel.providerId }
    : settingsProvider && settingsModel
      ? { id: settingsModel, provider: settingsProvider }
      : undefined;

  return {
    ...(model ? { model } : {}),
    ...(isThinkingLevel(settingsThinking) ? { thinkingLevel: settingsThinking } : {}),
  };
};

export const usePiComposerDefaults = (
  cwd: string,
  projectDefaultModel?: string,
): PiComposerDefaults => {
  const [snapshot, setSnapshot] = React.useState<PiSettingsSnapshot | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    if (!cwd.trim()) return () => { cancelled = true; };
    void getPiSettings({ cwd })
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch(() => {
        // Session creation still resolves the runtime defaults. The composer
        // keeps working when settings inspection is temporarily unavailable.
      });
    return () => { cancelled = true; };
  }, [cwd]);

  return React.useMemo(
    () => resolvePiComposerDefaults(snapshot, projectDefaultModel),
    [projectDefaultModel, snapshot],
  );
};
