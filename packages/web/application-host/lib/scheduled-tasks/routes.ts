import type { Express, Request, Response } from 'express';
import { createScheduledTaskService } from './service.js';

type ServiceDependencies = Parameters<typeof createScheduledTaskService>[0];

interface ScheduledTaskRouteDependencies extends ServiceDependencies {
  scheduledTaskService?: ReturnType<typeof createScheduledTaskService>;
}

export interface PiariumEventRouteDependencies {
  getPiariumEventClients: () => Set<Response>;
  writeSseEvent: (res: Response, event: { properties: Record<string, unknown>; type: string }) => void;
  /**
   * Optional surface bridge (Stage S): when present, `?surface=<id>&kind=<kind>`
   * on the events stream registers a targetable surface connection, and the
   * ack route resolves pending client-settings requests.
   */
  surfaceBridge?: {
    attach(res: Response, surfaceId: string, kind: string): void;
    dropConnection(res: Response): void;
    ack(requestId: string, results: unknown): boolean;
  };
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const errorRecord = (value: unknown): Record<string, unknown> => asRecord(value) ?? {};

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseProjectID = (req: Request) => asNonEmptyString(req.params.projectId);
const parseTaskID = (req: Request) => asNonEmptyString(req.params.taskId);

export const registerPiariumEventRoutes = (
  app: Express,
  { getPiariumEventClients, writeSseEvent, surfaceBridge }: PiariumEventRouteDependencies,
): void => {
  app.get('/api/piarium/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const clients = getPiariumEventClients();
    clients.add(res);
    // A surface that identifies itself becomes individually addressable for
    // client-owned settings applies (Stage S). Anonymous connections stay
    // broadcast-only — the host never invents a client identity.
    const surfaceId = asNonEmptyString(req.query?.surface);
    const surfaceKind = asNonEmptyString(req.query?.kind);
    if (surfaceId && surfaceBridge) {
      surfaceBridge.attach(res, surfaceId, surfaceKind ?? 'web');
    }
    try {
      writeSseEvent(res, {
        type: 'piarium:event-stream-ready',
        properties: { connectedAt: Date.now() },
      });
    } catch {
      // The client can reconnect and receive the next heartbeat.
    }

    const heartbeat = setInterval(() => {
      try {
        writeSseEvent(res, {
          type: 'piarium:heartbeat',
          properties: { timestamp: Date.now() },
        });
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
        surfaceBridge?.dropConnection(res);
      }
    }, 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
      surfaceBridge?.dropConnection(res);
    });
  });

  if (surfaceBridge) {
    app.post('/api/piarium/client-settings/ack', (req, res) => {
      const body = asRecord(req.body) ?? {};
      const requestId = asNonEmptyString(body.requestId);
      const results = Array.isArray(body.results) ? body.results : [];
      if (!requestId) {
        return res.status(400).json({ error: 'requestId is required' });
      }
      const resolved = surfaceBridge.ack(requestId, results as never);
      if (!resolved) {
        return res.status(404).json({ error: 'no pending client-settings request for this id' });
      }
      return res.json({ ok: true });
    });
  }
};

