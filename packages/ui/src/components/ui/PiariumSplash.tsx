import React from 'react';
import { PiariumLogo } from '@/components/ui/PiariumLogo';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import {
  buildSplashCells,
  groundInlineStyle,
  resolveGroundShape,
  resolveMarkSize,
  splashPlaneCss,
  type PiariumSplashDirection,
  type PiariumSplashMode,
} from './piarium-splash-lattice';

/**
 * The Piarium splash: the mark standing on a lattice that is its own footprint extended outward.
 *
 * The lattice shares the cube's base axes, its cell edge equals the cube's base edge, and one of its
 * vertices sits on the cube's lowest vertex. So the cube's footprint is one cell of the floor and the
 * lines leaving its base corners are the floor's own lines, which is what makes it stand in the space
 * rather than sit in front of it.
 *
 * Two behaviours share the component. `boot` covers startup and comes apart outward from the mark's
 * feet. `switch` covers a Workbench Profile change and sweeps along one base axis, reversing with the
 * direction the user moved, so a profile change reads as a re-layout rather than as a restart.
 */

/** Piarium's own splash palette, hydrated pre-paint from the persisted theme. */
const PIARIUM_SPLASH_COLORS = {
  background: 'var(--splash-background, var(--color-background, #151313))',
  line: 'var(--splash-lattice-line, rgba(255, 255, 255, 0.22))',
  cell: 'var(--splash-cell-fill, rgba(255, 255, 255, 0.35))',
  contact: 'var(--splash-contact, rgba(255, 255, 255, 0.1))',
  status: 'var(--splash-stroke)',
} as const;

const STYLES = splashPlaneCss(PIARIUM_SPLASH_COLORS, { withMark: true });

const useViewport = (): { width: number; height: number } => {
  const [viewport, setViewport] = React.useState(() => ({
    width: typeof window === 'undefined' ? 1280 : window.innerWidth,
    height: typeof window === 'undefined' ? 800 : window.innerHeight,
  }));

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const apply = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, []);

  return viewport;
};

export interface PiariumSplashProps {
  mode: PiariumSplashMode;
  /** Accessible name for the cover, since the mark inside it is decorative. */
  label: string;
  /** Already-translated status line. Omit to leave the line empty but keep its height reserved. */
  status?: string;
  direction?: PiariumSplashDirection;
  /** Flip to run the exit. Keep the component mounted for `SPLASH_EXIT_DURATION_MS` afterwards. */
  leaving?: boolean;
  className?: string;
}

export const PiariumSplash: React.FC<PiariumSplashProps> = ({
  mode,
  label,
  status,
  direction = 'forward',
  leaving = false,
  className,
}) => {
  const reducedMotion = usePrefersReducedMotion();
  const { width, height } = useViewport();
  const markSize = resolveMarkSize(width);
  const shape = React.useMemo(
    () => resolveGroundShape(width, height, markSize),
    [width, height, markSize],
  );

  // Breathing cells are chosen once per ground shape. Re-picking them on every render would make the
  // idle state shimmer randomly instead of pulsing steadily.
  const cells = React.useMemo(
    () => buildSplashCells(shape, mode, direction, mode === 'boot' && !reducedMotion),
    [shape, mode, direction, reducedMotion],
  );

  return (
    <div
      className={['pi-splash', className].filter(Boolean).join(' ')}
      data-leaving={leaving ? 'true' : 'false'}
      data-mode={mode}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <style>{STYLES}</style>
      <div className="pi-splash-ground" aria-hidden="true" style={groundInlineStyle(shape)}>
        {cells.map((cell) => (
          <span
            key={cell.key}
            className="pi-splash-cell"
            data-breathe={cell.breatheDelayMs === null ? 'false' : 'true'}
            style={{
              '--pi-cell-delay': `${cell.delayMs}ms`,
              ...(cell.breatheDelayMs === null
                ? {}
                : { '--pi-breathe-delay': `${cell.breatheDelayMs}ms` }),
            } as React.CSSProperties}
          />
        ))}
      </div>

      <span className="pi-splash-mark">
        <PiariumLogo width={markSize} height={markSize} isAnimated={!reducedMotion} decorative />
      </span>
      <div className="pi-splash-status">{status ?? ''}</div>
    </div>
  );
};
