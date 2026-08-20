type CompanionUriTarget =
  | { action: 'focus' }
  | { action: 'session'; sessionId: string }
  | { action: 'unknown'; path: string };

const normalizePath = (value: string): string => (
  value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase()
);

export const parseCompanionUri = (uri: { path: string; query: string }): CompanionUriTarget => {
  const path = normalizePath(uri.path);
  if (path !== '' && path !== 'chat') {
    return { action: 'unknown', path: uri.path.trim() || '/' };
  }
  const sessionId = new URLSearchParams(uri.query).get('session')?.trim();
  if (sessionId) return { action: 'session', sessionId };
  return { action: 'focus' };
};
