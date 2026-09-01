import { isDocumentAuthorityError } from './errors.js';

// Minimal Express-like types (avoids dependency on @types/express)
interface ExpressRequest {
  body?: unknown;
  query?: Record<string, unknown>;
  on(event: string, listener: () => void): void;
}

interface ExpressResponse {
  status(code: number): ExpressResponse;
  json(data: unknown): ExpressResponse;
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(data: string): boolean;
  writableEnded: boolean;
  destroyed: boolean;
  on(event: string, listener: () => void): void;
  flush?: () => void;
}

type Middleware = (req: ExpressRequest, res: ExpressResponse, next: () => void) => void;
type RouteHandler = (req: ExpressRequest, res: ExpressResponse) => void | Promise<void>;

interface ExpressApp {
  post(path: string, ...handlers: (Middleware | RouteHandler)[]): void;
  get(path: string, ...handlers: (Middleware | RouteHandler)[]): void;
}

interface DocumentAuthority {
  resolveWorkspace(input: unknown): Promise<unknown>;
  read(resource: unknown): Promise<unknown>;
  write(request: unknown): Promise<unknown>;
  move(request: unknown): Promise<unknown>;
  delete(request: unknown): Promise<unknown>;
  publishDirtyBuffers(request: unknown): Promise<unknown>;
  clearDirtyBuffers(request: unknown): Promise<unknown>;
  acknowledgeDirtyStateBarrier(request: unknown): Promise<unknown>;
  inspectWorkspace(workspaceId: string): Promise<unknown>;
  watch(workspaceId: string, listener: (event: unknown) => void): { close(): void };
  registerDirtySurface(request: unknown, listener: (event: unknown) => void): { close(): void };
  listRecoveryJournals(request: unknown): Promise<unknown>;
  readRecoveryJournal(journalId: string): Promise<unknown>;
  writeRecoveryJournal(request: unknown): Promise<unknown>;
  deleteRecoveryJournal(request: unknown): Promise<unknown>;
}

interface UiAuthController {
  requireAuth?: Middleware;
}

interface DocumentRoutesOptions {
  documents: DocumentAuthority;
  uiAuthController?: UiAuthController;
}

const sendError = (res: ExpressResponse, error: unknown): ExpressResponse => {
  if (isDocumentAuthorityError(error)) {
    return res.status(error.statusCode).json({
      error: error.message,
      reason: error.code,
      ...(error.currentEpoch ? { currentEpoch: error.currentEpoch } : {}),
    });
  }
  const message = error instanceof Error ? error.message : 'Document request failed';
  return res.status(500).json({ error: message, reason: 'failed' });
};

const readBody = (req: ExpressRequest): Record<string, unknown> => (
  req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}
);

export const registerDocumentRoutes = (app: ExpressApp, {
  documents,
  uiAuthController,
}: DocumentRoutesOptions) => {
  const requireAuth: Middleware = uiAuthController?.requireAuth
    ?? ((_req, _res, next) => next());

  app.post('/api/documents/workspace/resolve', requireAuth, async (req: ExpressRequest, res: ExpressResponse) => {
    try {
      return res.json(await documents.resolveWorkspace(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/read', requireAuth, async (req: ExpressRequest, res: ExpressResponse) => {
    try {
      const resource = readBody(req).resource;
      if (!resource) return res.status(400).json({ error: 'Resource is required', reason: 'failed' });
      return res.json(await documents.read(resource));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/write', requireAuth, async (req: ExpressRequest, res: ExpressResponse) => {
    try {
      return res.json(await documents.write(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/move', requireAuth, async (req: ExpressRequest, res: ExpressResponse) => {
    try {
      return res.json(await documents.move(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/delete', requireAuth, async (req: ExpressRequest, res: ExpressResponse) => {
    try {
      return res.json(await documents.delete(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/dirty/publish', requireAuth, async (req: ExpressRequest, res: ExpressResponse) => {
    try {
      return res.json(await documents.publishDirtyBuffers(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/dirty/clear', requireAuth, async (req: ExpressRequest, res: ExpressResponse) => {
    try {
      return res.json(await documents.clearDirtyBuffers(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/dirty/barrier/ack', requireAuth, async (req: ExpressRequest, res: ExpressResponse) => {
    try {
      return res.json(await documents.acknowledgeDirtyStateBarrier(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/documents/watch', requireAuth, async (req: ExpressRequest, res: ExpressResponse) => {
    const workspaceId = typeof req.query?.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId is required', reason: 'failed' });
    }
    const dirtyOwnerId = typeof req.query?.dirtyOwnerId === 'string' ? req.query.dirtyOwnerId : '';
    const dirtyOwnerGenerationRaw = typeof req.query?.dirtyOwnerGeneration === 'string'
      ? req.query.dirtyOwnerGeneration
      : '';
    const dirtyOwnerGeneration = dirtyOwnerGenerationRaw === '' ? null : Number(dirtyOwnerGenerationRaw);
    if ((dirtyOwnerId && dirtyOwnerGeneration === null)
      || (!dirtyOwnerId && dirtyOwnerGeneration !== null)
      || (dirtyOwnerGeneration !== null && (!Number.isSafeInteger(dirtyOwnerGeneration) || dirtyOwnerGeneration < 0))) {
      return res.status(400).json({ error: 'Dirty owner identity is malformed', reason: 'failed' });
    }

    try {
      await documents.inspectWorkspace(workspaceId);
    } catch (error) {
      return sendError(res, error);
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded || res.destroyed) return;
      try {
        res.write(':heartbeat\n\n');
        res.flush?.();
      } catch {
        closed = true;
      }
    }, 15000);

    const sendEvent = (event: unknown) => {
      if (closed) return;
      try {
        const payload = JSON.stringify(event);
        if (payload.includes('"content":')) return;
        res.write(`data: ${payload}\n\n`);
        res.flush?.();
      } catch {
        closed = true;
      }
    };
    const subscription = documents.watch(workspaceId, sendEvent);
    const dirtySubscription = dirtyOwnerId
      ? documents.registerDirtySurface({
          generation: dirtyOwnerGeneration,
          ownerId: dirtyOwnerId,
          workspaceId,
        }, sendEvent)
      : null;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      subscription.close();
      dirtySubscription?.close();
    };

    req.on('close', cleanup);
    res.on('error', cleanup);
    return undefined;
  });

  app.post('/api/documents/recovery/list', requireAuth, async (req: ExpressRequest, res: ExpressResponse) => {
    try {
      return res.json({ journals: await documents.listRecoveryJournals(readBody(req)) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/recovery/read', requireAuth, async (req: ExpressRequest, res: ExpressResponse) => {
    try {
      const journalId = readBody(req).journalId;
      if (typeof journalId !== 'string' || !journalId) {
        return res.status(400).json({ error: 'journalId is required', reason: 'failed' });
      }
      return res.json(await documents.readRecoveryJournal(journalId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/recovery/write', requireAuth, async (req: ExpressRequest, res: ExpressResponse) => {
    try {
      return res.json(await documents.writeRecoveryJournal(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/recovery/delete', requireAuth, async (req: ExpressRequest, res: ExpressResponse) => {
    try {
      return res.json(await documents.deleteRecoveryJournal(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });
};
