import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import path from 'node:path';
import { resolveTargetPort } from './cli-api-target.js';
import { parseGoalTokenBudget } from './cli-goal.js';
import { requestPiariumApi } from './cli-runtime.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  printJson,
  logStatus,
} from '../cli-output.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const assertRequired = (value, flagName) => {
  const normalized = asNonEmptyString(value);
  if (!normalized) {
    throw new TunnelCliError(`Missing required ${flagName}.`, EXIT_CODE.USAGE_ERROR);
  }
  return normalized;
};

const parseModel = (value) => {
  const model = assertRequired(value, '--model');
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) {
    throw new TunnelCliError('--model must be in provider/model format.', EXIT_CODE.USAGE_ERROR);
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
};

const parseThinkingLevel = (value) => {
  const level = asNonEmptyString(value);
  if (!level) return null;
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)) {
    throw new TunnelCliError('--thinking must be one of: off, minimal, low, medium, high, xhigh, max.', EXIT_CODE.USAGE_ERROR);
  }
  return level;
};

const parseWeekdays = (value) => {
  const weekdays = assertRequired(value, '--weekly')
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10));
  if (weekdays.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 6)) {
    throw new TunnelCliError('--weekly must contain weekdays from 0 to 6.', EXIT_CODE.USAGE_ERROR);
  }
  return Array.from(new Set(weekdays)).sort((left, right) => left - right);
};

const buildSchedule = (input) => {
  const daily = asNonEmptyString(input.daily);
  const weekly = asNonEmptyString(input.weekly);
  const once = asNonEmptyString(input.once);
  const cron = asNonEmptyString(input.cron);
  if ([daily, weekly, once, cron].filter(Boolean).length !== 1) {
    throw new TunnelCliError('Provide exactly one of --daily, --weekly, --once, or --cron.', EXIT_CODE.USAGE_ERROR);
  }
  const timezone = asNonEmptyString(input.timezone);
  if (daily) return { kind: 'daily', times: [daily], ...(timezone ? { timezone } : {}) };
  if (weekly) {
    const time = assertRequired(input.time, '--time');
    return { kind: 'weekly', weekdays: parseWeekdays(weekly), times: [time], ...(timezone ? { timezone } : {}) };
  }
  if (once) {
    const time = assertRequired(input.time, '--time');
    return { kind: 'once', date: once, time, ...(timezone ? { timezone } : {}) };
  }
  return { kind: 'cron', cron, ...(timezone ? { timezone } : {}) };
};

