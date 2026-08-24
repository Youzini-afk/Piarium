import React from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { splashCubeMarkup } from './piarium-splash-cube';
import {
  buildSplashTileClusters,
  PIARIUM_SPLASH_STYLE_ELEMENT_ID,
  PIARIUM_SPLASH_COLORS,
  splashExitScale,
  splashWorkbenchClusterDelays,
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

const usePiariumSplashStyles = (): void => {
  React.useInsertionEffect(() => {
    if (typeof document === 'undefined' || document.getElementById(PIARIUM_SPLASH_STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = PIARIUM_SPLASH_STYLE_ELEMENT_ID;
    style.textContent = STYLES;
    document.head.append(style);
  }, []);
};

/**
 * Both built once at module load rather than per render.
 *
 * The floor's extent and the cube's geometry are fixed, and the colours are custom properties the browser
 * resolves itself, so nothing here can change while the splash is up. It runs during startup, when the
 * machine is at its busiest, which is the whole reason none of it is recomputed.
 */
const CUBE_MARKUP = splashCubeMarkup();
const SWEEP_CLUSTERS = {
  forward: buildSplashTileClusters('switch', 'forward', false),
  backward: buildSplashTileClusters('switch', 'backward', false),
} as const;

export interface PiariumSplashProps {
  mode: PiariumSplashMode;
  /** Accessible name for the cover, since the mark inside it is decorative. */
  label: string;
  /** The outer Transition Scene host owns announcements for switch mode. Boot announces itself. */
  announce?: boolean;
  /** Already-translated status line. Omit to leave the line empty but keep its height reserved. */
  status?: string;
  direction?: PiariumSplashDirection;
  /** Flip to run the exit. Keep the component mounted for `SPLASH_EXIT_DURATION_MS` afterwards. */
  leaving?: boolean;
  /** Workbench-only mirrored phase. Boot keeps using `leaving` because its cover already exists pre-paint. */
  phase?: PiariumSplashPhase;
  tempo?: PiariumSplashTempo;
  /** Captured transition preference. Boot omits it and follows the live media query. */
  reducedMotion?: boolean;
  onPhaseComplete?: () => void;
  className?: string;
}

export const PiariumSplash: React.FC<PiariumSplashProps> = ({
  mode,
  label,
  announce = true,
  status,
  direction = 'forward',
  leaving = false,
  phase,
  tempo = 'standard',
  reducedMotion: reducedMotionOverride,
  onPhaseComplete,
  className,
}) => {
  usePiariumSplashStyles();
  const systemReducedMotion = usePrefersReducedMotion();
  const reducedMotion = reducedMotionOverride ?? systemReducedMotion;
  // Re-evaluate on the render that flips `leaving`: a slow startup may have been resized since mount, and
  // the flattened floor must contain the viewport that actually exists at handoff time.
  const exitScale = typeof window === 'undefined'
    ? splashExitScale(1920, 1080)
    : splashExitScale(window.innerWidth, window.innerHeight);

  // Which clusters breathe is drawn once per mount. Re-picking on every render would make the idle state
  // shimmer randomly instead of pulsing steadily. The sweep has no random part, so it is a constant.
  const clusters = React.useMemo(
    () => (mode === 'boot'
      ? buildSplashTileClusters('boot', direction, !reducedMotion)
      : SWEEP_CLUSTERS[direction]),
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
      role={announce ? 'status' : undefined}
      aria-live={announce ? 'polite' : undefined}
      aria-label={announce ? label : undefined}
      aria-hidden={announce ? undefined : true}
      onAnimationEnd={(event) => {
        if (
          event.animationName === 'pi-splash-cover-clock'
          || event.animationName === 'pi-splash-reveal-clock'
        ) onPhaseComplete?.();
      }}
    >
      {/* The cover for everything the floor's cells cannot reach. A hole opens in it from the cube's feet
          during the exit, so where the cells are the cover, they are the only cover. */}
      <div className="pi-splash-backdrop" aria-hidden="true" />
      <div className="pi-splash-ground-clip" aria-hidden="true">
        <div className="pi-splash-horizon">
          <div className="pi-splash-camera">
            <div className="pi-splash-ground">
              {clusters.map((cluster) => {
                const standard = mode === 'switch'
                  ? splashWorkbenchClusterDelays(cluster.delayMs, 'standard')
                  : null;
                const quick = mode === 'switch'
                  ? splashWorkbenchClusterDelays(cluster.delayMs, 'quick')
                  : null;
                return (
                <span
                  key={cluster.key}
                  className="pi-splash-tile-cluster"
                  data-breathe={cluster.breatheDelayMs === null ? 'false' : 'true'}
                  style={{
                    '--pi-cluster-delay': `${cluster.delayMs}ms`,
                    '--pi-cluster-scatter-x': `${cluster.scatterXPx}px`,
                    '--pi-cluster-scatter-y': `${cluster.scatterYPx}px`,
                    ...(standard && quick ? {
                      '--pi-cluster-cover-delay-standard': `${standard.coverDelayMs}ms`,
                      '--pi-cluster-reveal-delay-standard': `${standard.revealDelayMs}ms`,
                      '--pi-cluster-cover-delay-quick': `${quick.coverDelayMs}ms`,
                      '--pi-cluster-reveal-delay-quick': `${quick.revealDelayMs}ms`,
                    } : {}),
                    ...(cluster.breatheDelayMs === null
                      ? {}
                      : { '--pi-breathe-delay': `${cluster.breatheDelayMs}ms` }),
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
