import React from 'react';
import { PiariumLogo } from '@/components/ui/PiariumLogo';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { LOGO_COS30, LOGO_SIN30 } from './piarium-logo-geometry';
import {
  CELL_EXIT_MS,
  MARK_EXIT_MS,
  SPLASH_REDUCED_EXIT_DURATION_MS,
  buildSplashCells,
  resolveLatticeShape,
  type PiariumSplashDirection,
  type PiariumSplashMode,
} from './piarium-splash-lattice';

/**
 * The Piarium splash: an isometric lattice with the mark sitting in it.
 *
 * The mark's two visible faces are already a 4x4 lattice of parallelograms, so the splash tiles that
 * same lattice across the viewport instead of placing a logo on an unrelated background. The cube
 * then reads as the region of the lattice that is filled rather than as a separate object.
 *
 * A flat CSS grid carries the isometric projection through one transform, the same matrix the mark
 * uses for its top face, which keeps the cells' shape and phase consistent with the mark without any
 * per-cell trigonometry.
 *
 * Two behaviours share the component. `boot` covers startup and retreats outward from the mark.
 * `switch` covers a Workbench Profile change and sweeps along a single lattice axis, reversing with
 * the direction the user moved, so a profile change reads as a re-layout rather than as a restart.
 */

const STYLES = `
.pi-splash {
  position: fixed;
  inset: 0;
  z-index: 9998;
  overflow: hidden;
  background: var(--splash-background, var(--color-background, #151313));
}
.pi-splash[data-leaving='true'] { pointer-events: none; }

.pi-splash-lattice {
  position: absolute;
  left: 50%;
  top: 50%;
  display: grid;
  transform-origin: center;
}
/* Only two edges per cell, so neighbours do not stack into a 2px rule. */
.pi-splash-cell {
  box-shadow: inset -1px -1px 0 var(--splash-lattice-line, var(--splash-face-fill, rgba(255, 255, 255, 0.12)));
}
/* Idle breathing starts late on purpose: a fast start never reaches it, so it only ever appears
   when there is genuinely something to wait for. */
.pi-splash-cell[data-breathe='true'] {
  animation: pi-splash-breathe 2.6s ease-in-out infinite;
  animation-delay: calc(1.2s + var(--pi-breathe-delay));
}
@keyframes pi-splash-breathe {
  0%, 100% { background: transparent; }
  50% { background: var(--splash-cell-fill); }
}
/* Declared after the breathing rule so equal specificity lets the exit win without !important. */
.pi-splash[data-leaving='true'] .pi-splash-cell {
  animation: pi-splash-cell-out ${CELL_EXIT_MS}ms cubic-bezier(0.4, 0, 0.3, 1) both;
  animation-delay: var(--pi-cell-delay);
}
@keyframes pi-splash-cell-out {
  to { opacity: 0; transform: scale(0.82); }
}

.pi-splash-center {
  position: absolute;
  left: 50%;
  top: 50%;
  translate: -50% -50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  padding: 0 24px;
  text-align: center;
}
.pi-splash[data-leaving='true'] .pi-splash-center {
  animation: pi-splash-mark-out ${MARK_EXIT_MS}ms 60ms cubic-bezier(0.4, 0, 0.3, 1) both;
}
@keyframes pi-splash-mark-out {
  to { opacity: 0; transform: scale(1.06); }
}

.pi-splash-status {
  min-height: 1rem;
  max-width: 32ch;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  color: var(--splash-stroke);
  opacity: 0;
  animation: pi-splash-status-in 480ms 700ms ease both;
}
@keyframes pi-splash-status-in { to { opacity: 0.55; } }

@media (prefers-reduced-motion: reduce) {
  .pi-splash-cell,
  .pi-splash[data-leaving='true'] .pi-splash-cell,
  .pi-splash[data-leaving='true'] .pi-splash-center {
    animation: none;
  }
  .pi-splash-status { animation: none; opacity: 0.55; }
  /* Still shows the cover. Hiding it would put the unpainted first frame back. */
  .pi-splash { transition: opacity ${SPLASH_REDUCED_EXIT_DURATION_MS}ms ease; }
  .pi-splash[data-leaving='true'] { opacity: 0; }
}
`;

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
  const shape = React.useMemo(() => resolveLatticeShape(width, height), [width, height]);

  // Breathing cells are chosen once per lattice shape. Re-picking them on every render would make
  // the idle state shimmer randomly instead of pulsing steadily.
  const cells = React.useMemo(
    () => buildSplashCells(shape, mode, direction, mode === 'boot' && !reducedMotion),
    [shape, mode, direction, reducedMotion],
  );

  const markSize = width >= 768 ? 132 : 104;

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
      <div
        className="pi-splash-lattice"
        aria-hidden="true"
        style={{
          gridTemplateColumns: `repeat(${shape.cols}, ${shape.cellPx}px)`,
          gridTemplateRows: `repeat(${shape.rows}, ${shape.cellPx}px)`,
          transform: `translate(-50%, -50%) matrix(${LOGO_COS30}, ${LOGO_SIN30}, ${-LOGO_COS30}, ${LOGO_SIN30}, 0, 0)`,
        }}
      >
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

      <div className="pi-splash-center">
        <PiariumLogo width={markSize} height={markSize} isAnimated={!reducedMotion} decorative />
        <div className="pi-splash-status">{status ?? ''}</div>
      </div>
    </div>
  );
};
