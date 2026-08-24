import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  PIARIUM_TRANSITION_SCENE_DATA_CONTRACT,
  PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE,
  type PiariumTransitionSceneContributionDataV1,
} from '@piarium/extension-contract';
import {
  QUICK_TRANSITION_COMMIT_GRACE_MS,
  armWorkbenchProfileTransitionPhase,
  beginWorkbenchProfileTransition,
  completeWorkbenchProfileTransition,
  createWorkbenchTransitionSceneController,
  getWorkbenchProfileTransitionSnapshot,
  markWorkbenchProfileTransitionCovered,
  markWorkbenchProfileTransitionOperationPrepared,
  markWorkbenchProfileTransitionTargetPainted,
  resetWorkbenchProfileTransitionForTests,
  resolveTransitionDirection,
  revealWorkbenchProfileTransition,
  subscribeWorkbenchProfileTransition,
  waitForWorkbenchProfileTransitionCovered,
  waitForWorkbenchProfileTransitionTargetPainted,
} from './profile-transition';
import type { WorkbenchTransitionSceneCapture } from '@/lib/extensions/workbench-transition-scene';

const sceneData = (input: {
  coverQuick?: number;
  coverReduced?: number;
  coverStandard?: number;
  revealQuick?: number;
  revealReduced?: number;
  revealStandard?: number;
} = {}): PiariumTransitionSceneContributionDataV1 => ({
  contract: PIARIUM_TRANSITION_SCENE_DATA_CONTRACT,
  durations: {
    [PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE]: {
      covering: {
        quick: input.coverQuick ?? 800,
        reduced: input.coverReduced ?? 0,
        standard: input.coverStandard ?? 1_600,
      },
      revealing: {
        quick: input.revealQuick ?? 700,
        reduced: input.revealReduced ?? 0,
        standard: input.revealStandard ?? 1_400,
      },
    },
  },
  scenes: [PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE],
});

