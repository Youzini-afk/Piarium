import type { PiSessionEntry } from '@piarium/protocol';
import {
  parseExtensionStatus,
  type ExtensionStatusPresentation,
} from '@/components/pi-session/extensionPresentation';
import type { MagicContextDreamerTask } from './magic-context-config-model';

export type MagicContextRuntimeActionId =
  | 'status'
  | 'flush'
  | 'embedding-status'
  | 'embedding-start'
  | 'embedding-pause'
  | 'augment'
  | 'wrapup'
  | 'recomp'
  | 'session-upgrade'
  | 'dream';

export interface MagicContextRuntimeCommandOptions {
  dreamTask?: MagicContextDreamerTask;
  messagesToKeep?: number;
  prompt?: string;
  recompRange?: { end: number; start: number };
}

interface MagicContextRuntimeCommand {
  command: string;
}

interface LatestMagicContextStatus {
  entryId: string;
  status: ExtensionStatusPresentation;
  timestamp: string;
}

export const buildMagicContextRuntimeCommand = (
  action: MagicContextRuntimeActionId,
  options: MagicContextRuntimeCommandOptions = {},
): MagicContextRuntimeCommand => {
  switch (action) {
    case 'status':
      return { command: 'ctx-status' };
    case 'flush':
      return { command: 'ctx-flush' };
    case 'embedding-status':
      return { command: 'ctx-embed' };
    case 'embedding-start':
      return { command: 'ctx-embed start' };
    case 'embedding-pause':
      return { command: 'ctx-embed pause' };
    case 'augment': {
      const prompt = options.prompt?.trim() ?? '';
      if (!prompt) throw new Error('prompt must not be empty');
      return { command: `ctx-aug ${prompt}` };
    }
    case 'wrapup': {
      const messagesToKeep = options.messagesToKeep ?? 20;
      if (!Number.isSafeInteger(messagesToKeep) || messagesToKeep <= 0) {
        throw new Error('messagesToKeep must be a positive safe integer');
      }
      return { command: `ctx-wrapup ${messagesToKeep}` };
    }
    case 'recomp': {
      const range = options.recompRange;
      if (range) {
        if (
          !Number.isSafeInteger(range.start)
          || !Number.isSafeInteger(range.end)
          || range.start < 1
          || range.end < range.start
        ) {
          throw new Error('recompRange must use safe integers with end greater than or equal to start');
        }
        return { command: `ctx-recomp ${range.start}-${range.end}` };
      }
      // Current Magic Context deliberately requires the exact command twice
      // within 60 seconds. Piarium invokes it once per user action and renders
      // the provider's public confirmation entry instead of guessing whether a
      // previous invocation already armed the confirmation window.
      return { command: 'ctx-recomp' };
    }
    case 'session-upgrade':
      return { command: 'ctx-session-upgrade' };
    case 'dream':
      return {
        command: options.dreamTask ? `ctx-dream ${options.dreamTask}` : 'ctx-dream',
      };
  }
};

export const latestMagicContextStatus = (
  entries: readonly PiSessionEntry[] | undefined,
): LatestMagicContextStatus | null => {
  if (!entries) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'custom' || entry.customType !== 'ctx-status') continue;
    const status = parseExtensionStatus(entry.customType, entry.data);
    if (!status) continue;
    return { entryId: entry.id, status, timestamp: entry.timestamp };
  }
  return null;
};
