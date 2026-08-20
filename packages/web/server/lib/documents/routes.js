import { isDocumentAuthorityError } from './errors.js';

const sendError = (res, error) => {
  if (isDocumentAuthorityError(error)) {
    return res.status(error.statusCode).json({
      error: error.message,
      reason: error.code,
    });
  }
  const message = error instanceof Error ? error.message : 'Document request failed';
  return res.status(500).json({ error: message, reason: 'failed' });
};

const readBody = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

export const registerDocumentRoutes = (app, {
  documents,
  uiAuthController,
}) => {
  const requireAuth = uiAuthController?.requireAuth
    ?? ((_req, _res, next) => next());

  app.post('/api/documents/workspace/resolve', requireAuth, async (req, res) => {
    try {
      return res.json(await documents.resolveWorkspace(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/read', requireAuth, async (req, res) => {
    try {
      const resource = readBody(req).resource;
      if (!resource) return res.status(400).json({ error: 'Resource is required', reason: 'failed' });
      return res.json(await documents.read(resource));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/write', requireAuth, async (req, res) => {
    try {
      return res.json(await documents.write(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/move', requireAuth, async (req, res) => {
    try {
      return res.json(await documents.move(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/delete', requireAuth, async (req, res) => {
    try {
      return res.json(await documents.delete(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/documents/watch', requireAuth, async (req, res) => {
    const workspaceId = typeof req.query?.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId is required', reason: 'failed' });
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
    res.flushHeaders?.();

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

    const subscription = documents.watch(workspaceId, (event) => {
      if (closed) return;
      try {
        const payload = JSON.stringify(event);
        if (payload.includes('"content":')) return;
        res.write(`data: ${payload}\n\n`);
        res.flush?.();
      } catch {
        closed = true;
      }
    });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      subscription.close();
    };

    req.on('close', cleanup);
    res.on('error', cleanup);
    return undefined;
  });

  app.post('/api/documents/recovery/list', requireAuth, async (req, res) => {
    try {
      return res.json({ journals: await documents.listRecoveryJournals(readBody(req)) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/recovery/read', requireAuth, async (req, res) => {
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

  app.post('/api/documents/recovery/write', requireAuth, async (req, res) => {
    try {
      return res.json(await documents.writeRecoveryJournal(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/documents/recovery/delete', requireAuth, async (req, res) => {
    try {
      return res.json(await documents.deleteRecoveryJournal(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });
};