const buildScheduledTask = (input) => {
  const goalTokenBudget = input.goalTokenBudget;
  const thinkingLevel = parseThinkingLevel(input.thinkingLevel);
  return {
    name: assertRequired(input.name, '--name'),
    enabled: input.disabled !== true,
    schedule: buildSchedule(input),
    execution: {
      prompt: assertRequired(input.prompt, '--prompt'),
      ...parseModel(input.model),
      ...(asNonEmptyString(input.agent) ? { agent: input.agent.trim() } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(input.goal === true ? { runAsGoal: true } : {}),
      ...(goalTokenBudget !== undefined ? { goalTokenBudget } : {}),
    },
  };
};

const resolveProjectID = async (port, target, options) => {
  if (asNonEmptyString(target.projectId)) return target.projectId.trim();
  const directory = asNonEmptyString(target.directory);
  if (!directory) throw new TunnelCliError('Missing required --project or --dir.', EXIT_CODE.USAGE_ERROR);
  const settings = await requestPiariumApi(port, '/api/config/settings', options);
  const resolved = path.resolve(directory);
  const project = (Array.isArray(settings?.projects) ? settings.projects : [])
    .find((entry) => typeof entry?.path === 'string' && path.resolve(entry.path) === resolved);
  if (!project?.id) throw new TunnelCliError(`No Piarium project found for ${resolved}.`, EXIT_CODE.USAGE_ERROR);
  return project.id;
};

const formatGoal = (execution) => {
  if (execution?.runAsGoal !== true) return 'goal:no';
  return Number.isFinite(execution.goalTokenBudget)
    ? `goal:yes budget:${execution.goalTokenBudget}`
    : 'goal:yes';
};

const formatSchedule = (schedule) => {
  if (!schedule || typeof schedule !== 'object') return 'unknown';
  if (schedule.kind === 'daily') return `daily ${Array.isArray(schedule.times) ? schedule.times.join(',') : ''}`.trim();
  if (schedule.kind === 'weekly') return `weekly days:${Array.isArray(schedule.weekdays) ? schedule.weekdays.join(',') : ''} time:${Array.isArray(schedule.times) ? schedule.times.join(',') : ''}`;
  if (schedule.kind === 'once') return `once ${schedule.date || ''} ${schedule.time || ''}`.trim();
  if (schedule.kind === 'cron') return `cron ${schedule.cron || ''}`.trim();
  return schedule.kind || 'unknown';
};

const outputTasks = (options, tasks) => {
  const normalizedTasks = Array.isArray(tasks) ? tasks : [];
  if (isJsonMode(options)) {
    printJson({ tasks: normalizedTasks });
    return;
  }
  if (isQuietMode(options)) {
    for (const task of normalizedTasks) {
      process.stdout.write(`${task.id} enabled:${task.enabled === false ? 'no' : 'yes'} ${formatGoal(task.execution)} status:${task.state?.lastStatus || 'idle'} ${formatSchedule(task.schedule)} ${task.name || ''}\n`);
    }
    return;
  }

  clackIntro('Scheduled Tasks');
  if (normalizedTasks.length === 0) {
    logStatus('info', 'No scheduled tasks found');
    clackOutro('0 tasks');
    return;
  }
  for (const task of normalizedTasks) {
    const status = task.enabled === false ? 'warning' : 'success';
    const detail = `id: ${task.id}; ${formatGoal(task.execution)}; status: ${task.state?.lastStatus || 'idle'}; ${formatSchedule(task.schedule)}`;
    logStatus(status, task.name || task.id, detail);
  }
  clackOutro(`${normalizedTasks.length} task(s)`);
};

async function scheduleCommand(options = {}, action = 'help') {
  if (action === 'help') {
    process.stdout.write(`Piarium Schedule Commands\n\nUSAGE:\n  piarium schedule status [OPTIONS]\n  piarium schedule list (--project <projectId> | --dir <path>) [OPTIONS]\n  piarium schedule create (--project <projectId> | --dir <path>) --name <name> --prompt <prompt> --model <provider/model> (--daily <HH:mm> | --weekly <0,1,2> --time <HH:mm> | --once <YYYY-MM-DD> --time <HH:mm> | --cron <expr>) [OPTIONS]\n  piarium schedule run (--project <projectId> | --dir <path>) --task <taskId> [OPTIONS]\n  piarium schedule delete (--project <projectId> | --dir <path>) --task <taskId> [OPTIONS]\n  piarium schedule enable (--project <projectId> | --dir <path>) --task <taskId> [OPTIONS]\n  piarium schedule disable (--project <projectId> | --dir <path>) --task <taskId> [OPTIONS]\n\nOPTIONS:\n  --project <projectId>   Project id from piarium projects\n  --dir <path>            Resolve project by directory\n  -p, --port <port>       Piarium server port\n  --timezone <zone>       IANA timezone for created tasks\n  --agent <id>            Pi agent role/profile instruction\n  --thinking <level>      Pi thinking level\n  --goal                  Treat the scheduled run as an end-to-end goal\n  --goal-token-budget <n> Goal token budget (1000-100000000; requires --goal)\n  --disabled              Create task disabled\n  --json                  Output machine-readable JSON\n  -q, --quiet             Print concise output\n`);
    return;
  }

  const port = await resolveTargetPort(options);
  const target = {
    ...(asNonEmptyString(options.project) ? { projectId: options.project.trim() } : {}),
    ...(asNonEmptyString(options.directory) ? { directory: options.directory.trim() } : {}),
  };

  if (action === 'status') {
    const body = await requestPiariumApi(port, '/api/piarium/scheduled-tasks/status', options);
    if (isJsonMode(options)) {
      printJson(body || {});
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`enabled:${body?.enabledScheduledTasksCount ?? 0} running:${body?.runningScheduledTasksCount ?? 0}\n`);
      return;
    }
    clackIntro('Scheduled Task Status');
    logStatus(body?.hasEnabledScheduledTasks ? 'success' : 'info', `enabled: ${body?.enabledScheduledTasksCount ?? 0}`);
    logStatus(body?.hasRunningScheduledTasks ? 'success' : 'info', `running: ${body?.runningScheduledTasksCount ?? 0}`);
    clackOutro('status loaded');
    return;
  }

  if (action === 'list') {
    const projectID = await resolveProjectID(port, target, options);
    const body = await requestPiariumApi(port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks`, options);
    outputTasks(options, body?.tasks);
    return;
  }

  if (action === 'create') {
    const goalTokenBudget = parseGoalTokenBudget(options);
    const input = {
      ...target,
      name: options.name,
      prompt: options.prompt,
      model: options.model,
      daily: options.daily,
      weekly: options.weekly,
      once: options.once,
      time: options.time,
      cron: options.cron,
      timezone: options.timezone,
      agent: options.agent,
      thinkingLevel: options.thinking || options.variant,
      goal: options.goal === true,
      ...(goalTokenBudget !== undefined ? { goalTokenBudget } : {}),
      disabled: options.disabled === true,
    };
    const projectID = await resolveProjectID(port, target, options);
    const body = await requestPiariumApi(port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks`, {
      ...options,
      method: 'PUT',
      body: JSON.stringify({ task: buildScheduledTask(input) }),
    });
    if (isJsonMode(options)) {
      printJson({ task: body?.task, created: body?.created === true });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${body?.task?.id || ''}\n`);
      return;
    }
    clackIntro('Scheduled Task Created');
    logStatus('success', body?.task?.name || options.name, `id: ${body?.task?.id || 'unknown'}; ${formatGoal(body?.task?.execution)}; ${formatSchedule(body?.task?.schedule)}`);
    clackOutro('created');
    return;
  }

  if (action === 'run') {
    const taskID = assertRequired(options.task, '--task');
    const projectID = await resolveProjectID(port, target, options);
    const body = await requestPiariumApi(port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks/${encodeURIComponent(taskID)}/run`, {
      ...options,
      method: 'POST',
    });
    if (isJsonMode(options)) {
      printJson({ task: body?.task, sessionId: body?.sessionId });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${body?.sessionId || ''}\n`);
      return;
    }
    clackIntro('Scheduled Task Run');
    logStatus('success', body?.task?.name || taskID, `session: ${body?.sessionId || 'unknown'}`);
    clackOutro('started');
    return;
  }

  if (action === 'delete') {
    const taskID = assertRequired(options.task, '--task');
    const projectID = await resolveProjectID(port, target, options);
    const body = await requestPiariumApi(port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks/${encodeURIComponent(taskID)}`, {
      ...options,
      method: 'DELETE',
    });
    if (isJsonMode(options)) {
      printJson({ deleted: true, tasks: body?.tasks || [] });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`deleted ${taskID}\n`);
      return;
    }
    clackIntro('Scheduled Task Deleted');
    logStatus('success', `deleted ${taskID}`);
    clackOutro('deleted');
    return;
  }

  if (action === 'enable' || action === 'disable') {
    const taskID = assertRequired(options.task, '--task');
    const enabled = action === 'enable';
    const projectID = await resolveProjectID(port, target, options);
    const current = await requestPiariumApi(port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks`, options);
    const existing = (Array.isArray(current?.tasks) ? current.tasks : []).find((entry) => entry?.id === taskID);
    if (!existing) throw new TunnelCliError(`Scheduled task not found: ${taskID}`, EXIT_CODE.USAGE_ERROR);
    const { task } = await requestPiariumApi(port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks`, {
      ...options,
      method: 'PUT',
      body: JSON.stringify({ task: { ...existing, enabled } }),
    });
    if (isJsonMode(options)) {
      printJson({ task, enabled });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${taskID} enabled:${enabled ? 'yes' : 'no'}\n`);
      return;
    }
    clackIntro(enabled ? 'Scheduled Task Enabled' : 'Scheduled Task Disabled');
    logStatus('success', task?.name || taskID, `enabled: ${enabled ? 'yes' : 'no'}`);
    clackOutro(enabled ? 'enabled' : 'disabled');
    return;
  }

  throw new TunnelCliError(`Unknown schedule command '${action}'.`, EXIT_CODE.USAGE_ERROR);
}

export { scheduleCommand, formatGoal };
