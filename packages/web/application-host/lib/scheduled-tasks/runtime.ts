import { DateTime } from 'luxon';
import parser from 'cron-parser';
import { discoverLoops } from './loops.js';
import type { ScheduledTask } from '../projects/project-config.js';
import type { createProjectConfigRuntime } from '../projects/project-config.js';

const DEFAULT_GLOBAL_CONCURRENCY = 4;
const DEFAULT_PROJECT_CONCURRENCY = 2;
const DEFAULT_MAX_RUN_MS = 30 * 60 * 1000;
const JITTER_MAX_MS = 2_000;
const TASK_TITLE_MAX_LENGTH = 120;
const TASK_DUE_SLACK_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type RunReason = 'manual' | 'scheduled';

interface ScheduledProject {
  id: string;
  path: string;
}

interface TaskRunEvent {
  projectID: string;
  ranAt: number;
  sessionID?: string;
  status: 'error' | 'running' | 'success';
  taskID: string;
}

interface ExecutorInput {
  onSessionCreated?: (sessionId: string) => void;
  projectID: string;
  projectPath: string;
  reason: RunReason;
  startedAt: number;
  task: ScheduledTask;
  title: string;
}

type TaskExecutor = (input: ExecutorInput) => Promise<{ sessionID: string }>;

interface ScheduledTasksRuntimeDependencies {
  emitTaskRunEvent?: (event: TaskRunEvent) => void;
  executeTask?: TaskExecutor;
  listProjects: () => Promise<ScheduledProject[]>;
  logger?: Pick<Console, 'info' | 'warn'>;
  maxGlobalConcurrency?: number;
  maxProjectConcurrency?: number;
  maxRunDurationMs?: number;
  projectConfigRuntime: ReturnType<typeof createProjectConfigRuntime>;
}

export interface ScheduledTaskRunResult {
  error?: string | undefined;
  ok: boolean;
  queued?: boolean;
  running?: boolean;
  sessionID?: string | undefined;
  skipped?: boolean;
  status?: 'error' | 'success';
  task?: ScheduledTask | null | undefined;
}

const buildTaskKey = (projectID: string, taskID: string): string => `${projectID}:${taskID}`;

const parseTimeParts = (time: unknown): { hour: number; minute: number } | null => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof time === 'string' ? time : '');
  if (!match) {
    return null;
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
};

const applyTimeToDate = (baseDateTime: DateTime, time: unknown): DateTime | null => {
  const parsed = parseTimeParts(time);
  if (!parsed) {
    return null;
  }
  return baseDateTime.set({
    hour: parsed.hour,
    minute: parsed.minute,
    second: 0,
    millisecond: 0,
  });
};

const resolveScheduleTimes = (schedule: ScheduledTask['schedule']): string[] => {
  const times: string[] = [];
  if (Array.isArray(schedule?.times)) {
    for (const candidate of schedule.times) {
      if (typeof candidate === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(candidate)) {
        times.push(candidate);
      }
    }
  }
  if (times.length === 0 && typeof schedule?.time === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(schedule.time)) {
    times.push(schedule.time);
  }
  return Array.from(new Set(times)).sort((a, b) => a.localeCompare(b));
};

const weekdayAsZeroBased = (dateTime: DateTime): number | null => {
  if (!dateTime || typeof dateTime.weekday !== 'number') {
    return null;
  }
  return dateTime.weekday % 7;
};

