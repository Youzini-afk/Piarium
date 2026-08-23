/**
 * Shell-independent state machine for a Workbench Profile transition.
 *
 * A Transition Scene owns pixels and timing. Core owns candidate readiness and the authoritative
 * Profile commit: reverse playback covers the old shell, commit happens only while covered, and
 * forward playback reveals either the new shell or the still-authoritative old shell after failure.
 */

import {
  PIARIUM_TRANSITION_SCENE_CONTRACT_VERSION,
  PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE,
  piariumTransitionSceneDuration,
  type PiariumTransitionSceneAnimatedPhase,
  type PiariumTransitionSceneFrameV1,
} from '@piarium/extension-contract';
import type { WorkbenchTransitionSceneCapture } from '@/lib/extensions/workbench-transition-scene';

export type WorkbenchProfileTransitionDirection = 'forward' | 'backward';
export type WorkbenchProfileTransitionPhase = 'idle' | 'covering' | 'covered' | 'revealing';
export type WorkbenchProfileTransitionTempo = 'quick' | 'standard';

export interface WorkbenchProfileTransitionState {
  readonly direction: WorkbenchProfileTransitionDirection;
  readonly durationMs: number;
  readonly fromProfileId: string | null;
  readonly id: number;
  readonly phase: WorkbenchProfileTransitionPhase;
  readonly reducedMotion: boolean;
  readonly scene: WorkbenchTransitionSceneCapture | null;
  readonly tempo: WorkbenchProfileTransitionTempo;
  readonly toProfileId: string | null;
}

export interface WorkbenchTransitionSceneController {
  complete(transitionId: number, phase: PiariumTransitionSceneAnimatedPhase): void;
  getSnapshot(): PiariumTransitionSceneFrameV1;
  subscribe(listener: () => void): () => void;
}

/**
 * A candidate prepared before the cover closed still counts as quick if its authoritative commit
 * settles within this already-established visible grace. It is not an operation timeout: slower
 * candidates stay safely covered and use the scene's standard reveal duration.
 */
export const QUICK_TRANSITION_COMMIT_GRACE_MS = 340;

const IDLE: WorkbenchProfileTransitionState = {
  direction: 'forward',
  durationMs: 0,
  fromProfileId: null,
  id: 0,
  phase: 'idle',
  reducedMotion: false,
  scene: null,
  tempo: 'standard',
  toProfileId: null,
};

type Listener = (state: WorkbenchProfileTransitionState) => void;
type CoveredWaiter = (covered: boolean) => void;

const listeners = new Set<Listener>();
const coveredWaiters = new Set<CoveredWaiter>();
const idleWaiters = new Set<() => void>();
let state: WorkbenchProfileTransitionState = IDLE;
let nextTransitionId = 1;
let phaseTimer: ReturnType<typeof setTimeout> | null = null;
let phaseArmed = false;
let operationPreparedBeforeCover = false;
let coveredAt = 0;

const clearPhaseTimer = (): void => {
  if (phaseTimer === null) return;
  clearTimeout(phaseTimer);
  phaseTimer = null;
};

const publish = (next: WorkbenchProfileTransitionState): void => {
  state = next;
  listeners.forEach((listener) => listener(state));
};

const resolveCoveredWaiters = (covered: boolean): void => {
  for (const resolve of coveredWaiters) resolve(covered);
  coveredWaiters.clear();
};

const resolveIdleWaiters = (): void => {
  for (const resolve of idleWaiters) resolve();
  idleWaiters.clear();
};

const armPhaseCompletion = (durationMs: number, advance: () => void): void => {
  clearPhaseTimer();
  phaseTimer = setTimeout(advance, durationMs);
};

const phaseDuration = (
  scene: WorkbenchTransitionSceneCapture | null,
  phase: PiariumTransitionSceneAnimatedPhase,
  tempo: WorkbenchProfileTransitionTempo,
  reducedMotion: boolean,
): number => scene
  ? piariumTransitionSceneDuration(scene.data, {
      phase,
      reducedMotion,
      scene: PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE,
      tempo,
    })
  : 0;

