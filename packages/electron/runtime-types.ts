export const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

export const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);