const safeErrorMessage = (error: unknown, maxLength = 2_000): string => {
  const raw = error instanceof Error
    ? (error.message || String(error))
    : String(error ?? 'Unknown error');
  const trimmed = raw.trim();
  if (!trimmed) {
    return 'Unknown error';
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

export const computeNextRunAt = (task: {
  enabled?: boolean;
  schedule?: Partial<ScheduledTask['schedule']>;
} | null | undefined, nowMs = Date.now()): number | null => {
  if (!task?.enabled) {
    return null;
  }

  const schedule = task.schedule;
  if (!schedule || typeof schedule !== 'object') {
    return null;
  }

  const zone = typeof schedule.timezone === 'string' && schedule.timezone.trim().length > 0
    ? schedule.timezone.trim()
    : DateTime.local().zoneName;

  const now = DateTime.fromMillis(nowMs, { zone });
  if (!now.isValid) {
    return null;
  }

  if (schedule.kind === 'daily') {
    const times = resolveScheduleTimes(schedule as ScheduledTask['schedule']);
    if (times.length === 0) {
      return null;
    }
    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });

    for (const time of times) {
      const candidateToday = applyTimeToDate(now, time);
      if (!candidateToday || !candidateToday.isValid) {
        continue;
      }
      if (candidateToday > minAllowed) {
        return candidateToday.toMillis();
      }
    }

    const tomorrow = now.plus({ days: 1 });
    const firstTomorrow = applyTimeToDate(tomorrow, times[0]);
    return firstTomorrow?.isValid ? firstTomorrow.toMillis() : null;
  }

  if (schedule.kind === 'weekly') {
    if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) {
      return null;
    }
    const times = resolveScheduleTimes(schedule as ScheduledTask['schedule']);
    if (times.length === 0) {
      return null;
    }
    const weekdaysSet = new Set(schedule.weekdays);
    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });

    for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
      const dayCandidate = now.plus({ days: dayOffset });
      const zeroBasedWeekday = weekdayAsZeroBased(dayCandidate);
      if (zeroBasedWeekday === null || !weekdaysSet.has(zeroBasedWeekday)) {
        continue;
      }
      for (const time of times) {
        const withTime = applyTimeToDate(dayCandidate, time);
        if (!withTime || !withTime.isValid) {
          continue;
        }
        if (withTime > minAllowed) {
          return withTime.toMillis();
        }
      }
    }
    return null;
  }

  if (schedule.kind === 'once') {
    if (typeof schedule.date !== 'string' || typeof schedule.time !== 'string') {
      return null;
    }

    const parsed = DateTime.fromFormat(
      `${schedule.date} ${schedule.time}`,
      'yyyy-LL-dd HH:mm',
      { zone },
    );
    if (!parsed.isValid) {
      return null;
    }

    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });
    if (parsed <= minAllowed) {
      return null;
    }

    return parsed.toMillis();
  }

  if (schedule.kind === 'cron') {
    if (typeof schedule.cron !== 'string' || !schedule.cron) return null;
    try {
      const iterator = parser.parseExpression(schedule.cron, {
        tz: zone,
        currentDate: new Date(nowMs),
      });
      return iterator.next().getTime();
    } catch {
      // Missing project metadata makes the task temporarily unrunnable.
      return null;
    }
  }

  return null;
};

export const formatScheduledSessionTitle = (task: {
  name?: string;
  schedule?: { timezone?: string };
}, nowMs = Date.now()): string => {
  const timezone = typeof task?.schedule?.timezone === 'string' && task.schedule.timezone.trim().length > 0
    ? task.schedule.timezone.trim()
    : DateTime.local().zoneName;
  const stamp = DateTime.fromMillis(nowMs, { zone: timezone }).toFormat('yyyy-LL-dd HH:mm');
  const taskName = typeof task?.name === 'string' && task.name.trim().length > 0
    ? task.name.trim()
    : 'Scheduled task';
  const suffix = ` ${stamp}`;
  const maxTaskNameLength = Math.max(1, TASK_TITLE_MAX_LENGTH - suffix.length);
  const trimmedName = taskName.length > maxTaskNameLength
    ? taskName.slice(0, maxTaskNameLength)
    : taskName;
  return `${trimmedName}${suffix}`;
};

