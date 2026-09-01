import { isDocumentAuthorityError } from '../documents/errors.js';

const sendError = (res, error) => {
  if (isDocumentAuthorityError(error)) {
    return res.status(error.statusCode).json({
      error: error.message,
      reason: error.code,
    });
  }
  const message = error instanceof Error ? error.message : 'Language request failed';
  return res.status(500).json({ error: message, reason: 'failed' });
};

const readBody = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

const FEATURES = new Set([
  'completion',
  'completionResolve',
  'hover',
  'signatureHelp',
  'definition',
  'references',
  'documentSymbols',
  'workspaceSymbols',
  'rename',
  'codeActions',
  'codeActionResolve',
  'executeCommand',
  'documentFormatting',
  'documentRangeFormatting',
  'onTypeFormatting',
  'semanticTokens',
  'inlayHints',
  'inlayHintResolve',
  'documentHighlights',
  'foldingRanges',
  'selectionRanges',
  'documentLinks',
  'documentLinkResolve',
  'documentColors',
  'colorPresentations',
]);

export const registerLanguageRoutes = (app, {
  language,
  uiAuthController,
}) => {
  const requireAuth = uiAuthController?.requireAuth
    ?? ((_req, _res, next) => next());

  app.post('/api/language/status', requireAuth, async (req, res) => {
    try {
      const body = readBody(req);
      return res.json(language.getStatus(body.workspaceId, body.languageId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/language/sync', requireAuth, async (req, res) => {
    try {
      return res.json(await language.syncDocument(readBody(req)));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/language/feature', requireAuth, async (req, res) => {
    try {
      const body = readBody(req);
      const method = typeof body.method === 'string' ? body.method : '';
      if (!FEATURES.has(method)) {
        return res.status(400).json({ error: 'Unknown language feature', reason: 'failed' });
      }
      return res.json(await language[method](body.request ?? {}));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/language/restart', requireAuth, async (req, res) => {
    try {
      const body = readBody(req);
      return res.json(await language.restart(body.workspaceId, body.languageId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/language/dispose-workspace', requireAuth, async (req, res) => {
    try {
      await language.disposeWorkspace(readBody(req).workspaceId);
      return res.json({ status: 'disposed' });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/language/events', requireAuth, async (req, res) => {
    const workspaceId = typeof req.query?.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId is required', reason: 'failed' });
    }
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    let closed = false;
    const write = (event) => {
      if (closed || res.writableEnded || res.destroyed) return;
      const payload = JSON.stringify(event);
      if (event && typeof event === 'object' && Object.prototype.hasOwnProperty.call(event, 'content')) return;
      res.write(`data: ${payload}\n\n`);
    };
    const subscription = language.subscribe(workspaceId, write);
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
  });
};
