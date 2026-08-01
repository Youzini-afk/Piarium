export type EmbeddedSessionChatConfig = {
  sessionId: string;
  directory: string | null;
  readOnly: boolean;
};

const EMBEDDED_SESSION_CHAT_PANEL = 'session-chat';

export const normalizeEmbeddedSessionDirectory = (value: string | null | undefined): string => {
  if (!value) return '';
  return value.replace(/\\/g, '/').replace(/\/+$/g, '');
};

export const buildEmbeddedSessionChatURL = ({
  sessionId,
  directory,
  readOnly,
  basePath,
  origin,
}: EmbeddedSessionChatConfig & {
  basePath?: string;
  origin?: string;
}): string => {
  const resolvedOrigin = origin ?? (typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
  const resolvedPath = basePath ?? (typeof window === 'undefined' ? '/' : window.location.pathname);
  const url = new URL(resolvedPath, resolvedOrigin);
  url.searchParams.set('surface', 'desktop');
  url.searchParams.set('ocPanel', EMBEDDED_SESSION_CHAT_PANEL);
  url.searchParams.set('ocSessionId', sessionId);
  if (readOnly) {
    url.searchParams.set('ocReadOnly', '1');
  }
  if (directory && directory.trim().length > 0) {
    url.searchParams.set('ocDirectory', directory.trim());
  }
  url.hash = '';
  return url.toString();
};

export const readEmbeddedSessionChatConfigFromParams = (params: URLSearchParams): EmbeddedSessionChatConfig | null => {
  if (params.get('ocPanel') !== EMBEDDED_SESSION_CHAT_PANEL) {
    return null;
  }

  const sessionIdRaw = params.get('ocSessionId') ?? params.get('sessionId');
  const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
  if (!sessionId) {
    return null;
  }

  const directoryRaw = params.get('ocDirectory') ?? params.get('directory');
  const directory = typeof directoryRaw === 'string' && directoryRaw.trim().length > 0
    ? directoryRaw.trim()
    : null;

  return {
    sessionId,
    directory,
    readOnly: params.get('ocReadOnly') === '1'
      || params.get('ocReadOnly') === 'true'
      || params.get('readOnly') === '1'
      || params.get('readOnly') === 'true',
  };
};

export const readEmbeddedSessionChatConfigFromSearch = (search: string): EmbeddedSessionChatConfig | null => {
  return readEmbeddedSessionChatConfigFromParams(new URLSearchParams(search));
};

export const readEmbeddedSessionChatConfig = (): EmbeddedSessionChatConfig | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  return readEmbeddedSessionChatConfigFromSearch(window.location.search);
};

export const shouldConsumeSessionUrlParams = (params: URLSearchParams): boolean => {
  if (params.get('ocPanel') === EMBEDDED_SESSION_CHAT_PANEL) {
    return false;
  }

  const sessionId = (params.get('session') ?? params.get('sessionId') ?? '').trim();
  return sessionId.length > 0;
};

export const isEmbeddedSessionChatReady = ({
  embeddedSessionChat,
  currentSessionId,
  currentDirectory,
}: {
  embeddedSessionChat: EmbeddedSessionChatConfig;
  currentSessionId: string | null | undefined;
  currentDirectory: string | null | undefined;
}): boolean => {
  const expectedDirectory = normalizeEmbeddedSessionDirectory(embeddedSessionChat.directory);
  const activeDirectory = normalizeEmbeddedSessionDirectory(currentDirectory);
  if (expectedDirectory && activeDirectory !== expectedDirectory) {
    return false;
  }
  return currentSessionId === embeddedSessionChat.sessionId;
};