export const registerScheduledTaskRoutes = (app: Express, dependencies: ScheduledTaskRouteDependencies): void => {
  const {
    scheduledTaskService = createScheduledTaskService(dependencies),
  } = dependencies;

  app.get('/api/projects/:projectId/scheduled-tasks', async (req, res) => {
    const projectID = parseProjectID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    try {
      const tasks = await scheduledTaskService.list(projectID);
      return res.json({ tasks });
    } catch (error) {
      const failure = errorRecord(error);
      if (typeof failure.statusCode === 'number') return res.status(failure.statusCode).json({ error: failure.message });
      console.error('[ScheduledTasks] failed to load tasks:', error);
      return res.status(500).json({ error: 'Failed to load scheduled tasks' });
    }
  });

  app.put('/api/projects/:projectId/scheduled-tasks', async (req, res) => {
    const projectID = parseProjectID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const taskInput = asRecord(req.body)?.task;
    if (!taskInput || typeof taskInput !== 'object') {
      return res.status(400).json({ error: 'task payload is required' });
    }

    try {
      return res.json(await scheduledTaskService.upsert(projectID, taskInput));
    } catch (error) {
      const failure = errorRecord(error);
      if (typeof failure.statusCode === 'number') return res.status(failure.statusCode).json({ error: failure.message });
      const message = error instanceof Error ? error.message : 'Failed to save scheduled task';
      const statusCode = message.toLowerCase().includes('required') || message.toLowerCase().includes('invalid')
        ? 400
        : 500;
      if (statusCode === 500) {
        console.error('[ScheduledTasks] failed to save task:', error);
      }
      return res.status(statusCode).json({ error: message });
    }
  });

  app.delete('/api/projects/:projectId/scheduled-tasks/:taskId', async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!taskID) {
      return res.status(400).json({ error: 'taskId is required' });
    }

    try {
      return res.json({ tasks: await scheduledTaskService.remove(projectID, taskID) });
    } catch (error) {
      const failure = errorRecord(error);
      if (typeof failure.statusCode === 'number') return res.status(failure.statusCode).json({ error: failure.message });
      console.error('[ScheduledTasks] failed to delete task:', error);
      return res.status(500).json({ error: 'Failed to delete scheduled task' });
    }
  });

  app.get('/api/projects/:projectId/scheduled-tasks/:taskId/loop-file', async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) return res.status(400).json({ error: 'projectId is required' });
    if (!taskID) return res.status(400).json({ error: 'taskId is required' });
    try {
      return res.json({ document: await scheduledTaskService.readLoopDocument(projectID, taskID) });
    } catch (error) {
      const failure = errorRecord(error);
      if (typeof failure.statusCode === 'number') return res.status(failure.statusCode).json({ error: failure.message });
      console.error('[ScheduledTasks] failed to read loop file:', error);
      return res.status(500).json({ error: 'Failed to read loop file' });
    }
  });

  app.put('/api/projects/:projectId/scheduled-tasks/:taskId/loop-file', async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) return res.status(400).json({ error: 'projectId is required' });
    if (!taskID) return res.status(400).json({ error: 'taskId is required' });
    try {
      return res.json(await scheduledTaskService.updateLoopDocument(projectID, taskID, req.body));
    } catch (error) {
      const failure = errorRecord(error);
      if (typeof failure.statusCode === 'number') return res.status(failure.statusCode).json({ error: failure.message });
      console.error('[ScheduledTasks] failed to write loop file:', error);
      return res.status(500).json({ error: 'Failed to write loop file' });
    }
  });

  app.patch('/api/projects/:projectId/scheduled-tasks/:taskId/loop-file', async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) return res.status(400).json({ error: 'projectId is required' });
    if (!taskID) return res.status(400).json({ error: 'taskId is required' });
    try {
      const task = await scheduledTaskService.setLoopEnabled(
        projectID,
        taskID,
        req.body?.enabled,
        req.body?.expectedRevision,
      );
      return res.json({ task });
    } catch (error) {
      const failure = errorRecord(error);
      if (typeof failure.statusCode === 'number') return res.status(failure.statusCode).json({ error: failure.message });
      console.error('[ScheduledTasks] failed to update loop file:', error);
      return res.status(500).json({ error: 'Failed to update loop file' });
    }
  });

  app.delete('/api/projects/:projectId/scheduled-tasks/:taskId/loop-file', async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) return res.status(400).json({ error: 'projectId is required' });
    if (!taskID) return res.status(400).json({ error: 'taskId is required' });
    try {
      return res.json({
        tasks: await scheduledTaskService.removeLoopFile(projectID, taskID, req.body?.expectedRevision),
      });
    } catch (error) {
      const failure = errorRecord(error);
      if (typeof failure.statusCode === 'number') return res.status(failure.statusCode).json({ error: failure.message });
      console.error('[ScheduledTasks] failed to delete loop file:', error);
      return res.status(500).json({ error: 'Failed to delete loop file' });
    }
  });

  app.post('/api/projects/:projectId/scheduled-tasks/:taskId/run', async (req, res) => {
    const projectID = parseProjectID(req);
    const taskID = parseTaskID(req);
    if (!projectID) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!taskID) {
      return res.status(400).json({ error: 'taskId is required' });
    }

    try {
      return res.json({ ok: true, ...await scheduledTaskService.run(projectID, taskID) });
    } catch (error) {
      const failure = errorRecord(error);
      if (typeof failure.statusCode === 'number') return res.status(failure.statusCode).json({ error: failure.message, ...(failure.task ? { task: failure.task } : {}) });
      console.error('[ScheduledTasks] failed to run task:', error);
      return res.status(500).json({ error: 'Failed to run scheduled task' });
    }
  });

  app.get('/api/piarium/scheduled-tasks/status', async (_req, res) => {
    try {
      return res.json(await scheduledTaskService.status());
    } catch (error) {
      console.error('[ScheduledTasks] failed to resolve scheduled task status:', error);
      return res.status(500).json({ error: 'Failed to resolve scheduled task status' });
    }
  });

};
