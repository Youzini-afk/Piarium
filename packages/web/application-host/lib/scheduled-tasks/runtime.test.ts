import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { DateTime } from 'luxon';
import { computeNextRunAt, createScheduledTasksRuntime, formatScheduledSessionTitle } from './runtime.js';
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
    const { tempRoot, projectPath, projectConfigRuntime, cleanup } = await createFixture();
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

      let releaseRun: (() => void) | null = null;
      const runtime = createScheduledTasksRuntime({
        projectConfigRuntime,
        listProjects: async () => [{ id: 'project-1', path: projectPath }],
        executeTask: async () => {
          await new Promise<void>((resolve) => { releaseRun = resolve; });
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
        releaseRun?.();
        const result = await runPromise;
        expect(result.ok).toBe(true);
        const [after] = await projectConfigRuntime.listScheduledTasks('project-1');
        expect(after?.state.lastStatus).toBe('success');
      } finally {
        releaseRun?.();
        runtime.stop();
      }
    } finally {
      await cleanup();
    }
  });
});