export const createScheduledTasksRuntime = (deps: ScheduledTasksRuntimeDependencies) => {
  const {
    projectConfigRuntime,
    listProjects,
    emitTaskRunEvent,
    executeTask: initialExecuteTask,
    logger = console,
    maxGlobalConcurrency = DEFAULT_GLOBAL_CONCURRENCY,
    maxProjectConcurrency = DEFAULT_PROJECT_CONCURRENCY,
    maxRunDurationMs = DEFAULT_MAX_RUN_MS,
  } = deps;

  let executeTask = initialExecuteTask;
  let started = false;
  const tasksByProject = new Map<string, Map<string, ScheduledTask>>();
  const projectPathByID = new Map<string, string>();
  const timersByTaskKey = new Map<string, ReturnType<typeof setTimeout>>();
  const queuedTaskKeys = new Set<string>();
  const runningTaskKeys = new Set<string>();
  const runningCountByProject = new Map<string, number>();
  let runningGlobalCount = 0;
  const queue: Array<{ projectID: string; reason: RunReason; taskID: string }> = [];

  const clearTimerForKey = (taskKey: string): void => {
    const timer = timersByTaskKey.get(taskKey);
    if (timer) {
      clearTimeout(timer);
      timersByTaskKey.delete(taskKey);
    }
  };

  const clearProjectTimers = (projectID: string): void => {
    const tasks = tasksByProject.get(projectID);
    if (!tasks) {
      return;
    }
    for (const task of tasks.values()) {
      clearTimerForKey(buildTaskKey(projectID, task.id));
      queuedTaskKeys.delete(buildTaskKey(projectID, task.id));
    }
  };

  const setProjectTasks = (projectID: string, tasks: ScheduledTask[]): void => {
    clearProjectTimers(projectID);
    const taskMap = new Map<string, ScheduledTask>();
    for (const task of tasks) {
      taskMap.set(task.id, task);
    }
    tasksByProject.set(projectID, taskMap);
  };

  const scheduleTask = (projectID: string, taskID: string, nextRunAt: number): void => {
    const taskKey = buildTaskKey(projectID, taskID);
    clearTimerForKey(taskKey);

    if (!Number.isFinite(nextRunAt) || nextRunAt <= 0) {
      return;
    }

    const delayBase = Math.max(0, Math.round(nextRunAt - Date.now()));
    const jitter = Math.floor(Math.random() * (JITTER_MAX_MS + 1));
    const delay = delayBase + jitter;
    const boundedDelay = Math.min(delay, MAX_TIMER_DELAY_MS);

    const timer = setTimeout(async () => {
      if (delay > MAX_TIMER_DELAY_MS) {
        scheduleTask(projectID, taskID, nextRunAt);
        return;
      }

      clearTimerForKey(taskKey);
      const taskMap = tasksByProject.get(projectID);
      const task = taskMap?.get(taskID);
      if (!task || !task.enabled) {
        return;
      }
      queueTaskRun(projectID, taskID, 'scheduled');
      pumpQueue();
    }, boundedDelay);

    timersByTaskKey.set(taskKey, timer);
  };

  const updateInMemoryTask = (projectID: string, nextTask: ScheduledTask | null): void => {
    if (!nextTask) {
      return;
    }
    const taskMap = tasksByProject.get(projectID);
    if (!taskMap) {
      return;
    }
    taskMap.set(nextTask.id, nextTask);
  };

  const syncTaskSchedule = async (projectID: string, task: ScheduledTask | null): Promise<ScheduledTask | null> => {
    if (!task) {
      return task;
    }
    const nextRunAt = computeNextRunAt(task, Date.now());
    const statePatch = {
      nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : undefined,
      updatedAt: Date.now(),
    };
    const result = await projectConfigRuntime.updateScheduledTaskState(projectID, task.id, statePatch);
    if (result.task) {
      updateInMemoryTask(projectID, result.task);
      if (result.task.enabled && typeof result.task.state.nextRunAt === 'number' && Number.isFinite(result.task.state.nextRunAt)) {
        scheduleTask(projectID, result.task.id, result.task.state.nextRunAt);
      }
      return result.task;
    }
    return task;
  };

  const ensureProjectPath = async (projectID: string): Promise<string | null> => {
    if (projectPathByID.has(projectID)) {
      return projectPathByID.get(projectID) || null;
    }

    try {
      const projects = await listProjects();
      const project = projects.find((item) => item?.id === projectID && item?.path);
      if (project?.path) {
        projectPathByID.set(projectID, project.path);
        return project.path;
      }
    } catch {
      // Missing project metadata makes the task temporarily unrunnable.
    }

    return null;
  };

  const syncProject = async (projectID: string): Promise<ScheduledTask[]> => {
    const projectPath = await ensureProjectPath(projectID);

    let tasks = await projectConfigRuntime.listScheduledTasks(projectID);
    if (projectPath && typeof projectConfigRuntime.reconcileLoopTasks === 'function') {
      try {
        tasks = await projectConfigRuntime.reconcileLoopTasks(projectID, await discoverLoops(projectPath, { logger }));
      } catch (error) {
        // A discovery failure must not make existing scheduled tasks disappear
        // or prevent the task list from opening. Keep the last persisted state
        // and retry on the next sync.
        logger.warn?.('[ScheduledTasks] failed to reconcile Markdown loops:', error);
      }
    }
    const activeTasks = tasks.filter((task) => task.loopShadowed !== true);
    setProjectTasks(projectID, activeTasks);

    for (const task of activeTasks) {
      const nextTask = await syncTaskSchedule(projectID, task);
      if (nextTask) updateInMemoryTask(projectID, nextTask);
    }

    return Array.from(tasksByProject.get(projectID)?.values() || []);
  };

  const syncAllProjects = async (): Promise<void> => {
    const projects = await listProjects();
    const activeProjectIDs = new Set<string>();
    projectPathByID.clear();
    for (const project of projects) {
      if (!project?.id || !project?.path) {
        continue;
      }
      activeProjectIDs.add(project.id);
      projectPathByID.set(project.id, project.path);
    }

    for (const existingProjectID of Array.from(tasksByProject.keys())) {
      if (!activeProjectIDs.has(existingProjectID)) {
        clearProjectTimers(existingProjectID);
        tasksByProject.delete(existingProjectID);
      }
    }

    for (const projectID of activeProjectIDs) {
      await syncProject(projectID);
    }
  };

  const queueTaskRun = (projectID: string, taskID: string, reason: RunReason): void => {
    const taskKey = buildTaskKey(projectID, taskID);
    if (queuedTaskKeys.has(taskKey) || runningTaskKeys.has(taskKey)) {
      return;
    }
    queuedTaskKeys.add(taskKey);
    queue.push({ projectID, taskID, reason });
  };

  const canRunTask = (projectID: string): boolean => {
    if (runningGlobalCount >= maxGlobalConcurrency) {
      return false;
    }
    const projectRunning = runningCountByProject.get(projectID) || 0;
    return projectRunning < maxProjectConcurrency;
  };

  const runTaskWithWatchdog = async (projectID: string, task: ScheduledTask, reason: RunReason) => {
    const startedAt = Date.now();
    const title = formatScheduledSessionTitle(task, startedAt);
    const projectPath = projectPathByID.get(projectID);
    if (!projectPath) {
      throw new Error('project path is unavailable');
    }

    if (typeof executeTask !== 'function') {
      throw new Error('Pi scheduled task executor is unavailable');
    }

    const result = await executeTask({
      projectID,
      projectPath,
      reason,
      startedAt,
      task,
      title,
      onSessionCreated: (sessionID: string) => {
        try {
          emitTaskRunEvent?.({
            projectID,
            taskID: task.id,
            ranAt: startedAt,
            status: 'running',
            sessionID,
          });
        } catch {
          // Event delivery must not fail the scheduled execution itself.
        }
      },
    });
    const sessionID = result?.sessionID;
    if (!sessionID) throw new Error('Pi scheduled task executor did not return a session ID');

    const finishedAt = Date.now();
    return {
      sessionID,
      durationMs: Math.max(0, finishedAt - startedAt),
      reason,
      startedAt,
      finishedAt,
    };
  };

  const runTask = async (projectID: string, taskID: string, reason: RunReason): Promise<ScheduledTaskRunResult> => {
    const taskMap = tasksByProject.get(projectID);
    const task = taskMap?.get(taskID);
    if (!task || !task.enabled) {
      return { ok: false, skipped: true };
    }

    const taskKey = buildTaskKey(projectID, taskID);
    if (runningTaskKeys.has(taskKey)) {
      return { ok: false, running: true };
    }

    runningTaskKeys.add(taskKey);
    runningGlobalCount += 1;
    runningCountByProject.set(projectID, (runningCountByProject.get(projectID) || 0) + 1);

    const runStartedAt = Date.now();
    await projectConfigRuntime.updateScheduledTaskState(projectID, taskID, {
      lastRunAt: runStartedAt,
      lastStatus: 'running',
      lastError: undefined,
      updatedAt: runStartedAt,
    }).then((result) => {
      if (result.task) {
        updateInMemoryTask(projectID, result.task);
      }
    });

    let status: 'error' | 'success' = 'success';
    let sessionID: string | undefined;
    let durationMs = 0;
    let errorMessage: string | undefined;

    try {
      const runPromise = runTaskWithWatchdog(projectID, task, reason);
      let timeoutID: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutID = setTimeout(() => {
          reject(new Error('scheduled task run timed out'));
        }, maxRunDurationMs);
      });

      const result = await Promise.race([runPromise, timeoutPromise]).finally(() => {
        if (timeoutID) {
          clearTimeout(timeoutID);
        }
      });
      sessionID = result.sessionID;
      durationMs = result.durationMs;
      status = 'success';
      logger.info?.(
        '[ScheduledTasks] run completed',
        { projectID, taskID, status, reason, sessionID, durationMs }
      );
    } catch (error) {
      status = 'error';
      if (error && typeof error === 'object' && 'sessionID' in error && typeof error.sessionID === 'string') sessionID = error.sessionID;
      errorMessage = safeErrorMessage(error);
      logger.warn?.('[ScheduledTasks] run failed', {
        projectID,
        taskID,
        reason,
        status,
        error: errorMessage,
      });
    }

    const finishedAt = Date.now();
    if (!durationMs) {
      durationMs = Math.max(0, finishedAt - runStartedAt);
    }
    let latestTask = (tasksByProject.get(projectID)?.get(taskID)) || task;
    const shouldConsumeOneTimeTask = latestTask?.schedule?.kind === 'once' && reason === 'scheduled';
    if (shouldConsumeOneTimeTask && latestTask?.enabled) {
      try {
        const consumed = await projectConfigRuntime.upsertScheduledTask(projectID, {
          ...latestTask,
          enabled: false,
        });
        latestTask = consumed.task || latestTask;
        updateInMemoryTask(projectID, latestTask);
      } catch (consumeError) {
        logger.warn?.('[ScheduledTasks] failed to consume one-time task', {
          projectID,
          taskID,
          error: safeErrorMessage(consumeError),
        });
      }
    }

    const nextRunAt = computeNextRunAt(latestTask, finishedAt);

    const statePatch = {
      lastStatus: status,
      lastDurationMs: durationMs,
      lastError: status === 'error' ? errorMessage : undefined,
      lastSessionId: status === 'success' ? sessionID : undefined,
      nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : undefined,
      updatedAt: finishedAt,
    };

    const stateResult = await projectConfigRuntime.updateScheduledTaskState(projectID, taskID, statePatch);
    if (stateResult.task) {
      updateInMemoryTask(projectID, stateResult.task);
      if (stateResult.task.enabled && typeof stateResult.task.state.nextRunAt === 'number' && Number.isFinite(stateResult.task.state.nextRunAt)) {
        scheduleTask(projectID, taskID, stateResult.task.state.nextRunAt);
      }
    }

    try {
      emitTaskRunEvent?.({
        projectID,
        taskID,
        ranAt: finishedAt,
        status,
        ...(sessionID ? { sessionID } : {}),
      });
    } catch {
      // Event delivery must not alter the persisted run result.
    }

    runningTaskKeys.delete(taskKey);
    runningGlobalCount = Math.max(0, runningGlobalCount - 1);
    const nextProjectCount = Math.max(0, (runningCountByProject.get(projectID) || 1) - 1);
    if (nextProjectCount === 0) {
      runningCountByProject.delete(projectID);
    } else {
      runningCountByProject.set(projectID, nextProjectCount);
    }

    return {
      ok: status === 'success',
      status,
      sessionID,
      task: stateResult.task || null,
      error: errorMessage,
    };
  };

  const pumpQueue = (): void => {
    if (!started) {
      return;
    }

    let consumed = false;
    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      if (!item) continue;
      if (!canRunTask(item.projectID)) {
        continue;
      }

      queue.splice(index, 1);
      index -= 1;

      const taskKey = buildTaskKey(item.projectID, item.taskID);
      queuedTaskKeys.delete(taskKey);
      consumed = true;

      void runTask(item.projectID, item.taskID, item.reason).finally(() => {
        pumpQueue();
      });
    }

    if (!consumed && queue.length > 0) {
      return;
    }
  };

  const runNow = async (projectID: string, taskID: string): Promise<ScheduledTaskRunResult> => {
    const taskKey = buildTaskKey(projectID, taskID);
    if (runningTaskKeys.has(taskKey)) {
      return {
        ok: false,
        running: true,
        error: 'task is already running',
      };
    }
    if (queuedTaskKeys.has(taskKey)) {
      return {
        ok: false,
        queued: true,
        error: 'task is already queued',
      };
    }

    return runTask(projectID, taskID, 'manual');
  };

  const start = async (): Promise<void> => {
    if (started) {
      return;
    }
    started = true;
    await syncAllProjects();
  };

  const stop = (): void => {
    if (!started) {
      return;
    }
    started = false;
    for (const timer of timersByTaskKey.values()) {
      clearTimeout(timer);
    }
    timersByTaskKey.clear();
    queuedTaskKeys.clear();
    queue.length = 0;
  };

  const getStatus = () => {
    let enabledCount = 0;
    for (const taskMap of tasksByProject.values()) {
      for (const task of taskMap.values()) {
        if (task?.enabled) {
          enabledCount += 1;
        }
      }
    }

    const runningCount = runningTaskKeys.size;
    return {
      hasEnabledScheduledTasks: enabledCount > 0,
      hasRunningScheduledTasks: runningCount > 0,
      enabledScheduledTasksCount: enabledCount,
      runningScheduledTasksCount: runningCount,
    };
  };

  const setExecutor = (nextExecutor: TaskExecutor): void => {
    executeTask = nextExecutor;
  };

  return {
    start,
    stop,
    syncAllProjects,
    syncProject,
    runNow,
    setExecutor,
    getStatus,
  };
};
