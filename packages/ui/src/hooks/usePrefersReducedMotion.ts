import React from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Read the reduced-motion preference outside React.
 *
 * Returns `false` when there is no `matchMedia`, because a server or test environment cannot know
 * the preference and animating is the documented default.
 */
const prefersReducedMotion = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(QUERY).matches;
};

/**
 * Subscribe to the reduced-motion preference.
 *
 * CSS `@media (prefers-reduced-motion: reduce)` covers anything expressible as a stylesheet rule.
 * This hook is for the cases CSS cannot reach: choosing not to mount an animated subtree, or
 * skipping a timed sequence entirely rather than running it with its animations disabled.
 */
export const usePrefersReducedMotion = (): boolean => {
  const [reduced, setReduced] = React.useState(prefersReducedMotion);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(QUERY);
    const apply = () => setReduced(media.matches);
    apply();
    // Safari below 14 exposes only the deprecated listener API.
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
    media.addListener(apply);
    return () => media.removeListener(apply);
  }, []);

  return reduced;
};
