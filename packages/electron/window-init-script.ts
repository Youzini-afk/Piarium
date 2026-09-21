export interface WindowInitScriptTarget {
  __varinInitScript?: string | null | undefined;
  isDestroyed?(): boolean;
}

export const updateWindowInitScript = (
  browserWindow: WindowInitScriptTarget | null | undefined,
  initScript: unknown,
): boolean => {
  if (!browserWindow || typeof initScript !== 'string' || initScript.length === 0) {
    return false;
  }

  if (typeof browserWindow.isDestroyed === 'function' && browserWindow.isDestroyed()) {
    return false;
  }

  browserWindow.__varinInitScript = initScript;
  return true;
};
