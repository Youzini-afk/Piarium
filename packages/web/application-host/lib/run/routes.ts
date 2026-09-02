import { isDocumentAuthorityError } from '../documents/errors.js';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { createDebugSupervisor } from './debug-supervisor.js';
import type { createWorkspaceTaskRunner } from './tasks.js';
import type { createTestSupervisor } from './test-supervisor.js';
import type { DebugBreakpointMutationRequest, DebugStartRequest } from './types.js';

interface UiAuthController {
  requireAuth?: RequestHandler;
}

interface RunRoutesOptions {
  debug: ReturnType<typeof createDebugSupervisor>;
  tasks: ReturnType<typeof createWorkspaceTaskRunner>;
  tests: ReturnType<typeof createTestSupervisor>;
  uiAuthController?: UiAuthController;
}

const sendError = (res: Response, error: unknown): Response => {
  if (isDocumentAuthorityError(error)) {
    return res.status(error.statusCode).json({
      error: error.message,
      reason: error.code,
    });
  }
  const message = error instanceof Error ? error.message : 'Run request failed';
  return res.status(500).json({ error: message, reason: 'failed' });
};

const readBody = (req: Request): Record<string, unknown> => (
  req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}
);

const debugStartRequest = (body: Record<string, unknown>): DebugStartRequest => ({
  workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : '',
  ...(typeof body.adapterId === 'string' ? { adapterId: body.adapterId } : {}),
  ...(typeof body.languageId === 'string' ? { languageId: body.languageId } : {}),
  ...(typeof body.program === 'string' ? { program: body.program } : {}),
});

const breakpointMutationRequest = (body: Record<string, unknown>): DebugBreakpointMutationRequest => {
  const observedSession = typeof body.expectedSessionId === 'string'
    && typeof body.expectedGeneration === 'number';
  const observedAbsence = body.expectedSessionId === null && body.expectedGeneration === null;
  if (!observedSession && !observedAbsence) {
    throw new Error('Breakpoint mutation requires an observed debug owner');
  }
  return {
    workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : '',
    resourceId: typeof body.resourceId === 'string' ? body.resourceId : '',
    lines: Array.isArray(body.lines)
      ? body.lines.filter((line): line is number => typeof line === 'number')
      : [],
    expectedSessionId: observedSession ? body.expectedSessionId as string : null,
    expectedGeneration: observedSession ? body.expectedGeneration as number : null,
  };
};

const streamEvents = <Event>(
  req: Request,
  res: Response,
  subscribe: (workspaceId: string, listener: (event: Event) => void) => { close(): void },
  workspaceId: string,
): Response | undefined => {
  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId is required', reason: 'failed' });
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let closed = false;
  const write = (event: Event): void => {
    if (closed || res.writableEnded || res.destroyed) return;
    if (event && typeof event === 'object' && Object.prototype.hasOwnProperty.call(event, 'content')) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const subscription = subscribe(workspaceId, write);
  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded || res.destroyed) return;
    try {
      res.write(': ping\n\n');
    } catch {
      closed = true;
    }
  }, 15000);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    subscription.close();
  };
  req.on('close', close);
  res.on('close', close);
  return undefined;
};

export const registerRunRoutes = (app: Express, {
  tasks,
  debug,
  tests,
  uiAuthController,
}: RunRoutesOptions): void => {
  const requireAuth = uiAuthController?.requireAuth
    ?? ((_req, _res, next) => next());

  app.post('/api/tasks/list', requireAuth, async (req, res) => {
    try {
      return res.json(await tasks.list(readBody(req).workspaceId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/tasks/run', requireAuth, async (req, res) => {
    try {
      return res.json(await tasks.run(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/tasks/cancel', requireAuth, async (req, res) => {
    try {
      return res.json(tasks.cancel(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/tasks/dispose-workspace', requireAuth, async (req, res) => {
    try {
      await tasks.disposeWorkspace(readBody(req).workspaceId);
      return res.json({ status: 'disposed' });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/tasks/events', requireAuth, (req, res) => {
    const workspaceId = typeof req.query?.workspaceId === 'string' ? req.query.workspaceId : '';
    return streamEvents(req, res, tasks.subscribe, workspaceId);
  });

  app.post('/api/debug/status', requireAuth, async (req, res) => {
    try {
      return res.json(debug.getStatus(readBody(req).workspaceId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/debug/breakpoints', requireAuth, async (req, res) => {
    try {
      const body = readBody(req);
      if (body.lines !== undefined) return res.json(debug.setBreakpoints(breakpointMutationRequest(body)));
      return res.json(debug.listBreakpoints(body.workspaceId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/debug/start', requireAuth, async (req, res) => {
    try {
      return res.json(await debug.start(debugStartRequest(readBody(req))));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/debug/stop', requireAuth, async (req, res) => {
    try {
      return res.json(await debug.stop(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/debug/control', requireAuth, async (req, res) => {
    try {
      const body = readBody(req);
      const method = typeof body.method === 'string' ? body.method : '';
      const allowed = new Set(['continue', 'pause', 'stepOver', 'stepIn', 'stepOut', 'getThreads', 'getStack', 'getScopes', 'getVariables', 'evaluate', 'listWatch', 'addWatch', 'removeWatch']);
      if (!allowed.has(method)) {
        return res.status(400).json({ error: 'Unknown debug control', reason: 'failed' });
      }
      const handler = Reflect.get(debug, method);
      if (typeof handler !== 'function') {
        return res.status(501).json({ error: 'Debug control is unavailable', reason: 'failed' });
      }
      return res.json(await Reflect.apply(handler, debug, [body.request ?? body]));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/debug/dispose-workspace', requireAuth, async (req, res) => {
    try {
      await debug.disposeWorkspace(readBody(req).workspaceId);
      return res.json({ status: 'disposed' });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/debug/events', requireAuth, (req, res) => {
    const workspaceId = typeof req.query?.workspaceId === 'string' ? req.query.workspaceId : '';
    return streamEvents(req, res, debug.subscribe, workspaceId);
  });

  app.post('/api/tests/discover', requireAuth, async (req, res) => {
    try {
      return res.json(await tests.discover(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/tests/run', requireAuth, async (req, res) => {
    try {
      return res.json(await tests.run(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/tests/cancel', requireAuth, async (req, res) => {
    try {
      return res.json(tests.cancel(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/tests/status', requireAuth, async (req, res) => {
    try {
      return res.json(tests.getStatus(readBody(req).workspaceId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/tests/dispose-workspace', requireAuth, async (req, res) => {
    try {
      await tests.disposeWorkspace(readBody(req).workspaceId);
      return res.json({ status: 'disposed' });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/tests/events', requireAuth, (req, res) => {
    const workspaceId = typeof req.query?.workspaceId === 'string' ? req.query.workspaceId : '';
    return streamEvents(req, res, tests.subscribe, workspaceId);
  });
};