/** Unknown profile ordering falls forward instead of pretending to know extension-defined layout. */
export const resolveTransitionDirection = (
  profileIds: readonly string[],
  fromProfileId: string | null,
  toProfileId: string,
): WorkbenchProfileTransitionDirection => {
  if (!fromProfileId) return 'forward';
  const from = profileIds.indexOf(fromProfileId);
  const to = profileIds.indexOf(toProfileId);
  if (from < 0 || to < 0) return 'forward';
  return to >= from ? 'forward' : 'backward';
};

export const beginWorkbenchProfileTransition = (input: {
  direction?: WorkbenchProfileTransitionDirection;
  fromProfileId?: string | null;
  reducedMotion?: boolean;
  scene?: WorkbenchTransitionSceneCapture | null;
  toProfileId: string;
}): number => {
  clearPhaseTimer();
  // A newer user choice supersedes promises owned by a transition that can no longer become authoritative.
  resolveCoveredWaiters(false);
  resolveIdleWaiters();
  operationPreparedBeforeCover = false;
  phaseArmed = false;
  coveredAt = 0;
  const id = nextTransitionId;
  nextTransitionId += 1;
  const scene = input.scene ?? null;
  const reducedMotion = input.reducedMotion ?? false;
  const durationMs = phaseDuration(scene, 'covering', 'quick', reducedMotion);
  publish({
    direction: input.direction ?? 'forward',
    durationMs,
    fromProfileId: input.fromProfileId ?? null,
    id,
    phase: 'covering',
    reducedMotion,
    scene,
    tempo: 'quick',
    toProfileId: input.toProfileId,
  });
  return id;
};

/**
 * Starts the selected scene's declared-duration clock only after its mounted pixels have committed.
 * This prevents an async mount or a busy main thread from consuming the cover budget before a scene
 * was visible. Repeated readiness signals for the same phase are no-ops.
 */
export const armWorkbenchProfileTransitionPhase = (
  id: number,
  phase: PiariumTransitionSceneAnimatedPhase,
): void => {
  if (state.id !== id || state.phase !== phase || phaseArmed) return;
  phaseArmed = true;
  armPhaseCompletion(state.durationMs, () => {
    if (phase === 'covering') markWorkbenchProfileTransitionCovered(id);
    else completeWorkbenchProfileTransition(id);
  });
};

/** Records that candidate preparation reached the authoritative commit boundary. */
export const markWorkbenchProfileTransitionOperationPrepared = (id: number): void => {
  if (state.id === id && state.phase === 'covering') operationPreparedBeforeCover = true;
};

/** Called by the scene (or its declared-duration clock) after the cover is fully opaque. */
export const markWorkbenchProfileTransitionCovered = (id: number): void => {
  if (state.id !== id || state.phase !== 'covering' || !phaseArmed) return;
  clearPhaseTimer();
  phaseArmed = false;
  coveredAt = Date.now();
  publish({
    ...state,
    durationMs: 0,
    phase: 'covered',
    tempo: operationPreparedBeforeCover ? 'quick' : 'standard',
  });
  resolveCoveredWaiters(true);
};

export const waitForWorkbenchProfileTransitionCovered = (id: number): Promise<boolean> => {
  if (state.id !== id) return Promise.resolve(false);
  if (state.phase === 'covered' || state.phase === 'revealing') return Promise.resolve(true);
  if (state.phase === 'idle') return Promise.resolve(false);
  return new Promise((resolve) => {
    coveredWaiters.add(resolve);
  });
};

const waitForWorkbenchProfileTransitionIdle = (): Promise<void> => {
  if (state.phase === 'idle') return Promise.resolve();
  return new Promise((resolve) => {
    idleWaiters.add(resolve);
  });
};