const scene = (data = sceneData()): WorkbenchTransitionSceneCapture => ({
  contributionId: 'dev.example.motion.transition',
  data,
  desiredRevision: 1,
  entrypointId: 'main',
  extensionId: 'dev.example.motion',
  extensionVersion: '1.0.0',
  generation: 1,
  hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
  realmId: 'motion-test',
});

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
      durationMs: 0,
      fromProfileId: null,
      id: 0,
      phase: 'idle',
      reducedMotion: false,
      scene: null,
      tempo: 'standard',
      toProfileId: null,
    });
  });

  test('starts quick reverse playback and publishes it to current subscribers', () => {
    const phases: string[] = [];
    subscribeWorkbenchProfileTransition((state) => phases.push(state.phase));
    const selectedScene = scene();
    const id = beginWorkbenchProfileTransition({
      fromProfileId: 'default',
      scene: selectedScene,
      toProfileId: 'piarium.ide',
    });

    expect(phases).toEqual(['idle', 'covering']);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({
      fromProfileId: 'default',
      durationMs: 800,
      id,
      phase: 'covering',
      scene: selectedScene,
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

    armWorkbenchProfileTransitionPhase(id, 'covering');
    markWorkbenchProfileTransitionCovered(id);
    await expect(covered).resolves.toBe(true);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covered');
  });

  test('a candidate prepared during covering keeps the quick reveal', async () => {
    const id = beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    markWorkbenchProfileTransitionOperationPrepared(id);
    armWorkbenchProfileTransitionPhase(id, 'covering');
    markWorkbenchProfileTransitionCovered(id);

    const revealed = revealWorkbenchProfileTransition(id);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ phase: 'revealing', tempo: 'quick' });
    armWorkbenchProfileTransitionPhase(id, 'revealing');
    completeWorkbenchProfileTransition(id);
    await revealed;
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
  });

  test('keeps the cover closed until the authoritative target Shell has painted', async () => {
    const id = beginWorkbenchProfileTransition({
      fromProfileId: 'default',
      toProfileId: 'piarium.ide',
    });
    armWorkbenchProfileTransitionPhase(id, 'covering');
    markWorkbenchProfileTransitionCovered(id);
    let settled: boolean | undefined;
    const painted = waitForWorkbenchProfileTransitionTargetPainted(id).then((value) => {
      settled = value;
      return value;
    });

    await Promise.resolve();
    expect(settled).toBeUndefined();
    markWorkbenchProfileTransitionTargetPainted(id, 'default');
    await Promise.resolve();
    expect(settled).toBeUndefined();

    markWorkbenchProfileTransitionTargetPainted(id, 'piarium.ide');
    await expect(painted).resolves.toBe(true);
  });

  test('a candidate that reaches the boundary after covering uses the standard reveal', async () => {
    const id = beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    armWorkbenchProfileTransitionPhase(id, 'covering');
    markWorkbenchProfileTransitionCovered(id);
    markWorkbenchProfileTransitionOperationPrepared(id);

    const revealed = revealWorkbenchProfileTransition(id);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ phase: 'revealing', tempo: 'standard' });
    armWorkbenchProfileTransitionPhase(id, 'revealing');
    completeWorkbenchProfileTransition(id);
    await revealed;
  });

  test('a prepared candidate that remains covered past the quick grace uses the standard reveal', async () => {
    const id = beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    markWorkbenchProfileTransitionOperationPrepared(id);
    armWorkbenchProfileTransitionPhase(id, 'covering');
    markWorkbenchProfileTransitionCovered(id);
    vi.advanceTimersByTime(QUICK_TRANSITION_COMMIT_GRACE_MS + 1);

    const revealed = revealWorkbenchProfileTransition(id);
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ phase: 'revealing', tempo: 'standard' });
    armWorkbenchProfileTransitionPhase(id, 'revealing');
    completeWorkbenchProfileTransition(id);
    await revealed;
  });

  test('declared scene durations advance phases without a renderer completion signal', async () => {
    const id = beginWorkbenchProfileTransition({ scene: scene(), toProfileId: 'piarium.ide' });
    const covered = waitForWorkbenchProfileTransitionCovered(id);
    armWorkbenchProfileTransitionPhase(id, 'covering');
    vi.advanceTimersByTime(800);
    await expect(covered).resolves.toBe(true);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covered');

    const revealed = revealWorkbenchProfileTransition(id);
    armWorkbenchProfileTransitionPhase(id, 'revealing');
    vi.advanceTimersByTime(1_400);
    await revealed;
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
  });

  test('a declared duration does not run before the scene mount reports ready', () => {
    const id = beginWorkbenchProfileTransition({ scene: scene(), toProfileId: 'piarium.ide' });
    vi.advanceTimersByTime(8_000);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covering');
    armWorkbenchProfileTransitionPhase(id, 'covering');
    vi.advanceTimersByTime(799);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covering');
    vi.advanceTimersByTime(1);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covered');
  });

  test('reduced motion uses the scene declared reduced duration', async () => {
    const id = beginWorkbenchProfileTransition({
      reducedMotion: true,
      scene: scene(sceneData({ coverReduced: 25, revealReduced: 40 })),
      toProfileId: 'piarium.ide',
    });
    expect(getWorkbenchProfileTransitionSnapshot().durationMs).toBe(25);
    armWorkbenchProfileTransitionPhase(id, 'covering');
    vi.advanceTimersByTime(25);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covered');
    const revealed = revealWorkbenchProfileTransition(id);
    expect(getWorkbenchProfileTransitionSnapshot().durationMs).toBe(40);
    armWorkbenchProfileTransitionPhase(id, 'revealing');
    vi.advanceTimersByTime(40);
    await revealed;
  });

  test('Core fallback is explicit and advances asynchronously without inventing a duration', async () => {
    const id = beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ durationMs: 0, scene: null });
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covering');
    armWorkbenchProfileTransitionPhase(id, 'covering');
    vi.advanceTimersByTime(0);
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covered');
    const revealed = revealWorkbenchProfileTransition(id);
    armWorkbenchProfileTransitionPhase(id, 'revealing');
    vi.advanceTimersByTime(0);
    await revealed;
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('idle');
  });

  test('a scene controller publishes frames and rejects stale phase completion', () => {
    const firstId = beginWorkbenchProfileTransition({
      fromProfileId: 'default',
      scene: scene(),
      toProfileId: 'piarium.ide',
    });
    const controller = createWorkbenchTransitionSceneController(firstId);
    expect(controller.getSnapshot()).toMatchObject({
      contractVersion: 1,
      fromProfileId: 'default',
      phase: 'covering',
      toProfileId: 'piarium.ide',
      transitionId: firstId,
    });
    controller.complete(firstId + 1, 'covering');
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covering');
    controller.complete(firstId, 'covering');
    expect(getWorkbenchProfileTransitionSnapshot().phase).toBe('covering');
    armWorkbenchProfileTransitionPhase(firstId, 'covering');
    controller.complete(firstId, 'covering');
    expect(controller.getSnapshot().phase).toBe('covered');

    const secondId = beginWorkbenchProfileTransition({ scene: scene(), toProfileId: 'default' });
    controller.complete(firstId, 'revealing');
    expect(getWorkbenchProfileTransitionSnapshot()).toMatchObject({ id: secondId, phase: 'covering' });
  });

  test('a newer selection releases a superseded cover waiter', async () => {
    const firstId = beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    const first = waitForWorkbenchProfileTransitionCovered(firstId);
    beginWorkbenchProfileTransition({ toProfileId: 'default' });

    await expect(first).resolves.toBe(false);
    expect(getWorkbenchProfileTransitionSnapshot().toProfileId).toBe('default');
  });

  test('a newer selection releases a superseded target-paint waiter', async () => {
    const firstId = beginWorkbenchProfileTransition({ toProfileId: 'piarium.ide' });
    armWorkbenchProfileTransitionPhase(firstId, 'covering');
    markWorkbenchProfileTransitionCovered(firstId);
    const first = waitForWorkbenchProfileTransitionTargetPainted(firstId);
    beginWorkbenchProfileTransition({ toProfileId: 'default' });

    await expect(first).resolves.toBe(false);
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
