import type {
  HarnessMemoryMode,
  HarnessMemoryRuntimeFailure,
  HarnessMemoryRuntimeState,
  PiSessionFeatureMutation,
} from '@piarium/protocol';
import { resolveHarnessMemoryMode } from '@piarium/protocol';

export const HARNESS_MEMORY_MODES = ['off', 'assist', 'takeover'] as const satisfies readonly HarnessMemoryMode[];
export const HARNESS_MEMORY_MODE_SELECTIONS = ['inherit', ...HARNESS_MEMORY_MODES] as const;

export type HarnessMemoryModeSelection = (typeof HARNESS_MEMORY_MODE_SELECTIONS)[number];

export interface HarnessMemoryModeResolution {
  error?: string;
  mode: HarnessMemoryMode | null;
}

export const resolveHarnessMemoryModeForUi = (value: unknown): HarnessMemoryModeResolution => {
  try {
    return { mode: resolveHarnessMemoryMode(value) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), mode: null };
  }
};

export const isHarnessMemoryModeSelection = (value: string): value is HarnessMemoryModeSelection => (
  (HARNESS_MEMORY_MODE_SELECTIONS as readonly string[]).includes(value)
);

export const createHarnessMemoryModeMutation = (
  mode: HarnessMemoryModeSelection,
): PiSessionFeatureMutation => ({ mode, type: 'memory.mode.set' });

/**
 * Update only the user-facing memory mode while retaining unknown settings.
 * The old shadowMode flag is removed because the core resolver owns legacy
 * migration and should not receive two competing sources of truth.
 */
export const withHarnessMemoryMode = <T extends { memory?: object | null }>(
  harness: T,
  mode: HarnessMemoryMode,
): T => {
  const existingMemory = harness.memory
    && typeof harness.memory === 'object'
    && !Array.isArray(harness.memory)
    ? harness.memory as Record<string, unknown>
    : {};
  const memory = { ...existingMemory, mode };
  delete (memory as Record<string, unknown>).shadowMode;
  return { ...harness, memory } as T;
};

export interface HarnessMemoryPresentation {
  configuredMode: HarnessMemoryMode;
  effectiveMode: HarnessMemoryMode;
  failure?: HarnessMemoryRuntimeFailure;
  overrideMode?: HarnessMemoryMode;
}

export const projectHarnessMemoryPresentation = (
  memory: HarnessMemoryRuntimeState | undefined,
  featureOverride?: HarnessMemoryMode,
): HarnessMemoryPresentation | null => {
  if (!memory) return null;
  return {
    configuredMode: memory.configuredMode,
    effectiveMode: memory.effectiveMode,
    ...(memory.lastFailure === undefined ? {} : { failure: memory.lastFailure }),
    ...((memory.overrideMode ?? featureOverride) === undefined
      ? {}
      : { overrideMode: memory.overrideMode ?? featureOverride }),
  };
};
