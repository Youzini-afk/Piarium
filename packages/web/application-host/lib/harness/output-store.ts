import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sliceUtf8ByBytes, type OutputRef, type OutputSlice } from "@piarium/protocol";

interface StoredOutput {
  bytes: Buffer;
  label?: string;
  sequence: number;
}

interface SessionStore {
  outputs: Map<number, StoredOutput>;
  totalBytes: number;
  nextSequence: number;
  evictedThrough: number;
}

export type OutputReadResult =
  | { status: "ready"; slice: OutputSlice }
  | { status: "expired" }
  | { status: "not-found" };

export interface OutputStore {
  readonly generation: string;
  store(sessionId: string, text: string, label?: string): { ref: OutputRef; total: number };
  read(sessionId: string, handle: string, offset?: number, length?: number): OutputReadResult;
  dropSession(sessionId: string): void;
  dispose(): void;
}

export interface OutputStoreOptions {
  maxBytesPerSession?: number;
  /** Test seam; production creates a fresh 128-bit generation per Host. */
  generation?: string;
  /** Test seam; production creates a fresh 256-bit MAC key per Host. */
  macKey?: Buffer;
}

const DEFAULT_MAX_BYTES_PER_SESSION = 256 * 1024 * 1024;
const HANDLE_PATTERN = /^out_([0-9a-f]{32})_([0-9a-z]+)_([0-9a-f]{32})$/;
const LEGACY_HANDLE_PATTERN = /^out_[a-z2-7]+$/;

const createSessionStore = (): SessionStore => ({
  outputs: new Map(),
  totalBytes: 0,
  nextSequence: 1,
  evictedThrough: 0,
});

export function createOutputStore(options: OutputStoreOptions = {}): OutputStore {
  const maxBytesPerSession = options.maxBytesPerSession ?? DEFAULT_MAX_BYTES_PER_SESSION;
  if (!Number.isFinite(maxBytesPerSession) || maxBytesPerSession <= 0) {
    throw new RangeError("maxBytesPerSession must be positive");
  }
  const generation = options.generation ?? randomBytes(16).toString("hex");
  if (!/^[0-9a-f]{32}$/.test(generation)) throw new TypeError("Output generation must be 128-bit lowercase hex");
  const macKey = Buffer.from(options.macKey ?? randomBytes(32));
  if (macKey.byteLength < 16) throw new TypeError("Output MAC key must contain at least 128 bits");
  const sessions = new Map<string, SessionStore>();

  const getOrCreateSession = (sessionId: string): SessionStore => {
    let session = sessions.get(sessionId);
    if (!session) {
      session = createSessionStore();
      sessions.set(sessionId, session);
    }
    return session;
  };

  const macFor = (sessionId: string, sequence: number): string => (
    createHmac("sha256", macKey)
      .update(sessionId)
      .update("\0")
      .update(String(sequence))
      .digest("hex")
      .slice(0, 32)
  );

  const handleFor = (sessionId: string, sequence: number): string => (
    `out_${generation}_${sequence.toString(36)}_${macFor(sessionId, sequence)}`
  );

  const hasValidMac = (sessionId: string, sequence: number, observed: string): boolean => {
    const expected = Buffer.from(macFor(sessionId, sequence), "hex");
    const candidate = Buffer.from(observed, "hex");
    return candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected);
  };

  const evictOldest = (session: SessionStore): void => {
    const sequence = session.outputs.keys().next().value as number | undefined;
    if (sequence === undefined) return;
    const entry = session.outputs.get(sequence);
    if (!entry) return;
    session.totalBytes -= entry.bytes.byteLength;
    session.outputs.delete(sequence);
    session.evictedThrough = Math.max(session.evictedThrough, sequence);
  };

  return {
    generation,

    store(sessionId, text, label) {
      const session = getOrCreateSession(sessionId);
      const bytes = Buffer.from(text, "utf8");
      while (session.totalBytes + bytes.byteLength > maxBytesPerSession && session.outputs.size > 0) {
        evictOldest(session);
      }
      const sequence = session.nextSequence;
      session.nextSequence += 1;
      const handle = handleFor(sessionId, sequence);
      session.outputs.set(sequence, { bytes, sequence, ...(label === undefined ? {} : { label }) });
      session.totalBytes += bytes.byteLength;
      return {
        ref: { durability: "ephemeral", generation, handle },
        total: bytes.byteLength,
      };
    },

    read(sessionId, handle, offset = 0, length = 32_768): OutputReadResult {
      if (LEGACY_HANDLE_PATTERN.test(handle)) return { status: "expired" };
      const match = HANDLE_PATTERN.exec(handle);
      if (!match) return { status: "not-found" };
      const [, handleGeneration, encodedSequence, observedMac] = match;
      if (handleGeneration !== generation) return { status: "expired" };
      const sequence = Number.parseInt(encodedSequence!, 36);
      if (!Number.isSafeInteger(sequence) || sequence < 1 || !hasValidMac(sessionId, sequence, observedMac!)) {
        return { status: "not-found" };
      }
      const session = sessions.get(sessionId);
      if (!session) return { status: "not-found" };
      const entry = session.outputs.get(sequence);
      if (entry) {
        return {
          status: "ready",
          slice: sliceUtf8ByBytes(entry.bytes, offset, length),
        };
      }
      if (sequence <= session.evictedThrough || sequence < session.nextSequence) return { status: "expired" };
      return { status: "not-found" };
    },

    dropSession(sessionId): void {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.outputs.clear();
      session.totalBytes = 0;
      session.evictedThrough = Math.max(session.evictedThrough, session.nextSequence - 1);
    },

    dispose(): void {
      sessions.clear();
      macKey.fill(0);
    },
  };
}
