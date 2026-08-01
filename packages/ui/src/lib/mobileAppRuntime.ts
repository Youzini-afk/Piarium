import React from 'react';

export const isMobileAppRuntime = (): boolean => {
  if (typeof window === 'undefined') return false;
  return Boolean((window as unknown as { __OPENCHAMBER_MOBILE_APP__?: unknown }).__OPENCHAMBER_MOBILE_APP__);
};

export const useMobileAppViewport = (enabled: boolean): void => {
  React.useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      return;
    }

    const root = document.documentElement;
    let rafId: number | null = null;
    root.classList.add('runtime-mobile-app');
    root.style.setProperty('--oc-safe-area-top', 'env(safe-area-inset-top, 0px)');
    root.style.setProperty('--oc-safe-area-right', 'env(safe-area-inset-right, 0px)');
    root.style.setProperty('--oc-safe-area-bottom', 'env(safe-area-inset-bottom, 0px)');
    root.style.setProperty('--oc-safe-area-left', 'env(safe-area-inset-left, 0px)');

    const updateViewportVars = () => {
      const viewport = window.visualViewport;
      const keyboardHeight = viewport
        ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
        : 0;
      const nextKeyboardHeight = `${Math.round(keyboardHeight)}px`;
      const nextViewportHeight = `${Math.round(viewport?.height ?? window.innerHeight)}px`;

      if (root.style.getPropertyValue('--oc-mobile-keyboard-height') !== nextKeyboardHeight) {
        root.style.setProperty('--oc-mobile-keyboard-height', nextKeyboardHeight);
      }
      if (root.style.getPropertyValue('--oc-mobile-viewport-height') !== nextViewportHeight) {
        root.style.setProperty('--oc-mobile-viewport-height', nextViewportHeight);
      }
    };

    const scheduleViewportVarsUpdate = () => {
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        updateViewportVars();
      });
    };

    updateViewportVars();
    window.visualViewport?.addEventListener('resize', scheduleViewportVarsUpdate);
    window.visualViewport?.addEventListener('scroll', scheduleViewportVarsUpdate);
    window.addEventListener('resize', scheduleViewportVarsUpdate);

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      window.visualViewport?.removeEventListener('resize', scheduleViewportVarsUpdate);
      window.visualViewport?.removeEventListener('scroll', scheduleViewportVarsUpdate);
      window.removeEventListener('resize', scheduleViewportVarsUpdate);
      root.classList.remove('runtime-mobile-app');
      root.style.removeProperty('--oc-mobile-keyboard-height');
      root.style.removeProperty('--oc-mobile-viewport-height');
      root.style.removeProperty('--oc-safe-area-top');
      root.style.removeProperty('--oc-safe-area-right');
      root.style.removeProperty('--oc-safe-area-bottom');
      root.style.removeProperty('--oc-safe-area-left');
    };
  }, [enabled]);
};
