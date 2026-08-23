/**
 * Publishes the state of a Workbench Profile switch so a shell-independent overlay can cover it.
 *
 * The state cannot live in `WorkbenchProfileSwitcher`: that component is rendered inside the shell
 * being replaced, so its local state is destroyed at the swap and its `finally` never reaches the
 * overlay. It also cannot live in the shell host, because the host is what re-renders. A module
 * store is the only place that survives the whole transition.
 *
 * A profile switch has no measurable progress. What it has is a start, an end, and a boolean
 * outcome, so this exposes exactly that and no invented percentage. What it does add is a floor on
 * how long the cover stays up: a builtin-to-builtin switch can settle in well under a frame, and an
 * overlay that appears and vanishes reads as a glitch rather than as a transition.
 */

export type WorkbenchProfileTransitionDirection = 'forward' | 'backward';

export interface WorkbenchProfileTransitionState {
  readonly isSwitching: boolean;
  /** Drives the sweep direction so the animation matches which way the user moved. */
  readonly direction: WorkbenchProfileTransitionDirection;
  readonly fromProfileId: string | null;
  readonly toProfileId: string | null;
}

/**
 * Long enough for the sweep to read as deliberate. Below roughly a third of a second a cover looks
 * like a flicker; much above it and a fast switch feels padded.
 */
export const MIN_TRANSITION_VISIBLE_MS = 340;

/**
 * A stuck transition must not hold the workbench behind a cover forever. The underlying switch
 * either resolves or rejects, so this is a backstop for a caller that never settles at all.
 */
export const MAX_TRANSITION_VISIBLE_MS = 8000;

const IDLE: WorkbenchProfileTransitionState = {
  isSwitching: false,
  direction: 'forward',
  fromProfileId: null,
  toProfileId: null,
};

type Listener = (state: WorkbenchProfileTransitionState) => void;
type CoverWaiter = (covered: boolean) => void;

const listeners = new Set<Listener>();
const coverWaiters = new Set<CoverWaiter>();
const idleWaiters = new Set<() => void>();
let state: WorkbenchProfileTransitionState = IDLE;
let startedAt = 0;
let coverReady = false;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let maxTimer: ReturnType<typeof setTimeout> | null = null;

const clearTimers = (): void => {
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (maxTimer !== null) {
    clearTimeout(maxTimer);
    maxTimer = null;
  }
};

const publish = (next: WorkbenchProfileTransitionState): void => {
  state = next;
  listeners.forEach((listener) => listener(state));
};

const resolveCoverWaiters = (covered: boolean): void => {
  for (const resolve of coverWaiters) resolve(covered);
  coverWaiters.clear();
};

const resolveIdleWaiters = (): void => {
  for (const resolve of idleWaiters) resolve();
  idleWaiters.clear();
};

const settle = (): void => {
  clearTimers();
  if (!state.isSwitching) return;
  resolveCoverWaiters(false);
  coverReady = false;
  startedAt = 0;
  publish(IDLE);
  resolveIdleWaiters();
};

/**
 * Decide the sweep direction from the profile order, so switching back reverses the animation.
 * Unknown ordering falls back to `forward` rather than guessing.
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
}): void => {
  clearTimers();
  // A new transaction supersedes a cover wait left by a caller that never completed.
  resolveCoverWaiters(false);
  resolveIdleWaiters();
  coverReady = false;
  startedAt = Date.now();
  publish({
    isSwitching: true,
    direction: input.direction ?? 'forward',
    fromProfileId: input.fromProfileId ?? null,
    toProfileId: input.toProfileId,
  });
  maxTimer = setTimeout(settle, MAX_TRANSITION_VISIBLE_MS);
};

/**
 * Called by the application-level overlay after the browser has painted it once.
 *
 * Starting the shell mutation before this acknowledgement lets a fast profile switch consume the same
 * frame as the transition state update, so the overlay exists in React state but never reaches the screen.
 */
export const markWorkbenchProfileTransitionCoverReady = (): void => {
  if (!state.isSwitching || coverReady) return;
  coverReady = true;
  // The minimum is visible time, not time spent waiting for React and the browser to paint the cover.
  startedAt = Date.now();
  resolveCoverWaiters(true);
};

/** Wait until the overlay confirms a painted frame, or the transition backstop releases it. */
export const waitForWorkbenchProfileTransitionCover = (): Promise<boolean> => {
  if (!state.isSwitching || coverReady) return Promise.resolve(coverReady);
  return new Promise((resolve) => {
    coverWaiters.add(resolve);
  });
};

const waitForWorkbenchProfileTransitionIdle = (): Promise<void> => {
  if (!state.isSwitching) return Promise.resolve();
  return new Promise((resolve) => {
    idleWaiters.add(resolve);
  });
};

/**
 * Ends the transition, holding the cover until the minimum has elapsed.
 *
 * Safe to call when no transition is running, and safe to call twice: a switch can fail after the
 * shell was already proven ready, and both paths funnel through here.
 */
export const finishWorkbenchProfileTransition = (): Promise<void> => {
  if (!state.isSwitching) {
    clearTimers();
    return Promise.resolve();
  }
  if (hideTimer !== null) return waitForWorkbenchProfileTransitionIdle();

  const remaining = MIN_TRANSITION_VISIBLE_MS - (Date.now() - startedAt);
  if (remaining <= 0) {
    settle();
    return Promise.resolve();
  }
  const idle = waitForWorkbenchProfileTransitionIdle();
  hideTimer = setTimeout(settle, remaining);
  return idle;
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
  clearTimers();
  resolveCoverWaiters(false);
  resolveIdleWaiters();
  state = IDLE;
  startedAt = 0;
  coverReady = false;
  listeners.clear();
};
