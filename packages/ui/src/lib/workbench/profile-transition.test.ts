import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  MAX_TRANSITION_VISIBLE_MS,
  MIN_TRANSITION_VISIBLE_MS,
  beginWorkbenchProfileTransition,
  completeWorkbenchProfileTransition,
  getWorkbenchProfileTransitionSnapshot,
  markWorkbenchProfileTransitionCovered,
  markWorkbenchProfileTransitionOperationPrepared,
  resetWorkbenchProfileTransitionForTests,
  resolveTransitionDirection,
  revealWorkbenchProfileTransition,
  subscribeWorkbenchProfileTransition,
  waitForWorkbenchProfileTransitionCovered,
} from './profile-transition';

describe('workbench profile transition state machine', () => {
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
      direction: 'forward',
      fromProfileId: null,
      id: 0,
      phase: 'idle',
      tempo: 'standard',
      toProfileId: null,
    });
  });

  test('starts quick reverse playback and publishes it to current subscribers', () => {
    const phases: string[] = [];
    subscribeWorkbenchProfileTransition((state) => phases.push(state.phase));
    const id = beginWorkbenchProfileTransition({ fromProfileId: 'default', toProfileId: 'piarium.ide' });

    expect(phases).toEqual(['idle', 'covering']);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({
      fromProfileId: 'default',
      id,
      phase: 'covering',
      tempo: 'quick',
      toProfileId: 'piarium.ide',
    });
  });

  test('does not cross the commit boundary until reverse playback is fully covered', async () => {
    const id = beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    let resolved: boolean | undefined;
    const covered = waitForWorkbenchProfileTransitionCovered(id).then((value) => {
      resolved = value;
      return value;
    });
    await Promise.resolve();
    expect(resolved).toBeUndefined();

    markWorkbenchProfileTransitionCovered(id);
    await expect(covered).resolves.toBe(true);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covered');
  });

  test('a candidate prepared during covering keeps the quick reveal', async () => {
    const id = beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    markWorkbenchProfileTransitionOperationPrepared(id);
    markWorkbenchProfileTransitionCovered(id);

    const revealed = revealWorkbenchProfileTransition(id);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ phase: 'revealing', tempo: 'quick' });
    completeWorkbenchProfileTransition(id);
    await revealed;
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
  });

  test('a candidate that reaches the boundary after covering uses the standard reveal', async () => {
    const id = beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    markWorkbenchProfileTransitionCovered(id);
    markWorkbenchProfileTransitionOperationPrepared(id);

    const revealed = revealWorkbenchProfileTransition(id);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ phase: 'revealing', tempo: 'standard' });
    completeWorkbenchProfileTransition(id);
    await revealed;
  });

  test('a prepared candidate that remains covered past the quick grace uses the standard reveal', async () => {
    const id = beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    markWorkbenchProfileTransitionOperationPrepared(id);
    markWorkbenchProfileTransitionCovered(id);
    vi.advanceTimersByTime(MIN_TRANSITION_VISIBLE_MS + 1);

    const revealed = revealWorkbenchProfileTransition(id);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ phase: 'revealing', tempo: 'standard' });
    completeWorkbenchProfileTransition(id);
    await revealed;
  });

  test('missing phase completion signals advance through the existing backstop', async () => {
    const id = beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    const covered = waitForWorkbenchProfileTransitionCovered(id);
    vi.advanceTimersByTime(MAX_TRANSITION_VISIBLE_MS);
    await expect(covered).resolves.toBe(true);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covered');

    const revealed = revealWorkbenchProfileTransition(id);
    vi.advanceTimersByTime(MAX_TRANSITION_VISIBLE_MS);
    await revealed;
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
  });

  test('a newer selection releases a superseded cover waiter', async () => {
    const firstId = beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    const first = waitForWorkbenchProfileTransitionCovered(firstId);
    beginWorkbenchProfileTransition({ toProfileId: 'default' });

    await expect(first).resolves.toBe(false);
    expect(getWorkbenchProfileTransitionSnapshot().toProfileId).toBe('default');
  });

  test('a late animation event cannot advance a newer transition', () => {
    const firstId = beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    const secondId = beginWorkbenchProfileTransition({ toProfileId: 'default' });

    markWorkbenchProfileTransitionCovered(firstId);
    completeWorkbenchProfileTransition(firstId);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({
      id: secondId,
      phase: 'covering',
      toProfileId: 'default',
    });
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
