import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { DateTime } from 'luxon';
import { computeNextRunAt, createScheduledTasksRuntime, formatScheduledSessionTitle, isMissedRecurringSlot } from './runtime.js';
import { createProjectConfigRuntime, type ScheduledTask } from '../projects/project-config.js';

describe('scheduled-tasks runtime helpers', () => {
  it('computes next daily run in timezone', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 8, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:30'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 30, 0));
  });

  it('computes weekly next run using weekdays', () => {
    // Monday 2025-01-06 10:00:00 UTC
    const nowUtc = Date.UTC(2025, 0, 6, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'weekly',
        times: ['09:00'],
        weekdays: [1, 3],
        timezone: 'UTC',
      },
    }, nowUtc);

    // Wednesday 2025-01-08 09:00:00 UTC
    expect(next).toBe(Date.UTC(2025, 0, 8, 9, 0, 0));
  });

  it('picks nearest time from multiple daily times', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 9, 20, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:15', '09:45', '18:00'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 45, 0));
  });

  it('computes one-time next run for future date', () => {
    const nowUtc = Date.UTC(2026, 3, 15, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2026, 3, 16, 13, 30, 0));
  });

  it('returns null for past one-time schedule', () => {
    const nowUtc = Date.UTC(2026, 3, 16, 14, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBeNull();
  });

  it('formats session title with timestamp suffix', () => {
    const title = formatScheduledSessionTitle({
      name: 'Morning Sync',
      schedule: { timezone: 'UTC' },
    }, Date.UTC(2025, 2, 10, 7, 5, 0));

    expect(title).toBe('Morning Sync 2025-03-10 07:05');
  });

  it('runs a late recurring slot until the following occurrence has been crossed', () => {
    const daily = { schedule: { kind: 'daily' as const, times: ['09:00', '10:00'], timezone: 'UTC' } };
    const once = { schedule: { kind: 'once' as const, date: '2026-01-01', time: '09:00', timezone: 'UTC' } };
    const scheduledFor = Date.UTC(2026, 0, 1, 9, 0, 0);
    expect(isMissedRecurringSlot(daily, scheduledFor, Date.UTC(2026, 0, 1, 9, 59, 59))).toBe(false);
    expect(isMissedRecurringSlot(daily, scheduledFor, Date.UTC(2026, 0, 1, 10, 0, 1))).toBe(true);
    expect(isMissedRecurringSlot(once, scheduledFor, Date.UTC(2026, 0, 2, 9, 0, 0))).toBe(false);
  });

});

