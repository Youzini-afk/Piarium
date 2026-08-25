import { describe, expect, test } from 'vitest';
import {
  createWorkbenchTransitionPaintHandoff,
  WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE,
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
  return {
    attributes,
    frames,
    handoff: createWorkbenchTransitionPaintHandoff(root, scheduler),
    runFrame,
  };
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

  test('retires the scene only after a committed frame and releases the background afterwards', () => {
    const { attributes, handoff, runFrame } = fixture();
    let retired = false;
    handoff.hold();
    handoff.retireSceneAfterPaint(() => { retired = true; });

    runFrame();
    expect(retired).toBe(false);
    expect(attributes.get(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe('true');
    runFrame();
    expect(retired).toBe(true);
    expect(attributes.get(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe('true');

    handoff.releaseAfterPaint();
    runFrame();
    expect(attributes.get(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe('true');
    runFrame();
    expect(attributes.has(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe(false);
  });

  test('a newer transition cancels stale scene retirement', () => {
    const { handoff, runFrame } = fixture();
    let retired = false;
    handoff.hold();
    handoff.retireSceneAfterPaint(() => { retired = true; });
    runFrame();

    handoff.hold();
    expect(() => runFrame()).toThrow('No frame is scheduled');
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
  test('a host that arrives mid-retirement still reaches detachment', () => {
    // Retirement is the step that takes the scene away, so refusing it for want of an earlier hold left
    // the finished scene on screen with nothing scheduled to remove it.
    const { attributes, handoff, runFrame } = fixture();
    let detached = false;
    handoff.retireSceneAfterPaint(() => { detached = true; });
    expect(attributes.get(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe('true');
    runFrame();
    expect(detached).toBe(false);
    runFrame();
    expect(detached).toBe(true);
    // The root palette outlives the scene: it is released on its own schedule, afterwards.
    expect(attributes.get(WORKBENCH_TRANSITION_HANDOFF_ATTRIBUTE)).toBe('true');
  });

  test('a new transition cancels a retirement the previous one never finished', () => {
    const { handoff, runFrame } = fixture();
    let staleDetachments = 0;
    handoff.hold();
    handoff.retireSceneAfterPaint(() => { staleDetachments += 1; });
    runFrame();

    handoff.hold();
    let freshDetachments = 0;
    handoff.retireSceneAfterPaint(() => { freshDetachments += 1; });
    runFrame();
    runFrame();

    expect(staleDetachments).toBe(0);
    expect(freshDetachments).toBe(1);
  });
});
