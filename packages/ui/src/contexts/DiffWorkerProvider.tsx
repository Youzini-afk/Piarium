import React, { useEffect, useSyncExternalStore } from 'react';
import type { SupportedLanguages } from '@pierre/diffs';
import type { WorkerPoolManager } from '@pierre/diffs/worker';

import { useOptionalThemeSystem } from './useThemeSystem';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { Theme } from '@/types/theme';

const PRELOAD_LANGS: SupportedLanguages[] = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'json',
  'markdown',
];

interface DiffWorkerProviderProps {
  children: React.ReactNode;
}

type WorkerPoolStyle = 'unified' | 'split';

const WORKER_POOL_CONFIG: Record<WorkerPoolStyle, { poolSize: number; totalASTLRUCacheSize: number; lineDiffType: 'none' | 'word-alt' }> = {
  unified: {
    poolSize: 1,
    totalASTLRUCacheSize: 24,
    lineDiffType: 'none',
  },
  split: {
    poolSize: 2,
    totalASTLRUCacheSize: 56,
    lineDiffType: 'word-alt',
  },
};

type PoolModules = {
  WorkerPoolManager: typeof WorkerPoolManager;
  workerFactory: () => Worker;
  ensurePierreThemeRegistered: (theme: Theme) => void;
};

let poolModulesPromise: Promise<PoolModules> | null = null;

const loadPoolModules = (): Promise<PoolModules> => {
  poolModulesPromise ??= Promise.all([
    import('@pierre/diffs/worker'),
    import('@/lib/diff/workerFactory'),
    import('@/lib/shiki/appThemeRegistry'),
  ]).then(([workerModule, factoryModule, themeRegistryModule]) => ({
    WorkerPoolManager: workerModule.WorkerPoolManager,
    workerFactory: factoryModule.workerFactory,
    ensurePierreThemeRegistered: themeRegistryModule.ensurePierreThemeRegistered,
  })).catch((error) => {
    poolModulesPromise = null;
    throw error;
  });
  return poolModulesPromise;
};

const pools: Partial<Record<WorkerPoolStyle, WorkerPoolManager>> = {};
const poolsRequested = new Set<WorkerPoolStyle>();
const poolListeners = new Set<() => void>();

let currentLightTheme: Theme = getDefaultTheme(false);
let currentDarkTheme: Theme = getDefaultTheme(true);
let currentRenderTheme = {
  light: currentLightTheme.metadata.id,
  dark: currentDarkTheme.metadata.id,
};

const notifyPoolListeners = () => {
  for (const listener of poolListeners) listener();
};

const applyRenderOptions = (style: WorkerPoolStyle, pool: WorkerPoolManager) => {
  void pool.setRenderOptions({
    theme: currentRenderTheme,
    lineDiffType: WORKER_POOL_CONFIG[style].lineDiffType,
  });
};

const ensurePool = (style: WorkerPoolStyle): void => {
  if (typeof window === 'undefined' || poolsRequested.has(style)) return;
  poolsRequested.add(style);

  void loadPoolModules()
    .then((modules) => {
      modules.ensurePierreThemeRegistered(currentLightTheme);
      modules.ensurePierreThemeRegistered(currentDarkTheme);
      if (pools[style]) return;

      const config = WORKER_POOL_CONFIG[style];
      const pool = new modules.WorkerPoolManager(
        {
          workerFactory: modules.workerFactory,
          poolSize: config.poolSize,
          totalASTLRUCacheSize: config.totalASTLRUCacheSize,
        },
        {
          theme: currentRenderTheme,
          langs: PRELOAD_LANGS,
          lineDiffType: config.lineDiffType,
          preferredHighlighter: 'shiki-wasm',
        },
      );
      void pool.initialize();
      pools[style] = pool;
      applyRenderOptions(style, pool);
      notifyPoolListeners();
    })
    .catch(() => {
      // A later mount may retry a transient chunk-load failure.
      poolsRequested.delete(style);
    });
};

const subscribeToPools = (listener: () => void): (() => void) => {
  poolListeners.add(listener);
  return () => poolListeners.delete(listener);
};

const setActiveThemes = (lightTheme: Theme, darkTheme: Theme): void => {
  currentLightTheme = lightTheme;
  currentDarkTheme = darkTheme;
  currentRenderTheme = {
    light: lightTheme.metadata.id,
    dark: darkTheme.metadata.id,
  };

  // If a diff has already loaded the deferred modules, update registrations
  // and live pools. Merely changing the app theme does not load the diff stack.
  if (!poolModulesPromise) return;
  void poolModulesPromise.then((modules) => {
    modules.ensurePierreThemeRegistered(lightTheme);
    modules.ensurePierreThemeRegistered(darkTheme);
    for (const style of Object.keys(pools) as WorkerPoolStyle[]) {
      const pool = pools[style];
      if (pool) applyRenderOptions(style, pool);
    }
  });
};

export const DiffWorkerProvider: React.FC<DiffWorkerProviderProps> = ({ children }) => {
  const themeSystem = useOptionalThemeSystem();
  const fallbackLight = getDefaultTheme(false);
  const fallbackDark = getDefaultTheme(true);

  const lightThemeId = themeSystem?.lightThemeId ?? fallbackLight.metadata.id;
  const darkThemeId = themeSystem?.darkThemeId ?? fallbackDark.metadata.id;
  const lightTheme = themeSystem?.availableThemes.find((theme) => theme.metadata.id === lightThemeId) ?? fallbackLight;
  const darkTheme = themeSystem?.availableThemes.find((theme) => theme.metadata.id === darkThemeId) ?? fallbackDark;

  useEffect(() => {
    setActiveThemes(lightTheme, darkTheme);
  }, [darkTheme, lightTheme]);

  return <>{children}</>;
};

// eslint-disable-next-line react-refresh/only-export-components
export const useWorkerPool = (style: WorkerPoolStyle = 'unified'): WorkerPoolManager | undefined => {
  const pool = useSyncExternalStore(
    subscribeToPools,
    () => pools[style],
    () => undefined,
  );
  useEffect(() => ensurePool(style), [style]);
  return pool;
};
