/**
 * Keeps the browser canvas on the Transition Scene palette while the scene compositor is detached.
 *
 * The scene itself owns every visible transition pixel. Core owns only this paint handoff: after the
 * revealing phase ends, the root background remains stable for one committed Shell frame so Chromium
 * cannot expose its light default between compositor owners.
 */

export const WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE = 'data-piarium-workbench-handoff';

interface PaintHandoffRoot {
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  setAttribute(name: string, value: string): void;
}

interface PaintHandoffScheduler {
  cancelFrame(frame: number): void;
  cancelTask(task: number): void;
  requestFrame(callback: () => void): number | null;
  scheduleTask(callback: () => void): number;
}

interface WorkbenchTransitionSceneAnimation {
  cancel(): void;
  readonly finished: Promise<unknown>;
}

interface WorkbenchTransitionSceneLayer {
  animate?: (
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions,
  ) => WorkbenchTransitionSceneAnimation;
  readonly style: Pick<CSSStyleDeclaration, 'opacity'>;
}

export const WORKBENCH_TRANSITION_RETIRE_FADE_MS = 96;

export interface WorkbenchTransitionPaintHandoff {
  dispose(): void;
  hold(): void;
  retireScene(
    scene: WorkbenchTransitionSceneLayer,
    options: { reducedMotion: boolean },
    onRetired: () => void,
  ): void;
  releaseAfterPaint(): void;
}

const liveScheduler = (): PaintHandoffScheduler => ({
  cancelFrame: (frame) => window.cancelAnimationFrame(frame),
  cancelTask: (task) => window.clearTimeout(task),
  requestFrame: (callback) => typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame(callback)
    : null,
  scheduleTask: (callback) => window.setTimeout(callback, 0),
});

export const createWorkbenchTransitionPaintHandoff = (
  root: PaintHandoffRoot,
  scheduler: PaintHandoffScheduler = liveScheduler(),
): WorkbenchTransitionPaintHandoff => {
  let firstFrame: number | null = null;
  let secondFrame: number | null = null;
  let fallbackTask: number | null = null;
  let retirementFallbackTask: number | null = null;
  let retirementAnimation: WorkbenchTransitionSceneAnimation | null = null;
  let retirementScene: WorkbenchTransitionSceneLayer | null = null;
  let retirementSceneOpacity = '';
  let generation = 0;
  let owned = false;

  const cancelPendingRelease = (): void => {
    generation += 1;
    if (firstFrame !== null) scheduler.cancelFrame(firstFrame);
    if (secondFrame !== null) scheduler.cancelFrame(secondFrame);
    if (fallbackTask !== null) scheduler.cancelTask(fallbackTask);
    if (retirementFallbackTask !== null) scheduler.cancelTask(retirementFallbackTask);
    retirementAnimation?.cancel();
    if (retirementScene && retirementFallbackTask !== null) {
      retirementScene.style.opacity = retirementSceneOpacity;
    }
    firstFrame = null;
    secondFrame = null;
    fallbackTask = null;
    retirementFallbackTask = null;
    retirementAnimation = null;
    retirementScene = null;
    retirementSceneOpacity = '';
  };

  const release = (capturedGeneration: number): void => {
    if (!owned || generation !== capturedGeneration) return;
    if (root.getAttribute(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE) === 'true') {
      root.removeAttribute(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE);
    }
    owned = false;
    firstFrame = null;
    secondFrame = null;
    fallbackTask = null;
  };

  const takeOwnership = (): void => {
    cancelPendingRelease();
    owned = true;
    root.setAttribute(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE, 'true');
  };

  return {
    hold: takeOwnership,
    retireScene: (scene, options, onRetired) => {
      // The scene's own terminal frame should already be transparent. The Core-owned wrapper still fades
      // as a compositor guard: if a browser retained one stale Canvas/Logo frame, that frame reaches zero
      // opacity before React is allowed to run any child cleanup. This is a visual animation with a native
      // completion signal, not a guessed delay standing in for a paint acknowledgement.
      if (!owned) takeOwnership();
      if (
        retirementAnimation !== null
        || retirementFallbackTask !== null
      ) return;
      const capturedGeneration = generation;
      const retire = (animation: WorkbenchTransitionSceneAnimation | null) => {
        if (!owned || generation !== capturedGeneration) return;
        if (animation && retirementAnimation !== animation) return;
        retirementAnimation = null;
        retirementFallbackTask = null;
        retirementScene = null;
        retirementSceneOpacity = '';
        onRetired();
      };

      if (typeof scene.animate === 'function') {
        try {
          const animation = scene.animate(
            [{ opacity: 1 }, { opacity: 0 }],
            {
              duration: options.reducedMotion ? 0 : WORKBENCH_TRANSITION_RETIRE_FADE_MS,
              easing: 'linear',
              fill: 'forwards',
            },
          );
          retirementAnimation = animation;
          void animation.finished.then(
            () => retire(animation),
            () => undefined,
          );
          return;
        } catch {
          // Older embedders without a usable Web Animations implementation use the hidden-layer fallback.
        }
      }

      retirementScene = scene;
      retirementSceneOpacity = scene.style.opacity;
      scene.style.opacity = '0';
      retirementFallbackTask = scheduler.scheduleTask(() => retire(null));
    },
    releaseAfterPaint: () => {
      if (!owned || firstFrame !== null || secondFrame !== null || fallbackTask !== null) return;
      const capturedGeneration = generation;
      firstFrame = scheduler.requestFrame(() => {
        firstFrame = null;
        if (generation !== capturedGeneration) return;
        secondFrame = scheduler.requestFrame(() => release(capturedGeneration));
        if (secondFrame === null) {
          fallbackTask = scheduler.scheduleTask(() => release(capturedGeneration));
        }
      });
      if (firstFrame === null) {
        fallbackTask = scheduler.scheduleTask(() => release(capturedGeneration));
      }
    },
    dispose: () => {
      cancelPendingRelease();
      if (owned && root.getAttribute(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE) === 'true') {
        root.removeAttribute(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE);
      }
      owned = false;
    },
  };
};
