export const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === "object" && !Array.isArray(value)
);

export const assertClosed = (
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void => {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown key ${key}`);
  }
};

export const requireNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

export const requireBoolean = (value: unknown, label: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
};

export const requireNonNegativeInteger = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
};

export const requirePositiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
};
