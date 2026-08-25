import { describe, expect, test } from 'vitest';
import {
  createWorkbenchTransitionPaintHandoff,
  WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE,
  WORKBENCH_TRANSITION_RETIRE_FADE_MS,
} from './transition-paint-handoff';

const fixture = () => {
  const attributes = new Map<string, string>();
  const frames = new Map<number, () => void>();
  const tasks = new Map<number, () => void>();
  let sequence = 0;
  const root = {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    removeAttribute: (name: string) => { attributes.delete(name); },
    setAttribute: (name: string, value: string) => { attributes.set(name, value); },
  };
  const scheduler = {
    cancelFrame: (frame: number) => { frames.delete(frame); },
    cancelTask: (task: number) => { tasks.delete(task); },
    requestFrame: (callback: () => void) => {
      const id = ++sequence;
      frames.set(id, callback);
      return id;
    },
    scheduleTask: (callback: () => void) => {
      const id = ++sequence;
      tasks.set(id, callback);
      return id;
    },
  };
  const runFrame = (): (() => void) => {
    const next = frames.entries().next().value as [number, () => void] | undefined;
    if (!next) throw new Error('No frame is scheduled');
    frames.delete(next[0]);
    next[1]();
    return next[1];
  };
  const runTask = (): (() => void) => {
    const next = tasks.entries().next().value as [number, () => void] | undefined;
    if (!next) throw new Error('No task is scheduled');
    tasks.delete(next[0]);
    next[1]();
    return next[1];
  };
  return {
    attributes,
    frames,
    handoff: createWorkbenchTransitionPaintHandoff(root, scheduler),
    runFrame,
    runTask,
  };
};

const sceneFixture = () => {
  const animations: Array<{
    cancel(): void;
    cancelled: boolean;
    finish(): void;
    finished: Promise<void>;
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null;
    options: number | KeyframeAnimationOptions | undefined;
  }> = [];
  const layer = {
    style: { opacity: '' },
    animate: (
      keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      options?: number | KeyframeAnimationOptions,
    ) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const finished = new Promise<void>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      const animation = {
        cancelled: false,
        cancel() {
          animation.cancelled = true;
          reject(new Error('cancelled'));
        },
        finish: resolve,
        finished,
        keyframes,
        options,
      };
      animations.push(animation);
      return animation;
    },
  };
  return { animations, layer };
};

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('workbench transition paint handoff', () => {
  test('keeps the transition background through one committed Shell frame', () => {
    const { attributes, handoff, runFrame } = fixture();
    handoff.hold();
    handoff.releaseAfterPaint();

    expect(attributes.get(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe('true');
    runFrame();
    expect(attributes.get(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe('true');
    runFrame();
    expect(attributes.has(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe(false);
  });

  test('retires the scene only after its compositor fade finishes and releases the background afterwards', async () => {
    const { attributes, handoff, runFrame } = fixture();
    const scene = sceneFixture();
    let retired = false;
    handoff.hold();
    handoff.retireScene(scene.layer, { reducedMotion: false }, () => { retired = true; });

    expect(retired).toBe(false);
    expect(attributes.get(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe('true');
    expect(scene.animations).toHaveLength(1);
    expect(scene.animations[0]?.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
    expect(scene.animations[0]?.options).toMatchObject({
      duration: WORKBENCH_TRANSITION_RETIRE_FADE_MS,
      fill: 'forwards',
    });
    scene.animations[0]?.finish();
    await flushPromises();
    expect(retired).toBe(true);
    expect(attributes.get(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe('true');

    handoff.releaseAfterPaint();
    runFrame();
    expect(attributes.get(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe('true');
    runFrame();
    expect(attributes.has(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe(false);
  });

  test('a newer transition cancels stale scene retirement', async () => {
    const { handoff } = fixture();
    const scene = sceneFixture();
    let retired = false;
    handoff.hold();
    handoff.retireScene(scene.layer, { reducedMotion: false }, () => { retired = true; });

    handoff.hold();
    scene.animations[0]?.finish();
    await flushPromises();
    expect(scene.animations[0]?.cancelled).toBe(true);
    expect(retired).toBe(false);
  });

  test('a newer transition cancels a stale release from the previous switch', () => {
    const { attributes, frames, handoff, runFrame } = fixture();
    handoff.hold();
    handoff.releaseAfterPaint();
    runFrame();
    const staleRelease = frames.values().next().value as (() => void) | undefined;
    expect(staleRelease).toBeTypeOf('function');

    handoff.hold();
    staleRelease?.();
    expect(attributes.get(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe('true');

    handoff.releaseAfterPaint();
    runFrame();
    runFrame();
    expect(attributes.has(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe(false);
  });
});

describe('retirement ownership', () => {
  test('a host that arrives mid-retirement still reaches detachment', async () => {
    // Retirement is the step that takes the scene away, so refusing it for want of an earlier hold left
    // the finished scene on screen with nothing scheduled to remove it.
    const { attributes, handoff } = fixture();
    const scene = sceneFixture();
    let detached = false;
    handoff.retireScene(scene.layer, { reducedMotion: false }, () => { detached = true; });
    expect(attributes.get(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe('true');
    expect(detached).toBe(false);
    scene.animations[0]?.finish();
    await flushPromises();
    expect(detached).toBe(true);
    // The root palette outlives the scene: it is released on its own schedule, afterwards.
    expect(attributes.get(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe('true');
  });

  test('a new transition cancels a retirement the previous one never finished', async () => {
    const { handoff } = fixture();
    const scene = sceneFixture();
    let staleDetachments = 0;
    handoff.hold();
    handoff.retireScene(scene.layer, { reducedMotion: false }, () => { staleDetachments += 1; });

    handoff.hold();
    let freshDetachments = 0;
    handoff.retireScene(scene.layer, { reducedMotion: false }, () => { freshDetachments += 1; });
    scene.animations[0]?.finish();
    scene.animations[1]?.finish();
    await flushPromises();

    expect(staleDetachments).toBe(0);
    expect(freshDetachments).toBe(1);
  });

  test('reduced motion still hides the wrapper before detachment', async () => {
    const { handoff } = fixture();
    const scene = sceneFixture();
    let detached = false;

    handoff.retireScene(scene.layer, { reducedMotion: true }, () => { detached = true; });
    expect(scene.animations[0]?.options).toMatchObject({ duration: 0, fill: 'forwards' });
    scene.animations[0]?.finish();
    await flushPromises();

    expect(detached).toBe(true);
  });

  test('falls back to a hidden wrapper when Web Animations is unavailable', () => {
    const { handoff, runTask } = fixture();
    const layer = { style: { opacity: '' } };
    let detached = false;

    handoff.retireScene(layer, { reducedMotion: false }, () => { detached = true; });
    expect(layer.style.opacity).toBe('0');
    expect(detached).toBe(false);
    runTask();
    expect(detached).toBe(true);
  });
});
