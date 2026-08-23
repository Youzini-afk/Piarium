import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  MIN_TRANSITION_VISIBLE_MS,
  MAX_TRANSITION_VISIBLE_MS,
  beginWorkbenchProfileTransition,
  finishWorkbenchProfileTransition,
  getWorkbenchProfileTransitionSnapshot,
  markWorkbenchProfileTransitionCoverReady,
  resetWorkbenchProfileTransitionForTests,
  resolveTransitionDirection,
  subscribeWorkbenchProfileTransition,
  waitForWorkbenchProfileTransitionCover,
} from './profile-transition';

describe('workbench profile transition state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetWorkbenchProfileTransitionForTests();
  });

  afterEach(() => {
    resetWorkbenchProfileTransitionForTests();
    vi.useRealTimers();
  });

  test('starts idle', () => {
    expect(getWorkbenchProfileTransitionSnapshot()).toEqual({
      isSwitching: false,
      direction: 'forward',
      fromProfileId: null,
      toProfileId: null,
    });
  });

  test('publishes the current state to a new subscriber', () => {
    beginWorkbenchProfileTransition({ fromProfileId: 'default', toProfileId: 'piarium.ide' });
    const seen: boolean[] = [];
    subscribeWorkbenchProfileTransition((state) => seen.push(state.isSwitching));
    expect(seen).toEqual([true]);
  });

  test('waits for a painted cover before the switch may start', async () => {
    beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    let resolved: boolean | undefined;
    const wait = waitForWorkbenchProfileTransitionCover().then((covered) => {
      resolved = covered;
      return covered;
    });

    await Promise.resolve();
    expect(resolved).toBeUndefined();
    markWorkbenchProfileTransitionCoverReady();
    await expect(wait).resolves.toBe(true);
  });

  test('holds the cover for the minimum visible time after it is painted', async () => {
    beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    vi.advanceTimersByTime(200);
    markWorkbenchProfileTransitionCoverReady();
    const finished = finishWorkbenchProfileTransition();

    expect(getWorkbenchProfileTransitionSnapshot().isSwitching).toBe(true);
    vi.advanceTimersByTime(MIN_TRANSITION_VISIBLE_MS - 1);
    expect(getWorkbenchProfileTransitionSnapshot().isSwitching).toBe(true);
    vi.advanceTimersByTime(1);
    expect(getWorkbenchProfileTransitionSnapshot().isSwitching).toBe(false);
    await finished;
  });

  test('settles at once when the painted cover already outlasted the minimum', async () => {
    beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    markWorkbenchProfileTransitionCoverReady();
    vi.advanceTimersByTime(MIN_TRANSITION_VISIBLE_MS + 50);
    await finishWorkbenchProfileTransition();
    expect(getWorkbenchProfileTransitionSnapshot().isSwitching).toBe(false);
  });

  test('a second finish does not restart or extend the hold', async () => {
    beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    markWorkbenchProfileTransitionCoverReady();
    const first = finishWorkbenchProfileTransition();
    vi.advanceTimersByTime(MIN_TRANSITION_VISIBLE_MS - 20);
    const second = finishWorkbenchProfileTransition();
    vi.advanceTimersByTime(20);
    expect(getWorkbenchProfileTransitionSnapshot().isSwitching).toBe(false);
    await Promise.all([first, second]);
  });

  test('finishing without a transition is a no-op', async () => {
    await finishWorkbenchProfileTransition();
    expect(getWorkbenchProfileTransitionSnapshot().isSwitching).toBe(false);
  });

  test('a switch that never paints is released by the backstop', async () => {
    beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    const cover = waitForWorkbenchProfileTransitionCover();
    vi.advanceTimersByTime(MAX_TRANSITION_VISIBLE_MS);
    expect(getWorkbenchProfileTransitionSnapshot().isSwitching).toBe(false);
    await expect(cover).resolves.toBe(false);
  });

  test('a new transition cancels the previous hold', async () => {
    beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    const first = finishWorkbenchProfileTransition();
    beginWorkbenchProfileTransition({ toProfileId: 'default' });
    await first;

    vi.advanceTimersByTime(MIN_TRANSITION_VISIBLE_MS * 2);
    // The pending hide belonged to the first transition and must not close the second.
    expect(getWorkbenchProfileTransitionSnapshot().toProfileId).toBe('default');
  });
});

describe('sweep direction', () => {
  const profiles = ['default', 'piarium.ide'];

  test('moving later in the profile order sweeps forward', () => {
    expect(resolveTransitionDirection(profiles, 'default', 'piarium.ide')).toBe('forward');
  });

  test('moving earlier reverses the sweep', () => {
    expect(resolveTransitionDirection(profiles, 'piarium.ide', 'default')).toBe('backward');
  });

  test('an unknown origin or target does not guess', () => {
    expect(resolveTransitionDirection(profiles, null, 'piarium.ide')).toBe('forward');
    expect(resolveTransitionDirection(profiles, 'gone', 'piarium.ide')).toBe('forward');
    expect(resolveTransitionDirection(profiles, 'default', 'unknown')).toBe('forward');
  });
});
