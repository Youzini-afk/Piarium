let authoritativeSettingsDepth = 0;

export const isApplyingAuthoritativeSettings = (): boolean => authoritativeSettingsDepth > 0;

export const applyAuthoritativeSettings = <T>(apply: () => T): T => {
  authoritativeSettingsDepth += 1;
  try {
    return apply();
  } finally {
    authoritativeSettingsDepth -= 1;
  }
};
