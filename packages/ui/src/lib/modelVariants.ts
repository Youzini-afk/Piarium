export const REASONING_VARIANT_KEYS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

type VariantMap = Record<string, unknown>;

const REASONING_VARIANT_SET = new Set<string>(REASONING_VARIANT_KEYS);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const trimString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const normalizeEffort = (value: unknown): string => {
  const normalized = trimString(value).toLowerCase();
  return REASONING_VARIANT_SET.has(normalized) ? normalized : '';
};

const getModelVariants = (model: unknown): VariantMap | undefined => {
  if (!isRecord(model) || !isRecord(model.variants)) {
    return undefined;
  }
  return model.variants;
};

const hasReasoningCapability = (model: unknown): boolean => {
  if (!isRecord(model)) {
    return false;
  }

  if (model.reasoning === true) {
    return true;
  }

  if (isRecord(model.capabilities) && model.capabilities.reasoning === true) {
    return true;
  }

  if (isRecord(model.options) && normalizeEffort(model.options.reasoningEffort ?? model.options.reasoning_effort)) {
    return true;
  }

  const variants = getModelVariants(model);
  if (!variants) {
    return false;
  }

  return Object.entries(variants).some(([key, value]) => (
    normalizeEffort(key)
    || (isRecord(value) && normalizeEffort(value.reasoningEffort ?? value.reasoning_effort))
  ));
};

export const getModelVariantKeys = (model: unknown): string[] => {
  const variants = getModelVariants(model);
  const keys = variants ? Object.keys(variants).filter((key) => key.trim().length > 0) : [];

  if (!hasReasoningCapability(model)) {
    return keys;
  }

  const ordered = [...keys];
  for (const effort of REASONING_VARIANT_KEYS) {
    if (!ordered.includes(effort)) {
      ordered.push(effort);
    }
  }
  return ordered.sort((a, b) => {
    const aIndex = REASONING_VARIANT_KEYS.indexOf(a as typeof REASONING_VARIANT_KEYS[number]);
    const bIndex = REASONING_VARIANT_KEYS.indexOf(b as typeof REASONING_VARIANT_KEYS[number]);
    if (aIndex === -1 && bIndex === -1) {
      return keys.indexOf(a) - keys.indexOf(b);
    }
    if (aIndex === -1) {
      return 1;
    }
    if (bIndex === -1) {
      return -1;
    }
    return aIndex - bIndex;
  });
};

export const modelSupportsVariant = (model: unknown, variant: string | undefined): boolean => {
  if (!variant) {
    return true;
  }
  return getModelVariantKeys(model).includes(variant);
};
