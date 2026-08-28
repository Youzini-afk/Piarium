declare const acquireVsCodeApi: () => {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

interface VSCodeAPI {
  postMessage: (message: unknown) => void;
}

let vscodeApi: VSCodeAPI | null = null;
let noopWarned = false;

const noopVSCodeApi: VSCodeAPI = {
  postMessage: (message) => {
    // acquireVsCodeApi() can return undefined in broken/non-standard webview slots
    // (Cursor after extension update, VSCodium, headless). Drop the message instead
    // of throwing TypeError: Cannot read properties of undefined (reading 'postMessage').
    if (!noopWarned) {
      noopWarned = true;
      console.warn('[piarium] VS Code API unavailable; dropping postMessage', message);
    }
  },
};

export function getVSCodeAPI(): VSCodeAPI {
  if (!vscodeApi) {
    const acquired = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
    vscodeApi = acquired ?? noopVSCodeApi;
  }
  return vscodeApi;
}

interface BridgeRequest {
  id: string;
  type: string;
  payload?: unknown;
}

interface BridgeResponse {
  id: string;
  type: string;
  success: boolean;
  data?: unknown;
  error?: string;
  reason?: string;
  status?: number;
}

const pendingRequests = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}>();

let requestIdCounter = 0;

window.addEventListener('message', (event: MessageEvent<BridgeResponse>) => {
  const response = event.data;
  if (!response || typeof response.id !== 'string') return;

  const messageId = (response as BridgeResponse & { _msgId?: unknown })._msgId;
  if (typeof messageId === 'string' && messageId.length > 0) {
    getVSCodeAPI().postMessage({ type: 'bridge:ack', _msgId: messageId });
  }

  const pending = pendingRequests.get(response.id);
  if (pending) {
    pendingRequests.delete(response.id);
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (pending.onAbort) {
      pending.onAbort();
    }
    if (response.success) {
      pending.resolve(response.data);
    } else {
      const error = new Error(response.error || 'Unknown error') as Error & {
        reason?: unknown;
        status?: unknown;
      };
      if (typeof response.reason === 'string') error.reason = response.reason;
      if (typeof response.status === 'number' && Number.isFinite(response.status)) {
        error.status = response.status;
      }
      pending.reject(error);
    }
  }
});

export function sendBridgeMessage<T = unknown>(type: string, payload?: unknown): Promise<T> {
  return sendBridgeMessageWithOptions<T>(type, payload);
}

export function sendBridgeMessageWithOptions<T = unknown>(
  type: string,
  payload?: unknown,
  options?: { timeoutMs?: number; signal?: AbortSignal; onAbort?: (id: string) => void }
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = `req_${++requestIdCounter}_${Date.now()}`;
    const request: BridgeRequest = { id, type, payload };

    const pending: {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timeout?: ReturnType<typeof setTimeout>;
      onAbort?: () => void;
    } = {
      resolve: resolve as (value: unknown) => void,
      reject,
    };

    if (options?.signal) {
      const abort = () => {
        if (!pendingRequests.has(id)) return;
        pendingRequests.delete(id);
        if (pending.timeout) {
          clearTimeout(pending.timeout);
        }
        options.onAbort?.(id);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (options.signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      options.signal.addEventListener('abort', abort, { once: true });
      pending.onAbort = () => options.signal?.removeEventListener('abort', abort);
    }

    pendingRequests.set(id, pending);

    const timeoutMs = typeof options?.timeoutMs === 'number' ? options.timeoutMs : 30000;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      pending.timeout = setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          if (pending.onAbort) {
            pending.onAbort();
          }
          reject(new Error(`Request ${type} timed out`));
        }
      }, timeoutMs);
    }

    getVSCodeAPI().postMessage(request);
  });
}

export async function executeVSCodeCommand(command: string, args?: unknown[]): Promise<{ result?: unknown }> {
  return sendBridgeMessage<{ result?: unknown }>('vscode:command', { command, args });
}

export async function openVSCodeExternalUrl(url: string): Promise<void> {
  await sendBridgeMessage('vscode:openExternalUrl', { url });
}

type CommandHandler = (payload: unknown) => void;
const commandHandlers = new Map<string, CommandHandler>();

export function onCommand(command: string, handler: CommandHandler): () => void {
  commandHandlers.set(command, handler);
  return () => commandHandlers.delete(command);
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data;
  if (message?.type === 'command' && message.command) {
    const handler = commandHandlers.get(message.command);
    if (handler) {
      handler(message.payload);
    }
  }
});

type ThemeChangePayload =
  | 'light'
  | 'dark'
  | {
      kind?: 'light' | 'dark' | 'high-contrast';
      shikiThemes?: { light?: Record<string, unknown>; dark?: Record<string, unknown> } | null;
    };
type ThemeChangeHandler = (theme: ThemeChangePayload) => void;
let themeChangeHandler: ThemeChangeHandler | null = null;

export function onThemeChange(handler: ThemeChangeHandler): () => void {
  themeChangeHandler = handler;
  return () => { themeChangeHandler = null; };
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data;
  if (message?.type === 'themeChange' && themeChangeHandler) {
    themeChangeHandler(message.theme);
  }
});
