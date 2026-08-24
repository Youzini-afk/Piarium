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

export interface WorkbenchTransitionPaintHandoff {
  dispose(): void;
  hold(): void;
  retireSceneAfterPaint(onRetired: () => void): void;
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
  let retirementFirstFrame: number | null = null;
  let retirementSecondFrame: number | null = null;
  let retirementFallbackTask: number | null = null;
  let generation = 0;
  let owned = false;

  const cancelPendingRelease = (): void => {
    generation += 1;
    if (firstFrame !== null) scheduler.cancelFrame(firstFrame);
    if (secondFrame !== null) scheduler.cancelFrame(secondFrame);
    if (fallbackTask !== null) scheduler.cancelTask(fallbackTask);
    if (retirementFirstFrame !== null) scheduler.cancelFrame(retirementFirstFrame);
    if (retirementSecondFrame !== null) scheduler.cancelFrame(retirementSecondFrame);
    if (retirementFallbackTask !== null) scheduler.cancelTask(retirementFallbackTask);
    firstFrame = null;
    secondFrame = null;
    fallbackTask = null;
    retirementFirstFrame = null;
    retirementSecondFrame = null;
    retirementFallbackTask = null;
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

  return {
    hold: () => {
      cancelPendingRelease();
      owned = true;
      root.setAttribute(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE, 'true');
    },
    retireSceneAfterPaint: (onRetired) => {
      if (
        !owned
        || retirementFirstFrame !== null
        || retirementSecondFrame !== null
        || retirementFallbackTask !== null
      ) return;
      const capturedGeneration = generation;
      const retire = () => {
        if (!owned || generation !== capturedGeneration) return;
        retirementFirstFrame = null;
        retirementSecondFrame = null;
        retirementFallbackTask = null;
        onRetired();
      };
      retirementFirstFrame = scheduler.requestFrame(() => {
        retirementFirstFrame = null;
        if (generation !== capturedGeneration) return;
        retirementSecondFrame = scheduler.requestFrame(retire);
        if (retirementSecondFrame === null) {
          retirementFallbackTask = scheduler.scheduleTask(retire);
        }
      });
      if (retirementFirstFrame === null) {
        retirementFallbackTask = scheduler.scheduleTask(retire);
      }
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
