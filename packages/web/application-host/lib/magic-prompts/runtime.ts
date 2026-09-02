const FILE_VERSION = 1;
const MAX_PROMPT_TEXT_LENGTH = 200_000;
const PROMPT_ID_PATTERN = /^[a-z0-9._-]{1,160}$/;
const isVisiblePromptID = (id: unknown): id is string => typeof id === 'string' && id.endsWith('.visible');

const hasOwn = (input: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(input, key);

const sanitizeOverrides = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const next: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!PROMPT_ID_PATTERN.test(key) || typeof entry !== 'string') {
      continue;
    }
    next[key] = entry;
  }
  return next;
};

export interface MagicPromptState {
  overrides: Record<string, string>;
  version: number;
}

export interface MagicPromptRuntimeDependencies {
  filePath: string;
  fsPromises: Pick<typeof import('node:fs/promises'), 'mkdir' | 'readFile' | 'writeFile'>;
  path: Pick<typeof import('node:path'), 'dirname'>;
}

export const createMagicPromptRuntime = (dependencies: MagicPromptRuntimeDependencies) => {
  const {
    fsPromises,
    path,
    filePath,
  } = dependencies;

  let writeLock: Promise<unknown> = Promise.resolve();

  const readPromptState = async (): Promise<MagicPromptState> => {
    try {
      const raw = await fsPromises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const overrides = sanitizeOverrides(
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as { overrides?: unknown }).overrides
          : undefined,
      );
      return {
        version: FILE_VERSION,
        overrides,
      };
    } catch (error) {
      if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') {
        return { version: FILE_VERSION, overrides: {} };
      }
      console.warn('Failed to read magic prompts file:', error);
      return { version: FILE_VERSION, overrides: {} };
    }
  };

  const writePromptState = async (state: MagicPromptState): Promise<void> => {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8');
  };

  const persist = (
    mutator: (state: MagicPromptState) => Promise<MagicPromptState> | MagicPromptState,
  ): Promise<MagicPromptState> => {
    const run = async () => {
      const current = await readPromptState();
      const next = await mutator(current);
      await writePromptState(next);
      return next;
    };
    const result = writeLock.then(run, run);
    writeLock = result;
    return result;
  };

  const setOverride = async (id: unknown, text: unknown): Promise<MagicPromptState> => {
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    if (!PROMPT_ID_PATTERN.test(normalizedId)) {
      throw new Error('Invalid prompt id');
    }
    if (typeof text !== 'string') {
      throw new Error('Prompt text must be a string');
    }
    if (isVisiblePromptID(normalizedId) && text.trim().length === 0) {
      throw new Error('Visible prompt text cannot be empty');
    }
    if (text.length > MAX_PROMPT_TEXT_LENGTH) {
      throw new Error('Prompt text is too long');
    }

    return persist(async (state) => {
      const nextOverrides = { ...state.overrides, [normalizedId]: text };
      return {
        version: FILE_VERSION,
        overrides: nextOverrides,
      };
    });
  };

  const resetOverride = async (id: unknown): Promise<MagicPromptState> => {
    const normalizedId = typeof id === 'string' ? id.trim() : '';
    if (!PROMPT_ID_PATTERN.test(normalizedId)) {
      throw new Error('Invalid prompt id');
    }

    return persist(async (state) => {
      if (!hasOwn(state.overrides, normalizedId)) {
        return state;
      }
      const nextOverrides = { ...state.overrides };
      delete nextOverrides[normalizedId];
      return {
        version: FILE_VERSION,
        overrides: nextOverrides,
      };
    });
  };

  const resetAllOverrides = async (): Promise<MagicPromptState> => {
    return persist(async () => ({ version: FILE_VERSION, overrides: {} }));
  };

  return {
    readPromptState,
    setOverride,
    resetOverride,
    resetAllOverrides,
  };
};
