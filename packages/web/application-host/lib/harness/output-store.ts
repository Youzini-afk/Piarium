import { randomBytes } from "node:crypto";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Handle(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

interface StoredOutput {
  text: string;
  label?: string;
  total: number;
}

interface SessionStore {
  outputs: Map<string, StoredOutput>;
  totalBytes: number;
}

const DEFAULT_MAX_BYTES_PER_SESSION = 256 * 1024 * 1024;

export interface OutputStore {
  store(sessionId: string, text: string, label?: string): { handle: string; total: number };
  read(sessionId: string, handle: string, offset?: number, length?: number): { text: string; offset: number; length: number; total: number } | null;
  dropSession(sessionId: string): void;
  dispose(): void;
}

export function createOutputStore(options: { maxBytesPerSession?: number } = {}): OutputStore {
  const maxBytesPerSession = options.maxBytesPerSession ?? DEFAULT_MAX_BYTES_PER_SESSION;
  const sessions = new Map<string, SessionStore>();

  const getOrCreateSession = (sessionId: string): SessionStore => {
    let session = sessions.get(sessionId);
    if (!session) {
      session = { outputs: new Map(), totalBytes: 0 };
      sessions.set(sessionId, session);
    }
    return session;
  };

  const evictOldest = (session: SessionStore): void => {
    // Evict the oldest entry (lowest counter embedded in handle is not tracked;
    // Map preserves insertion order, so first entry is oldest)
    const firstKey = session.outputs.keys().next().value;
    if (firstKey === undefined) return;
    const entry = session.outputs.get(firstKey);
    if (entry) {
      session.totalBytes -= entry.total;
      session.outputs.delete(firstKey);
    }
  };

  return {
    store(sessionId: string, text: string, label?: string): { handle: string; total: number } {
      const session = getOrCreateSession(sessionId);
      const total = Buffer.byteLength(text, "utf8");
      // Evict oldest entries until we have room
      while (session.totalBytes + total > maxBytesPerSession && session.outputs.size > 0) {
        evictOldest(session);
      }
      const id = base32Handle(randomBytes(8));
      const handle = `out_${id}`;
      session.outputs.set(handle, { text, ...(label !== undefined ? { label } : {}), total });
      session.totalBytes += total;
      return { handle, total };
    },

    read(sessionId: string, handle: string, offset: number = 0, length: number = 32768): { text: string; offset: number; length: number; total: number } | null {
      const session = sessions.get(sessionId);
      if (!session) return null;
      const entry = session.outputs.get(handle);
      if (!entry) return null;
      const text = entry.text.slice(offset, offset + length);
      return {
        text,
        offset,
        length: text.length,
        total: entry.total,
      };
    },

    dropSession(sessionId: string): void {
      sessions.delete(sessionId);
    },

    dispose(): void {
      sessions.clear();
    },
  };
}
