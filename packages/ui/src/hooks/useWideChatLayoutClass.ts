import React from 'react';

const usePrePaintEffect: typeof React.useEffect =
  typeof React.useInsertionEffect === 'function'
    ? React.useInsertionEffect
    : React.useLayoutEffect;

export const useWideChatLayoutClass = (enabled: boolean) => {
  usePrePaintEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const root = document.documentElement;
    root.classList.toggle('wide-chat-layout', enabled);
    return () => {
      root.classList.remove('wide-chat-layout');
    };
  }, [enabled]);
};