describe('scheduled-tasks runtime recovery', () => {
  const createFixture = async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-scheduled-runtime-'));
    const projectPath = path.join(tempRoot, 'project');
    const projectConfigRuntime = createProjectConfigRuntime({
      fsPromises: await import('node:fs/promises'),
      path,
      projectsDirPath: path.join(tempRoot, 'projects'),
      createTaskID: (() => {
        let counter = 0;
        return () => `task-${(counter += 1)}`;
      })(),
    });
    return {
      tempRoot,
      projectPath,
      projectConfigRuntime,
      cleanup: () => rm(tempRoot, { recursive: true, force: true }),
    };
  };

  const upsertTask = async (
    projectConfigRuntime: ReturnType<typeof createProjectConfigRuntime>,
    task: Record<string, unknown>,
  ): Promise<ScheduledTask> => {
    const result = await projectConfigRuntime.upsertScheduledTask('project-1', task);
    return result.task;
  };

  it('reconciles a persisted running task to interrupted on restart', async () => {
      const { projectPath, projectConfigRuntime, cleanup } = await createFixture();
    try {
      const task = await upsertTask(projectConfigRuntime, {
        name: 'Nightly',
        enabled: true,
        schedule: { kind: 'daily', time: '09:30', timezone: 'UTC' },
        execution: { prompt: 'digest', providerID: 'openai', modelID: 'gpt-4.1' },
      });
      await projectConfigRuntime.updateScheduledTaskState('project-1', task.id, {
        lastStatus: 'running',
        lastRunAt: Date.now() - 60_000,
        lastSessionId: 'dead-session',
      });

      let executions = 0;
      const runtime = createScheduledTasksRuntime({
        projectConfigRuntime,
        listProjects: async () => [{ id: 'project-1', path: projectPath }],
        executeTask: async () => {
          executions += 1;
          return { sessionID: 'new-session' };
        },
        logger: { info: () => {}, warn: () => {} },
      });
      try {
        await runtime.syncProject('project-1');
        const [persisted] = await projectConfigRuntime.listScheduledTasks('project-1');
        expect(persisted?.state.lastStatus).toBe('error');
        expect(persisted?.state.lastError).toMatch(/interrupted/i);
        expect(executions).toBe(0);
      } finally {
        runtime.stop();
      }
    } finally {
      await cleanup();
    }
  });

  it('runs an overdue one-time task once on recovery and consumes it', async () => {
    const { projectPath, projectConfigRuntime, cleanup } = await createFixture();
    try {
      const yesterday = DateTime.utc().minus({ days: 1 }).toFormat('yyyy-LL-dd');
      await upsertTask(projectConfigRuntime, {
        name: 'One shot',
        enabled: true,
        schedule: { kind: 'once', date: yesterday, time: '00:00', timezone: 'UTC' },
        execution: { prompt: 'run once', providerID: 'openai', modelID: 'gpt-4.1' },
      });
      await upsertTask(projectConfigRuntime, {
        name: 'Recurring',
        enabled: true,
        schedule: { kind: 'daily', time: '00:00', timezone: 'UTC' },
        execution: { prompt: 'daily', providerID: 'openai', modelID: 'gpt-4.1' },
      });

      const executed: string[] = [];
      let notifySettled: (() => void) | null = null;
      const settled = new Promise<void>((resolve) => { notifySettled = resolve; });
      const runtime = createScheduledTasksRuntime({
        projectConfigRuntime,
        listProjects: async () => [{ id: 'project-1', path: projectPath }],
        executeTask: async ({ task }) => {
          executed.push(task.name);
          return { sessionID: `sess-${task.name}` };
        },
        emitTaskRunEvent: (event) => {
          if (event.status !== 'running') notifySettled?.();
        },
        logger: { info: () => {}, warn: () => {} },
      });
      try {
        await runtime.start();
        await settled;
        const tasks = await projectConfigRuntime.listScheduledTasks('project-1');
        const once = tasks.find((task) => task.name === 'One shot');
        const recurring = tasks.find((task) => task.name === 'Recurring');
        // Missed slot policy: the one-time intent is still owed a single run —
        // it fires once on recovery and consumes itself. The recurring task
        // skips the missed slot entirely (no catch-up, nextRunAt moved on).
        expect(executed).toEqual(['One shot']);
        expect(once?.enabled).toBe(false);
        expect(once?.state.lastStatus).toBe('success');
        expect(once?.state.lastSessionId).toBe('sess-One shot');
        expect(recurring?.enabled).toBe(true);
        expect(recurring?.state.lastRunAt).toBeUndefined();
      } finally {
        runtime.stop();
      }
    } finally {
      await cleanup();
    }
  });

  it('does not reconcile a genuinely in-flight run during sync', async () => {
    const { projectPath, projectConfigRuntime, cleanup } = await createFixture();
    try {
      await upsertTask(projectConfigRuntime, {
        name: 'Slow',
        enabled: true,
        schedule: { kind: 'daily', time: '09:30', timezone: 'UTC' },
        execution: { prompt: 'work', providerID: 'openai', modelID: 'gpt-4.1' },
      });

      const runGate: { release?: () => void } = {};
      const runtime = createScheduledTasksRuntime({
        projectConfigRuntime,
        listProjects: async () => [{ id: 'project-1', path: projectPath }],
        executeTask: async () => {
          await new Promise<void>((resolve) => { runGate.release = resolve; });
          return { sessionID: 'live-session' };
        },
        logger: { info: () => {}, warn: () => {} },
      });
      try {
        await runtime.syncProject('project-1');
        const runPromise = runtime.runNow('project-1', 'task-1');
        await new Promise((resolve) => setTimeout(resolve, 20));
        await runtime.syncProject('project-1');
        const [midRun] = await projectConfigRuntime.listScheduledTasks('project-1');
        expect(midRun?.state.lastStatus).toBe('running');
        runGate.release?.();
        const result = await runPromise;
        expect(result.ok).toBe(true);
        const [after] = await projectConfigRuntime.listScheduledTasks('project-1');
        expect(after?.state.lastStatus).toBe('success');
      } finally {
        runGate.release?.();
        runtime.stop();
      }
    } finally {
      await cleanup();
    }
  });

  it('interprets an overdue once task in its own timezone during recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
    const { projectPath, projectConfigRuntime, cleanup } = await createFixture();
    try {
      await upsertTask(projectConfigRuntime, {
        name: 'Los Angeles morning',
        enabled: true,
        schedule: { kind: 'once', date: '2026-01-01', time: '09:00', timezone: 'America/Los_Angeles' },
        execution: { prompt: 'later', providerID: 'openai', modelID: 'gpt-4.1' },
      });
      let executions = 0;
      const runtime = createScheduledTasksRuntime({
        projectConfigRuntime,
        listProjects: async () => [{ id: 'project-1', path: projectPath }],
        executeTask: async () => { executions += 1; return { sessionID: 'too-early' }; },
        logger: { info: () => {}, warn: () => {} },
      });
      await runtime.start();
      expect(executions).toBe(0);
      runtime.stop();
    } finally {
      vi.useRealTimers();
      await cleanup();
    }
  });

  it('queues manual runs behind admission and allows disabled tasks to run explicitly', async () => {
    const { projectPath, projectConfigRuntime, cleanup } = await createFixture();
    let releaseFirst: (() => void) | undefined;
    try {
      const first = await upsertTask(projectConfigRuntime, {
        name: 'First', enabled: false,
        schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' },
        execution: { prompt: 'first', providerID: 'openai', modelID: 'gpt-4.1' },
      });
      const second = await upsertTask(projectConfigRuntime, {
        name: 'Second', enabled: false,
        schedule: { kind: 'daily', time: '10:00', timezone: 'UTC' },
        execution: { prompt: 'second', providerID: 'openai', modelID: 'gpt-4.1' },
      });
      let firstStarted: (() => void) | undefined;
      const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
      const calls: string[] = [];
      const runtime = createScheduledTasksRuntime({
        projectConfigRuntime,
        listProjects: async () => [{ id: 'project-1', path: projectPath }],
        maxGlobalConcurrency: 2,
        maxProjectConcurrency: 1,
        executeTask: async ({ task }) => {
          calls.push(task.name);
          if (task.name === 'First') {
            firstStarted?.();
            await new Promise<void>((resolve) => { releaseFirst = resolve; });
          }
          return { sessionID: `session-${task.id}` };
        },
        logger: { info: () => {}, warn: () => {} },
      });
      await runtime.start();
      const firstRun = runtime.runNow('project-1', first.id);
      await firstStartedPromise;
      let secondResolved = false;
      const secondRun = runtime.runNow('project-1', second.id).then((result) => {
        secondResolved = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toEqual(['First']);
      expect(secondResolved).toBe(false);
      releaseFirst?.();
      await expect(firstRun).resolves.toMatchObject({ ok: true });
      await expect(secondRun).resolves.toMatchObject({ ok: true, sessionID: `session-${second.id}` });
      expect(calls).toEqual(['First', 'Second']);
      runtime.stop();
    } finally {
      releaseFirst?.();
      await cleanup();
    }
  });

  it('applies global admission to manual runs across projects', async () => {
    const { projectPath, projectConfigRuntime, cleanup } = await createFixture();
    const gate: { release?: () => void } = {};
    try {
      const definition = (name: string) => ({
        name, enabled: false,
        schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' },
        execution: { prompt: name, providerID: 'openai', modelID: 'gpt-4.1' },
      });
      const first = await upsertTask(projectConfigRuntime, definition('First'));
      const second = (await projectConfigRuntime.upsertScheduledTask('project-2', definition('Second'))).task;
      let firstStarted: (() => void) | undefined;
      const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
      const calls: string[] = [];
      const runtime = createScheduledTasksRuntime({
        projectConfigRuntime,
        listProjects: async () => [
          { id: 'project-1', path: projectPath },
          { id: 'project-2', path: `${projectPath}-2` },
        ],
        maxGlobalConcurrency: 1,
        maxProjectConcurrency: 2,
        executeTask: async ({ task }) => {
          calls.push(task.name);
          if (task.name === 'First') {
            firstStarted?.();
            await new Promise<void>((resolve) => { gate.release = resolve; });
          }
          return { sessionID: `session-${task.name}` };
        },
        logger: { info: () => {}, warn: () => {} },
      });
      await runtime.syncProject('project-1');
      await runtime.syncProject('project-2');
      const firstRun = runtime.runNow('project-1', first.id);
      await firstStartedPromise;
      const secondRun = runtime.runNow('project-2', second.id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toEqual(['First']);
      gate.release?.();
      await expect(firstRun).resolves.toMatchObject({ ok: true });
      await expect(secondRun).resolves.toMatchObject({ ok: true });
      expect(calls).toEqual(['First', 'Second']);
    } finally {
      gate.release?.();
      await cleanup();
    }
  });

  it('rolls back a failed start so a later start can retry', async () => {
    const { projectPath, projectConfigRuntime, cleanup } = await createFixture();
    try {
      let attempts = 0;
      const runtime = createScheduledTasksRuntime({
        projectConfigRuntime,
        listProjects: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('settings unavailable');
          return [{ id: 'project-1', path: projectPath }];
        },
        logger: { info: () => {}, warn: () => {} },
      });
      await expect(runtime.start()).rejects.toThrow('settings unavailable');
      await expect(runtime.start()).resolves.toBeUndefined();
      expect(attempts).toBeGreaterThanOrEqual(2);
      runtime.stop();
    } finally {
      await cleanup();
    }
  });

  it('does not recreate a timer when an in-flight run settles after stop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T08:00:00.000Z'));
    const { projectPath, projectConfigRuntime, cleanup } = await createFixture();
    let release: (() => void) | undefined;
    try {
      const task = await upsertTask(projectConfigRuntime, {
        name: 'Later', enabled: true,
        schedule: { kind: 'once', date: '2026-01-01', time: '09:00', timezone: 'UTC' },
        execution: { prompt: 'later', providerID: 'openai', modelID: 'gpt-4.1' },
      });
      let started: (() => void) | undefined;
      const startedPromise = new Promise<void>((resolve) => { started = resolve; });
      let executions = 0;
      const runtime = createScheduledTasksRuntime({
        projectConfigRuntime,
        listProjects: async () => [{ id: 'project-1', path: projectPath }],
        executeTask: async () => {
          executions += 1;
          started?.();
          await new Promise<void>((resolve) => { release = resolve; });
          return { sessionID: 'manual-session' };
        },
        logger: { info: () => {}, warn: () => {} },
      });
      await runtime.start();
      const run = runtime.runNow('project-1', task.id);
      await startedPromise;
      runtime.stop();
      release?.();
      await expect(run).resolves.toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(3_700_000);
      expect(executions).toBe(1);
    } finally {
      release?.();
      vi.useRealTimers();
      await cleanup();
    }
  });
});
