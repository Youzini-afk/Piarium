export const updateWindowInitScript = (browserWindow, initScript) => {
  if (!browserWindow || typeof initScript !== 'string' || initScript.length === 0) {
    return false;
  }

  if (typeof browserWindow.isDestroyed === 'function' && browserWindow.isDestroyed()) {
    return false;
  }

  browserWindow.__piariumInitScript = initScript;
  return true;
};
