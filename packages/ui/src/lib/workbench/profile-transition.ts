/**
 * Shell-independent state machine for a Workbench Profile transition.
 *
 * The old shell owns the switcher and is destroyed during a successful switch, so neither component-local
 * state nor the shell host can own the animation. This store keeps one scene alive across both shells:
 * reverse playback covers the old shell, the candidate commits only while fully covered, and forward
 * playback reveals either the new shell or the still-authoritative old shell after a failure.
 */

export type WorkbenchProfileTransitionDirection = 'forward' | 'backward';
export type WorkbenchProfileTransitionPhase = 'idle' | 'covering' | 'covered' | 'revealing';
export type WorkbenchProfileTransitionTempo = 'quick' | 'standard';

export interface WorkbenchProfileTransitionState {
  readonly direction: WorkbenchProfileTransitionDirection;
  readonly fromProfileId: string | null;
  readonly id: number;
  readonly phase: WorkbenchProfileTransitionPhase;
  readonly tempo: WorkbenchProfileTransitionTempo;
  readonly toProfileId: string | null;
}

/**
 * A candidate prepared before the cover closed still counts as quick if its authoritative commit settles
 * within the previous transition's visible floor. This is not an operation timeout: slower candidates stay
 * safely covered and use the standard reveal rather than being cancelled.
 */
export const MIN_TRANSITION_VISIBLE_MS = 340;

/**
 * Backstop only for a missing animation-completion signal. It advances the visual phase; it never aborts a
 * candidate, rejects a valid slow switch, or forces the covered hold to end while work is still running.
 */
export const MAX_TRANSITION_VISIBLE_MS = 8000;

const IDLE: WorkbenchProfileTransitionState = {
  direction: 'forward',
  fromProfileId: null,
  id: 0,
  phase: 'idle',
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

const armPhaseFallback = (advance: () => void): void => {
  clearPhaseTimer();
  phaseTimer = setTimeout(advance, MAX_TRANSITION_VISIBLE_MS);
};

/**
 * Decide the visual direction from profile order. Unknown ordering falls forward instead of pretending to
 * know where an extension-defined profile belongs.
 */
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
  fromProfileId?: string | null;
  toProfileId: string;
  direction?: WorkbenchProfileTransitionDirection;
}): number => {
  clearPhaseTimer();
  // A newer user choice supersedes promises owned by a transition that can no longer become authoritative.
  resolveCoveredWaiters(false);
  resolveIdleWaiters();
  operationPreparedBeforeCover = false;
  coveredAt = 0;
  const id = nextTransitionId;
  nextTransitionId += 1;
  publish({
    direction: input.direction ?? 'forward',
    fromProfileId: input.fromProfileId ?? null,
    id,
    phase: 'covering',
    // Covering is always responsive. A slow candidate holds the completed cover and later reveals at the
    // standard tempo; a candidate already prepared behind it keeps the quick tempo in both directions.
    tempo: 'quick',
    toProfileId: input.toProfileId,
  });
  armPhaseFallback(() => markWorkbenchProfileTransitionCovered(id));
  return id;
};

/** Records that preparation reached the authoritative commit boundary. */
export const markWorkbenchProfileTransitionOperationPrepared = (id: number): void => {
  if (state.id === id && state.phase === 'covering') operationPreparedBeforeCover = true;
};

/** Called by the transition scene after reverse playback has made the cover fully opaque. */
export const markWorkbenchProfileTransitionCovered = (id: number): void => {
  if (state.id !== id || state.phase !== 'covering') return;
  clearPhaseTimer();
  coveredAt = Date.now();
  publish({
    ...state,
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

/**
 * Starts forward playback after commit or failure. A prepared candidate only keeps quick playback when the
 * covered commit also settled promptly; a genuine wait gets the standard reveal instead of a sudden rush.
 */
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
    && Date.now() - coveredAt <= MIN_TRANSITION_VISIBLE_MS;
  publish({ ...state, phase: 'revealing', tempo: quick ? 'quick' : 'standard' });
  armPhaseFallback(() => completeWorkbenchProfileTransition(id));
  return waitForWorkbenchProfileTransitionIdle();
};

/** Called by the scene after forward playback has fully exposed the authoritative shell. */
export const completeWorkbenchProfileTransition = (id: number): void => {
  if (state.id !== id || state.phase !== 'revealing') return;
  clearPhaseTimer();
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

/** Test seam: drop all state and timers so one case cannot leak into the next. */
export const resetWorkbenchProfileTransitionForTests = (): void => {
  clearPhaseTimer();
  resolveCoveredWaiters(false);
  resolveIdleWaiters();
  state = IDLE;
  nextTransitionId = 1;
  operationPreparedBeforeCover = false;
  coveredAt = 0;
  listeners.clear();
};
