import picomatch from "picomatch";

export interface CompiledGlobFilter {
  /** Positive rules first and negative rules last, matching ripgrep filters. */
  rgPatterns: string[];
  matches(resourceId: string): boolean;
}

const normalizePathSyntax = (value: string): string => value.replace(/\\/g, "/").replace(/^\.\//, "");

const normalizeGlobRule = (glob: string): string => {
  const normalized = normalizePathSyntax(glob.trim());
  return normalized === "." ? "" : normalized;
};

const globOptions = { dot: true, nocase: process.platform === "win32" } as const;

/** Compile the shared Host glob semantics used by search and path overlays. */
export const compileGlobFilter = (globs: readonly string[] | undefined): CompiledGlobFilter | null => {
  const patterns = (globs ?? []).map(normalizeGlobRule).filter(Boolean);
  const positive = patterns.filter((glob) => !glob.startsWith("!"));
  const negative = patterns.filter((glob) => glob.startsWith("!") && glob.length > 1);
  try {
    const positiveMatchers = positive.map((glob) => picomatch(glob, {
      ...globOptions,
      basename: !glob.includes("/"),
    }));
    const negativeMatchers = negative.map((glob) => {
      const pattern = glob.slice(1);
      return picomatch(pattern, {
        ...globOptions,
        basename: !pattern.includes("/"),
      });
    });
    return {
      rgPatterns: [...positive, ...negative],
      matches: (resourceId) => (
        (positiveMatchers.length === 0 || positiveMatchers.some((matcher) => matcher(resourceId)))
        && !negativeMatchers.some((matcher) => matcher(resourceId))
      ),
    };
  } catch {
    return null;
  }
};

/** Compile one native find pattern against a path relative to its search root. */
export const compileFindGlob = (pattern: string): ((path: string) => boolean) | null => {
  // Native find patterns may intentionally contain leading or trailing spaces.
  // Normalize separators without changing those literal characters.
  const normalized = normalizePathSyntax(pattern);
  if (!normalized) return null;
  try {
    const matcher = picomatch(normalized, {
      ...globOptions,
      basename: !normalized.includes("/"),
    });
    return (path) => matcher(path.replace(/\\/g, "/"));
  } catch {
    return null;
  }
};

export const normalizeGlobPath = normalizePathSyntax;
