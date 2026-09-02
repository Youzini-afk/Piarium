type ThemeRecord = Record<string, unknown>;

export interface NormalizedTheme extends ThemeRecord {
  metadata: ThemeRecord & {
    description: string;
    id: string;
    name: string;
    tags: string[];
    variant: 'dark' | 'light';
    version: string;
  };
}

export interface ThemeRuntimeDependencies {
  fsPromises: Pick<typeof import('node:fs/promises'), 'readFile' | 'readdir' | 'stat'>;
  logger: { warn(...values: unknown[]): void };
  maxThemeJsonBytes: number;
  path: Pick<typeof import('node:path'), 'join'>;
  themesDir: string;
}

const isRecord = (value: unknown): value is ThemeRecord => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

export const createThemeRuntime = (dependencies: ThemeRuntimeDependencies) => {
  const {
    fsPromises,
    path,
    themesDir,
    maxThemeJsonBytes,
    logger,
  } = dependencies;

  const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const isValidThemeColor = (value: unknown): value is string => isNonEmptyString(value);

  const normalizeThemeJson = (raw: unknown): NormalizedTheme | null => {
    if (!isRecord(raw)) {
      return null;
    }

    const metadata = isRecord(raw.metadata) ? raw.metadata : null;
    const colors = isRecord(raw.colors) ? raw.colors : null;
    if (!metadata || !colors) {
      return null;
    }

    const id = metadata.id;
    const name = metadata.name;
    const variant = metadata.variant;
    if (!isNonEmptyString(id) || !isNonEmptyString(name) || (variant !== 'light' && variant !== 'dark')) {
      return null;
    }

    const primary = colors.primary;
    const surface = colors.surface;
    const interactive = colors.interactive;
    const status = colors.status;
    const syntax = colors.syntax;
    const syntaxRecord = isRecord(syntax) ? syntax : null;
    const syntaxBase = syntaxRecord && isRecord(syntaxRecord.base) ? syntaxRecord.base : null;
    const syntaxHighlights = syntaxRecord && isRecord(syntaxRecord.highlights) ? syntaxRecord.highlights : null;

    if (!isRecord(primary) || !isRecord(surface) || !isRecord(interactive)
      || !isRecord(status) || !syntaxBase || !syntaxHighlights) {
      return null;
    }

    // Minimal fields required by CSSVariableGenerator and diff/syntax rendering.
    const required = [
      primary.base,
      primary.foreground,
      surface.background,
      surface.foreground,
      surface.muted,
      surface.mutedForeground,
      surface.elevated,
      surface.elevatedForeground,
      surface.subtle,
      interactive.border,
      interactive.selection,
      interactive.selectionForeground,
      interactive.focusRing,
      interactive.hover,
      status.error,
      status.errorForeground,
      status.errorBackground,
      status.errorBorder,
      status.warning,
      status.warningForeground,
      status.warningBackground,
      status.warningBorder,
      status.success,
      status.successForeground,
      status.successBackground,
      status.successBorder,
      status.info,
      status.infoForeground,
      status.infoBackground,
      status.infoBorder,
      syntaxBase.background,
      syntaxBase.foreground,
      syntaxBase.keyword,
      syntaxBase.string,
      syntaxBase.number,
      syntaxBase.function,
      syntaxBase.variable,
      syntaxBase.type,
      syntaxBase.comment,
      syntaxBase.operator,
      syntaxHighlights.diffAdded,
      syntaxHighlights.diffRemoved,
      syntaxHighlights.lineNumber,
    ];

    if (!required.every(isValidThemeColor)) {
      return null;
    }

    const tags = Array.isArray(metadata.tags)
      ? metadata.tags.filter((tag) => typeof tag === 'string' && tag.trim().length > 0)
      : [];

    return {
      ...raw,
      metadata: {
        ...metadata,
        id: id.trim(),
        name: name.trim(),
        description: typeof metadata.description === 'string' ? metadata.description : '',
        version: typeof metadata.version === 'string' && metadata.version.trim().length > 0 ? metadata.version : '1.0.0',
        variant,
        tags,
      },
    };
  };

  const readCustomThemesFromDisk = async (): Promise<NormalizedTheme[]> => {
    try {
      const entries = await fsPromises.readdir(themesDir, { withFileTypes: true });
      const themes: NormalizedTheme[] = [];
      const seen = new Set<string>();

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.toLowerCase().endsWith('.json')) continue;

        const filePath = path.join(themesDir, entry.name);
        try {
          const stat = await fsPromises.stat(filePath);
          if (!stat.isFile()) continue;
          if (stat.size > maxThemeJsonBytes) {
            logger.warn(`[themes] Skip ${entry.name}: too large (${stat.size} bytes)`);
            continue;
          }

          const rawText = await fsPromises.readFile(filePath, 'utf8');
          const parsed = JSON.parse(rawText) as unknown;
          const normalized = normalizeThemeJson(parsed);
          if (!normalized) {
            logger.warn(`[themes] Skip ${entry.name}: invalid theme JSON`);
            continue;
          }

          const id = normalized.metadata.id;
          if (seen.has(id)) {
            logger.warn(`[themes] Skip ${entry.name}: duplicate theme id "${id}"`);
            continue;
          }

          seen.add(id);
          themes.push(normalized);
        } catch (error) {
          logger.warn(`[themes] Failed to read ${entry.name}:`, error);
        }
      }

      return themes;
    } catch (error) {
      // Missing dir is fine.
      if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT') {
        return [];
      }
      logger.warn('[themes] Failed to list custom themes dir:', error);
      return [];
    }
  };

  return {
    normalizeThemeJson,
    readCustomThemesFromDisk,
  };
};
