import React from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import {
  createSplashCanvasMountOptions,
  mountSplashTileCanvas,
  resolveSplashCanvasPlayback,
  type SplashCanvasController,
} from './varin-splash-canvas';
import { splashCubeMarkup } from './varin-splash-cube';
import {
  VARIN_SPLASH_STYLE_ELEMENT_ID,
  VARIN_SPLASH_COLORS,
  splashPlaneCss,
  type VarinSplashDirection,
  type VarinSplashMode,
  type VarinSplashPhase,
  type VarinSplashTempo,
} from './varin-splash-lattice';

/**
 * The Varin splash: the mark standing on a floor that is its own footprint extended outward.
 *
 * One frame clock owns both. The Canvas projects the floor and writes the identical camera tilt into the
 * cube's small preserve-3d camera before paint, so a dropped or delayed frame freezes/catches up as one
 * scene instead of letting either half run ahead. A floor cell is exactly the cube's base and the lines
 * leaving its base corners are the floor's own lines; the cube stands in the space instead of being a
 * screen-space sticker in front of it.
 *
 * Two behaviours share the component. `boot` covers startup and comes apart outward from the cube's feet.
 * `switch` covers a Workbench Profile change concentrically: the perimeter closes toward the registered
 * footprint, the cube appears, and revealing plays that same scene in exact reverse.
 */

const STYLES = splashPlaneCss(VARIN_SPLASH_COLORS, { withMark: true });

const useVarinSplashStyles = (): void => {
  React.useInsertionEffect(() => {
    if (typeof document === 'undefined' || document.getElementById(VARIN_SPLASH_STYLE_ELEMENT_ID)) return;
    const style = document.createElement('style');
    style.id = VARIN_SPLASH_STYLE_ELEMENT_ID;
    style.textContent = STYLES;
    document.head.append(style);
  }, []);
};

/** Cube geometry is fixed and generated once rather than per scene mount. */
const CUBE_MARKUP = splashCubeMarkup();

export interface VarinSplashProps {
  mode: VarinSplashMode;
  /** Accessible name for the cover, since the mark inside it is decorative. */
  label: string;
  /** The outer Transition Scene host owns announcements for switch mode. Boot announces itself. */
  announce?: boolean;
  /** Already-translated status line. Omit to leave the line empty but keep its height reserved. */
  status?: string;
  direction?: VarinSplashDirection;
  /** Flip to run the exit. Keep the component mounted for `SPLASH_EXIT_DURATION_MS` afterwards. */
  leaving?: boolean;
  /** Workbench-only mirrored phase. Boot keeps using `leaving` because its cover already exists pre-paint. */
  phase?: VarinSplashPhase;
  tempo?: VarinSplashTempo;
  /** Captured transition preference. Boot omits it and follows the live media query. */
  reducedMotion?: boolean;
  onPhaseComplete?: () => void;
  className?: string;
}

export const VarinSplash: React.FC<VarinSplashProps> = ({
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
  useVarinSplashStyles();
  const systemReducedMotion = usePrefersReducedMotion();
  const reducedMotion = reducedMotionOverride ?? systemReducedMotion;
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const controllerRef = React.useRef<SplashCanvasController | null>(null);
  const playback = React.useMemo(() => resolveSplashCanvasPlayback({
    leaving,
    mode,
    phase,
    reducedMotion,
    tempo,
  }), [leaving, mode, phase, reducedMotion, tempo]);
  const playbackRef = React.useRef(playback);
  playbackRef.current = playback;

  React.useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = mountSplashTileCanvas(canvas, createSplashCanvasMountOptions({
      breathe: mode === 'boot' && !reducedMotion,
      direction,
      mode,
      playback: playbackRef.current,
    }));
    controllerRef.current = controller;
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null;
      controller.dispose();
    };
  }, [direction, mode, reducedMotion]);

  React.useLayoutEffect(() => {
    controllerRef.current?.setPlayback(playback);
  }, [playback]);

  return (
    <div
      className={['varin-splash', className].filter(Boolean).join(' ')}
      data-leaving={leaving ? 'true' : 'false'}
      data-mode={mode}
      data-phase={phase}
      data-tempo={tempo}
      role={announce ? 'status' : undefined}
      aria-live={announce ? 'polite' : undefined}
      aria-label={announce ? label : undefined}
      aria-hidden={announce ? undefined : true}
      onAnimationEnd={(event) => {
        if (
          event.animationName === 'varin-splash-cover-clock'
          || event.animationName === 'varin-splash-reveal-clock'
        ) onPhaseComplete?.();
      }}
    >
      {/* The cover for everything the floor's cells cannot reach. A hole opens in it from the cube's feet
          during the exit, so where the cells are the cover, they are the only cover. */}
      <div className="varin-splash-backdrop" aria-hidden="true" />
      <div className="varin-splash-ground-clip" aria-hidden="true">
        <div className="varin-splash-horizon">
          <canvas ref={canvasRef} className="varin-splash-ground-canvas" aria-hidden="true" />
          <div className="varin-splash-camera">
            <div className="varin-splash-ground" />
            {/* Generated from fixed Varin geometry; no untrusted string reaches it. */}
            <span className="varin-splash-mark" dangerouslySetInnerHTML={{ __html: CUBE_MARKUP }} />
          </div>
        </div>
      </div>
      <span className="varin-splash-phase-clock" aria-hidden="true" />
      <div className="varin-splash-status">{status ?? ''}</div>
    </div>
  );
};
