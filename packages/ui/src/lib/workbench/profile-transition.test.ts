import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  MIN_TRANSITION_VISIBLE_MS,
  MAX_TRANSITION_VISIBLE_MS,
  beginWorkbenchProfileTransition,
  finishWorkbenchProfileTransition,
  getWorkbenchProfileTransitionSnapshot,
  resetWorkbenchProfileTransitionForTests,
  resolveTransitionDirection,
  subscribeWorkbenchProfileTransition,
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

  test('holds the cover for the minimum even when the switch settles immediately', () => {
    beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    finishWorkbenchProfileTransition();

    expect(getWorkbenchProfileTransitionSnapshot().isSwitching).toBe(true);
    vi.advanceTimersByTime(MIN_TRANSITION_VISIBLE_MS - 1);
    expect(getWorkbenchProfileTransitionSnapshot().isSwitching).toBe(true);
    vi.advanceTimersByTime(1);
    expect(getWorkbenchProfileTransitionSnapshot().isSwitching).toBe(false);
  });

  test('settles at once when the switch already outlasted the minimum', () => {
    beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    vi.advanceTimersByTime(MIN_TRANSITION_VISIBLE_MS + 50);
    finishWorkbenchProfileTransition();
    expect(getWorkbenchProfileTransitionSnapshot().isSwitching).toBe(false);
  });

  test('a second finish does not restart or extend the hold', () => {
    beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    finishWorkbenchProfileTransition();
    vi.advanceTimersByTime(MIN_TRANSITION_VISIBLE_MS - 20);
    finishWorkbenchProfileTransition();
    vi.advanceTimersByTime(20);
    expect(getWorkbenchProfileTransitionSnapshot().isSwitching).toBe(false);
  });

  test('finishing without a transition is a no-op', () => {
    finishWorkbenchProfileTransition();
    expect(getWorkbenchProfileTransitionSnapshot().isSwitching).toBe(false);
  });

  test('a switch that never settles is released by the backstop', () => {
    beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    vi.advanceTimersByTime(MAX_TRANSITION_VISIBLE_MS);
    expect(getWorkbenchProfileTransitionSnapshot().isSwitching).toBe(false);
  });

  test('a new transition cancels the previous hold', () => {
    beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    finishWorkbenchProfileTransition();
    beginWorkbenchProfileTransition({ toProfileId: 'default' });

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
