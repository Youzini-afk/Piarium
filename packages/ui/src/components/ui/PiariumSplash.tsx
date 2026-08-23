import React from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { splashCubeMarkup } from './piarium-splash-cube';
import {
  buildSplashCells,
  PIARIUM_SPLASH_COLORS,
  splashExitScale,
  splashWorkbenchCellDelays,
  splashPlaneCss,
  type PiariumSplashDirection,
  type PiariumSplashMode,
  type PiariumSplashPhase,
  type PiariumSplashTempo,
} from './piarium-splash-lattice';

/**
 * The Piarium splash: the mark standing on a floor that is its own footprint extended outward.
 *
 * One CSS camera owns both. The floor stays one flattened layer and the cube is the scene's only small
 * preserve-3d object, so the camera turn reprojects them together. A floor cell is exactly the cube's base
 * and the lines leaving its base corners are the floor's own lines; the cube stands in the space instead
 * of being a screen-space sticker in front of it.
 *
 * Two behaviours share the component. `boot` covers startup and comes apart outward from the cube's feet.
 * `switch` covers a Workbench Profile change and sweeps along one floor axis, reversing with the direction
 * the user moved, so a profile change reads as a re-layout rather than as a restart.
 */

const STYLES = splashPlaneCss(PIARIUM_SPLASH_COLORS, { withMark: true });

/**
 * Both built once at module load rather than per render.
 *
 * The floor's extent and the cube's geometry are fixed, and the colours are custom properties the browser
 * resolves itself, so nothing here can change while the splash is up. It runs during startup, when the
 * machine is at its busiest, which is the whole reason none of it is recomputed.
 */
const CUBE_MARKUP = splashCubeMarkup();
const SWEEP_CELLS = {
  forward: buildSplashCells('switch', 'forward', false),
  backward: buildSplashCells('switch', 'backward', false),
} as const;

export interface PiariumSplashProps {
  mode: PiariumSplashMode;
  /** Accessible name for the cover, since the mark inside it is decorative. */
  label: string;
  /** Already-translated status line. Omit to leave the line empty but keep its height reserved. */
  status?: string;
  direction?: PiariumSplashDirection;
  /** Flip to run the exit. Keep the component mounted for `SPLASH_EXIT_DURATION_MS` afterwards. */
  leaving?: boolean;
  /** Workbench-only mirrored phase. Boot keeps using `leaving` because its cover already exists pre-paint. */
  phase?: PiariumSplashPhase;
  tempo?: PiariumSplashTempo;
  onPhaseComplete?: () => void;
  className?: string;
}

export const PiariumSplash: React.FC<PiariumSplashProps> = ({
  mode,
  label,
  status,
  direction = 'forward',
  leaving = false,
  phase,
  tempo = 'standard',
  onPhaseComplete,
  className,
}) => {
  const reducedMotion = usePrefersReducedMotion();
  // Re-evaluate on the render that flips `leaving`: a slow startup may have been resized since mount, and
  // the flattened floor must contain the viewport that actually exists at handoff time.
  const exitScale = typeof window === 'undefined'
    ? splashExitScale(1920, 1080)
    : splashExitScale(window.innerWidth, window.innerHeight);

  // Which cells breathe is drawn once per mount. Re-picking on every render would make the idle state
  // shimmer randomly instead of pulsing steadily. The sweep has no random part, so it is a constant.
  const cells = React.useMemo(
    () => (mode === 'boot'
      ? buildSplashCells('boot', direction, !reducedMotion)
      : SWEEP_CELLS[direction]),
    [mode, direction, reducedMotion],
  );

  return (
    <div
      className={['pi-splash', className].filter(Boolean).join(' ')}
      data-leaving={leaving ? 'true' : 'false'}
      data-mode={mode}
      data-phase={phase}
      data-tempo={tempo}
      style={{ '--pi-floor-exit-scale': exitScale } as React.CSSProperties}
      role="status"
      aria-live="polite"
      aria-label={label}
      onAnimationEnd={(event) => {
        if (
          event.animationName === 'pi-splash-cover-clock'
          || event.animationName === 'pi-splash-reveal-clock'
        ) onPhaseComplete?.();
      }}
    >
      <style>{STYLES}</style>
      {/* The cover for everything the floor's cells cannot reach. A hole opens in it from the cube's feet
          during the exit, so where the cells are the cover, they are the only cover. */}
      <div className="pi-splash-backdrop" aria-hidden="true" />
      <div className="pi-splash-ground-clip" aria-hidden="true">
        <div className="pi-splash-horizon">
          <div className="pi-splash-camera">
            <div className="pi-splash-ground">
              {cells.map((cell) => {
                const standard = mode === 'switch'
                  ? splashWorkbenchCellDelays(cell.delayMs, 'standard')
                  : null;
                const quick = mode === 'switch'
                  ? splashWorkbenchCellDelays(cell.delayMs, 'quick')
                  : null;
                return (
                <span
                  key={cell.key}
                  className="pi-splash-cell"
                  data-breathe={cell.breatheDelayMs === null ? 'false' : 'true'}
                  style={{
                    '--pi-cell-delay': `${cell.delayMs}ms`,
                    '--pi-cell-scatter-x': `${cell.scatterXPx}px`,
                    '--pi-cell-scatter-y': `${cell.scatterYPx}px`,
                    ...(standard && quick ? {
                      '--pi-cell-cover-delay-standard': `${standard.coverDelayMs}ms`,
                      '--pi-cell-reveal-delay-standard': `${standard.revealDelayMs}ms`,
                      '--pi-cell-cover-delay-quick': `${quick.coverDelayMs}ms`,
                      '--pi-cell-reveal-delay-quick': `${quick.revealDelayMs}ms`,
                    } : {}),
                    ...(cell.breatheDelayMs === null
                      ? {}
                      : { '--pi-breathe-delay': `${cell.breatheDelayMs}ms` }),
                  } as React.CSSProperties}
                />
                );
              })}
            </div>
            {/* Generated from fixed Piarium geometry; no untrusted string reaches it. */}
            <span className="pi-splash-mark" dangerouslySetInnerHTML={{ __html: CUBE_MARKUP }} />
          </div>
        </div>
      </div>
      <span className="pi-splash-phase-clock" aria-hidden="true" />
      <div className="pi-splash-status">{status ?? ''}</div>
    </div>
  );
};
