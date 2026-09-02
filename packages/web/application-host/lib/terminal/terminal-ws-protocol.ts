export const TERMINAL_WS_PATH = '/api/terminal/ws';
export const TERMINAL_WS_CONTROL_TAG_JSON = 0x01;
export const TERMINAL_WS_MAX_PAYLOAD_BYTES = 64 * 1024;

export type TerminalWsRawData = string | Buffer | ArrayBuffer | Uint8Array | Buffer[];

export const parseRequestPathname = (requestUrl: unknown): string => {
  if (typeof requestUrl !== 'string' || requestUrl.length === 0) {
    return '';
  }

  try {
    return new URL(requestUrl, 'http://localhost').pathname;
  } catch {
    return '';
  }
};

export const isTerminalWsPathname = (pathname: unknown): boolean => pathname === TERMINAL_WS_PATH;

export const normalizeTerminalWsMessageToBuffer = (rawData: Exclude<TerminalWsRawData, string>): Buffer => {
  if (Buffer.isBuffer(rawData)) {
    return rawData;
  }

  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData.map((chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
  }

  if (rawData instanceof ArrayBuffer) return Buffer.from(rawData);
  return Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength);
};

export const normalizeTerminalWsMessageToText = (rawData: TerminalWsRawData): string => {
  if (typeof rawData === 'string') {
    return rawData;
  }

  return normalizeTerminalWsMessageToBuffer(rawData).toString('utf8');
};

export const readTerminalWsControlFrame = (rawData: Exclude<TerminalWsRawData, string> | null | undefined): Record<string, unknown> | null => {
  if (!rawData) {
    return null;
  }

  const buffer = normalizeTerminalWsMessageToBuffer(rawData);
  if (buffer.length < 2 || buffer[0] !== TERMINAL_WS_CONTROL_TAG_JSON) {
    return null;
  }

  try {
    const parsed = JSON.parse(buffer.subarray(1).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const createTerminalWsControlFrame = (payload: unknown): Buffer => {
  const jsonBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return Buffer.concat([Buffer.from([TERMINAL_WS_CONTROL_TAG_JSON]), jsonBytes]);
};

export const pruneRebindTimestamps = (timestamps: number[], now: number, windowMs: number): number[] =>
  timestamps.filter((timestamp) => now - timestamp < windowMs);

export const isRebindRateLimited = (timestamps: number[], maxPerWindow: number): boolean => timestamps.length >= maxPerWindow;