/** Starts forward playback after commit or failure and waits for the selected scene to finish. */
export const revealWorkbenchProfileTransition = async (id: number): Promise<void> => {
  if (state.id !== id || state.phase === 'idle') return;
  if (state.phase === 'covering') {
    const covered = await waitForWorkbenchProfileTransitionCovered(id);
    if (!covered) return;
  }
  if (state.id !== id) return;
  if (state.phase === 'revealing') return waitForWorkbenchProfileTransitionIdle();
  if (state.phase !== 'covered') return;

  const quick = operationPreparedBeforeCover
    && coveredAt > 0
    && Date.now() - coveredAt <= QUICK_TRANSITION_COMMIT_GRACE_MS;
  const tempo = quick ? 'quick' : 'standard';
  const durationMs = phaseDuration(state.scene, 'revealing', tempo, state.reducedMotion);
  phaseArmed = false;
  publish({ ...state, durationMs, phase: 'revealing', tempo });
  return waitForWorkbenchProfileTransitionIdle();
};

/** Called by the scene (or its declared-duration clock) after the authoritative shell is exposed. */
export const completeWorkbenchProfileTransition = (id: number): void => {
  if (state.id !== id || state.phase !== 'revealing' || !phaseArmed) return;
  clearPhaseTimer();
  phaseArmed = false;
  publish(IDLE);
  operationPreparedBeforeCover = false;
  coveredAt = 0;
  resolveIdleWaiters();
};

export const subscribeWorkbenchProfileTransition = (listener: Listener): (() => void) => {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
};

export const getWorkbenchProfileTransitionSnapshot = (): WorkbenchProfileTransitionState => state;

const frameFrom = (current: WorkbenchProfileTransitionState): PiariumTransitionSceneFrameV1 => {
  if (current.phase === 'idle' || !current.toProfileId) {
    throw new Error('Cannot create a Transition Scene frame for an idle transition');
  }
  return {
    contractVersion: PIARIUM_TRANSITION_SCENE_CONTRACT_VERSION,
    direction: current.direction,
    fromProfileId: current.fromProfileId,
    phase: current.phase,
    reducedMotion: current.reducedMotion,
    scene: PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE,
    tempo: current.tempo,
    toProfileId: current.toProfileId,
    transitionId: current.id,
  };
};

/**
 * One stable controller is mounted for the complete transaction. It keeps the last valid frame while
 * React unmounts after idle, and validates both transition ID and phase on completion.
 */
export const createWorkbenchTransitionSceneController = (
  id: number,
): WorkbenchTransitionSceneController => {
  if (state.id !== id || state.phase === 'idle') {
    throw new Error(`Workbench transition ${id} is not active`);
  }
  let observedState = state;
  let frame = frameFrom(state);
  const readFrame = (): PiariumTransitionSceneFrameV1 => {
    if (state.id === id && state.phase !== 'idle' && state !== observedState) {
      observedState = state;
      frame = frameFrom(state);
    }
    return frame;
  };
  return {
    complete: (transitionId, phase) => {
      if (transitionId !== id) return;
      if (phase === 'covering') markWorkbenchProfileTransitionCovered(id);
      else completeWorkbenchProfileTransition(id);
    },
    getSnapshot: readFrame,
    subscribe: (listener) => subscribeWorkbenchProfileTransition((next) => {
      if (next.id !== id || next.phase === 'idle') return;
      observedState = next;
      frame = frameFrom(next);
      listener();
    }),
  };
};

/** Test seam: drop all state and timers so one case cannot leak into the next. */
export const resetWorkbenchProfileTransitionForTests = (): void => {
  clearPhaseTimer();
  resolveCoveredWaiters(false);
  resolveIdleWaiters();
  state = IDLE;
  nextTransitionId = 1;
  operationPreparedBeforeCover = false;
  phaseArmed = false;
  coveredAt = 0;
  listeners.clear();
};
