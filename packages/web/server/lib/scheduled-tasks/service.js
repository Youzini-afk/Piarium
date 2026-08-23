import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  LoopRevisionConflictError,
  parseLoopContent,
  readLoopFile,
  setLoopFileEnabled,
  writeLoopFile,
} from './loops.js';

class ScheduledTaskError extends Error {
  constructor(message, statusCode = 500, details = {}) {
    super(message);
    this.name = 'ScheduledTaskError';
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const createScheduledTaskService = (dependencies) => {
  const {
    readSettingsFromDisk,
    sanitizeProjects,
    projectConfigRuntime,
    scheduledTasksRuntime,
  } = dependencies;

  const listProjects = async () => {
    const settings = await readSettingsFromDisk();
    return sanitizeProjects(settings?.projects || []);
  };

  const findProjectByID = async (projectID) => {
    const normalized = asNonEmptyString(projectID);
    if (!normalized) throw new ScheduledTaskError('projectId is required', 400);
    const projects = await listProjects();
    const project = projects.find((entry) => entry.id === normalized) || null;
    if (!project) throw new ScheduledTaskError('Project not found', 404);
    return project;
  };

  const resolveProjectID = async ({ projectId, directory } = {}) => {
    const requestedProjectID = asNonEmptyString(projectId);
    const requestedDirectory = asNonEmptyString(directory);
    if (requestedProjectID && requestedDirectory) {
      throw new ScheduledTaskError('Provide only one of projectId or directory', 400);
    }
    if (requestedProjectID) {
      await findProjectByID(requestedProjectID);
      return requestedProjectID;
    }
    if (!requestedDirectory) throw new ScheduledTaskError('projectId or directory is required', 400);
    const resolvedDirectory = path.resolve(requestedDirectory);
    const projects = await listProjects();
    const project = projects.find((entry) => path.resolve(entry.path) === resolvedDirectory);
    if (!project) throw new ScheduledTaskError(`Project not found for directory: ${resolvedDirectory}`, 404);
    return project.id;
  };

  const list = async (projectID) => {
    await findProjectByID(projectID);
    return scheduledTasksRuntime.syncProject(projectID);
  };

  const findLoopTask = async (projectID, taskID) => {
    await findProjectByID(projectID);
    const normalizedTaskID = asNonEmptyString(taskID);
    if (!normalizedTaskID) throw new ScheduledTaskError('taskId is required', 400);
    await scheduledTasksRuntime.syncProject(projectID);
    const tasks = await projectConfigRuntime.listScheduledTasks(projectID);
    const task = tasks.find((entry) => entry.id === normalizedTaskID);
    if (!task) throw new ScheduledTaskError('Task not found', 404);
    if (!task.loopFile) throw new ScheduledTaskError('Task is not managed by a loop file', 400);
    return task;
  };

  const readLoopDocument = async (projectID, taskID) => {
    const task = await findLoopTask(projectID, taskID);
    try {
      const document = await readLoopFile(task.loopFile);
      return {
        ...document,
        path: task.loopFile,
        scope: task.loopScope || 'project',
      };
    } catch (error) {
      if (error?.code === 'ENOENT') throw new ScheduledTaskError('Loop file not found', 404);
      throw new ScheduledTaskError(error instanceof Error ? error.message : 'Failed to read loop file', 500);
    }
  };

  const updateLoopDocument = async (projectID, taskID, { content, expectedRevision } = {}) => {
    if (typeof content !== 'string') throw new ScheduledTaskError('content is required', 400);
    const revision = asNonEmptyString(expectedRevision);
    if (!revision) throw new ScheduledTaskError('expectedRevision is required', 400);
    const parsed = parseLoopContent(content);
    if (!parsed.definition) throw new ScheduledTaskError(parsed.error || 'Loop file is invalid', 400);
    const task = await findLoopTask(projectID, taskID);
    try {
      await writeLoopFile(task.loopFile, content, { expectedRevision: revision });
    } catch (error) {
      if (error instanceof LoopRevisionConflictError) throw new ScheduledTaskError(error.message, 409);
      if (error?.code === 'ENOENT') throw new ScheduledTaskError('Loop file not found', 404);
      throw new ScheduledTaskError(error instanceof Error ? error.message : 'Failed to write loop file', 500);
    }
    const tasks = await scheduledTasksRuntime.syncProject(projectID);
    return {
      document: {
        ...await readLoopFile(task.loopFile),
        path: task.loopFile,
        scope: task.loopScope || 'project',
      },
      task: tasks.find((entry) => entry.id === taskID) || null,
    };
  };

  const setLoopEnabled = async (projectID, taskID, enabled, expectedRevision) => {
    if (typeof enabled !== 'boolean') throw new ScheduledTaskError('enabled must be a boolean', 400);
    const task = await findLoopTask(projectID, taskID);
    try {
      await setLoopFileEnabled(task.loopFile, enabled, {
        expectedRevision: asNonEmptyString(expectedRevision) || task.loopRevision,
      });
    } catch (error) {
      if (error instanceof LoopRevisionConflictError) throw new ScheduledTaskError(error.message, 409);
      if (error?.code === 'ENOENT') throw new ScheduledTaskError('Loop file not found', 404);
      const message = error instanceof Error ? error.message : 'Failed to update loop file';
      throw new ScheduledTaskError(message, message.toLowerCase().includes('frontmatter') || message.toLowerCase().includes('invalid') ? 400 : 500);
    }
    const tasks = await scheduledTasksRuntime.syncProject(projectID);
    return tasks.find((entry) => entry.id === taskID) || null;
  };

  const removeLoopFile = async (projectID, taskID, expectedRevision) => {
    const task = await findLoopTask(projectID, taskID);
    const revision = asNonEmptyString(expectedRevision) || task.loopRevision;
    try {
      const current = await readLoopFile(task.loopFile);
      if (revision && current.revision !== revision) {
        throw new LoopRevisionConflictError();
      }
      await fsPromises.unlink(task.loopFile);
    } catch (error) {
      if (error instanceof LoopRevisionConflictError) throw new ScheduledTaskError(error.message, 409);
      if (error?.code === 'ENOENT') throw new ScheduledTaskError('Loop file not found', 404);
      throw new ScheduledTaskError(error instanceof Error ? error.message : 'Failed to delete loop file', 500);
    }
    return scheduledTasksRuntime.syncProject(projectID);
  };

  const upsert = async (projectID, taskInput) => {
    await findProjectByID(projectID);
    if (!taskInput || typeof taskInput !== 'object') {
      throw new ScheduledTaskError('task payload is required', 400);
    }
    if (
      taskInput.loopFile !== undefined
      || taskInput.loopScope !== undefined
      || taskInput.loopRevision !== undefined
      || taskInput.loopError !== undefined
      || taskInput.loopShadowed !== undefined
    ) {
      throw new ScheduledTaskError('Loop metadata is managed by Piarium', 400);
    }
    const incomingID = asNonEmptyString(taskInput.id);
    if (incomingID) {
      const current = await projectConfigRuntime.listScheduledTasks(projectID);
      if (current.some((task) => task.id === incomingID && task.loopFile)) {
        throw new ScheduledTaskError('Loop tasks must be edited through their Markdown file', 400);
      }
    }
    let upserted;
    try {
      upserted = await projectConfigRuntime.upsertScheduledTask(projectID, taskInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save scheduled task';
      const invalid = message.toLowerCase().includes('required') || message.toLowerCase().includes('invalid');
      throw new ScheduledTaskError(message, invalid ? 400 : 500);
    }
    await scheduledTasksRuntime.syncProject(projectID);
    const tasks = await projectConfigRuntime.listScheduledTasks(projectID);
    return {
      tasks,
      task: tasks.find((task) => task.id === upserted.task.id) || upserted.task,
      created: upserted.created,
    };
  };

  const remove = async (projectID, taskID) => {
    await findProjectByID(projectID);
    const normalizedTaskID = asNonEmptyString(taskID);
    if (!normalizedTaskID) throw new ScheduledTaskError('taskId is required', 400);
    const current = await projectConfigRuntime.listScheduledTasks(projectID);
    const existing = current.find((task) => task.id === normalizedTaskID);
    if (existing?.loopFile) {
      try {
        await fsPromises.access(existing.loopFile);
        throw new ScheduledTaskError('Loop tasks must be deleted through their Markdown file', 400);
      } catch (error) {
        if (error instanceof ScheduledTaskError) throw error;
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    const result = await projectConfigRuntime.deleteScheduledTask(projectID, normalizedTaskID);
    if (!result.deleted) throw new ScheduledTaskError('Task not found', 404);
    await scheduledTasksRuntime.syncProject(projectID);
    return projectConfigRuntime.listScheduledTasks(projectID);
  };

  const run = async (projectID, taskID) => {
    await findProjectByID(projectID);
    const normalizedTaskID = asNonEmptyString(taskID);
    if (!normalizedTaskID) throw new ScheduledTaskError('taskId is required', 400);
    const result = await scheduledTasksRuntime.runNow(projectID, normalizedTaskID);
    if (result.running || result.queued) {
      throw new ScheduledTaskError(result.error || 'Task already running', 409);
    }
    if (result.skipped) throw new ScheduledTaskError('Task not found or disabled', 404);
    if (!result.ok) {
      throw new ScheduledTaskError(result.error || 'Task run failed', 500, { task: result.task });
    }
    return { task: result.task, sessionId: result.sessionID };
  };

  const setEnabled = async (projectID, taskID, enabled) => {
    const tasks = await list(projectID);
    const task = tasks.find((entry) => entry?.id === taskID);
    if (!task) throw new ScheduledTaskError('Task not found', 404);
    if (task.loopFile) {
      return setLoopEnabled(projectID, taskID, enabled, task.loopRevision);
    }
    const result = await upsert(projectID, { ...task, enabled });
    return result.task;
  };

  const status = async () => {
    if (typeof scheduledTasksRuntime.getStatus === 'function') {
      return scheduledTasksRuntime.getStatus();
    }
    const projects = await listProjects();
    let enabledCount = 0;
    let runningCount = 0;
    for (const project of projects) {
      try {
        const tasks = await projectConfigRuntime.listScheduledTasks(project.id);
        for (const task of tasks) {
          if (task?.enabled) enabledCount += 1;
          if (task?.state?.lastStatus === 'running') runningCount += 1;
        }
      } catch {
      }
    }
    return {
      hasEnabledScheduledTasks: enabledCount > 0,
      hasRunningScheduledTasks: runningCount > 0,
      enabledScheduledTasksCount: enabledCount,
      runningScheduledTasksCount: runningCount,
    };
  };

  return {
    listProjects,
    resolveProjectID,
    list,
    upsert,
    remove,
    run,
    setEnabled,
    readLoopDocument,
    updateLoopDocument,
    setLoopEnabled,
    removeLoopFile,
    status,
  };
};
