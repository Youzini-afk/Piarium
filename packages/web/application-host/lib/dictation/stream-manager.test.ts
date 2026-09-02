import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';

import { DictationStreamManager } from './stream-manager.js';
import type { DictationEvent, StreamingTranscriptionSession } from './types.js';

const FORMAT = 'audio/pcm;rate=16000;bits=16';

class FakeSttSession extends EventEmitter {
  requiredSampleRate: number;
  appended: Buffer[];
  commits: number;
  clears: number;
  closed: boolean;
  segmentCounter: number;
  transcriptBySegment: (segmentId: string) => string;

  constructor({ transcriptBySegment = () => 'hello world' }: {
    transcriptBySegment?: (segmentId: string) => string;
  } = {}) {
    super();
    this.requiredSampleRate = 16000;
    this.appended = [];
    this.commits = 0;
    this.clears = 0;
    this.closed = false;
    this.segmentCounter = 0;
    this.transcriptBySegment = transcriptBySegment;
  }

  async connect(): Promise<void> {}

  appendPcm16(buf: Buffer): void {
    this.appended.push(buf);
  }

  commit(): void {
    this.commits += 1;
    const segmentId = `seg-${this.segmentCounter}`;
    this.segmentCounter += 1;
    this.emit('committed', { segmentId, previousSegmentId: null });
    setTimeout(() => {
      this.emit('transcript', {
        segmentId,
        transcript: this.transcriptBySegment(segmentId),
        isFinal: true,
      });
    }, 0);
  }

  clear(): void {
    this.clears += 1;
  }

  close(): void {
    this.closed = true;
  }
}

function loudChunkBase64(samples = 1600, amplitude = 8000): string {
  const arr = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    arr[i] = i % 2 === 0 ? amplitude : -amplitude;
  }
  return Buffer.from(arr.buffer).toString('base64');
}

function silentChunkBase64(samples = 1600): string {
  return Buffer.from(new Int16Array(samples).buffer).toString('base64');
}

function createManager(session: StreamingTranscriptionSession): {
  manager: DictationStreamManager;
  messages: DictationEvent[];
} {
  const messages: DictationEvent[] = [];
  const manager = new DictationStreamManager({
    emit: (msg) => messages.push(msg),
    createSttSession: async () => ({ session }),
  });
  return { manager, messages };
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve(undefined);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('DictationStreamManager', () => {
  it('transcribes ordered chunks and emits final text', async () => {
    const session = new FakeSttSession();
    const { manager, messages } = createManager(session);

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64() });
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: loudChunkBase64() });
    manager.handleFinish('d1', 1);

    await waitFor(() => messages.some((m) => m.type === 'final'));

    const final = messages.find((m) => m.type === 'final');
    if (!final) throw new Error('Expected final dictation event');
    expect(final.payload.text).toBe('hello world');
    expect(session.commits).toBe(1);
    expect(session.closed).toBe(true);

    const acks = messages.filter((m) => m.type === 'ack');
    expect(acks.at(-1)?.payload.ackSeq).toBe(1);
  });

  it('reorders out-of-order chunks before appending', async () => {
    const session = new FakeSttSession();
    const { manager, messages } = createManager(session);

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: loudChunkBase64() });
    expect(session.appended.length).toBe(0);
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64() });
    expect(session.appended.length).toBe(2);
    manager.handleFinish('d1', 1);

    await waitFor(() => messages.some((m) => m.type === 'final'));
  });

  it('clears silence-only tails instead of committing', async () => {
    const session = new FakeSttSession();
    const { manager, messages } = createManager(session);

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: silentChunkBase64() });
    manager.handleFinish('d1', 0);

    await waitFor(() => messages.some((m) => m.type === 'final'));

    const final = messages.find((m) => m.type === 'final');
    if (!final) throw new Error('Expected final dictation event');
    expect(final.payload.text).toBe('');
    expect(session.commits).toBe(0);
    expect(session.clears).toBe(1);
  });

  it('fails fast when finish arrives with no chunks', async () => {
    const session = new FakeSttSession();
    const { manager, messages } = createManager(session);

    await manager.handleStart('d1', FORMAT, {});
    manager.handleFinish('d1', 3);

    const error = messages.find((m) => m.type === 'error');
    expect(error).toBeDefined();
    if (!error) throw new Error('Expected dictation error event');
    expect(error.payload.retryable).toBe(true);
    expect(session.closed).toBe(true);
  });

  it('reports provider readiness errors from createSttSession', async () => {
    const messages: DictationEvent[] = [];
    const manager = new DictationStreamManager({
      emit: (msg) => messages.push(msg),
      createSttSession: async () => ({
        error: 'Dictation model is downloading',
        retryable: true,
        reasonCode: 'model_download_in_progress',
      }),
    });

    await manager.handleStart('d1', FORMAT, {});
    const error = messages.find((m) => m.type === 'error');
    if (!error) throw new Error('Expected dictation error event');
    expect(error.payload.reasonCode).toBe('model_download_in_progress');
    expect(error.payload.retryable).toBe(true);
  });

  it('emits partials as segment transcripts arrive', async () => {
    let segment = 0;
    const session = new FakeSttSession({
      transcriptBySegment: () => {
        segment += 1;
        return segment === 1 ? 'first part' : 'second part';
      },
    });
    const { manager, messages } = createManager(session);
    // Force auto-commit after ~0.05s of audio so two segments form.
    manager.autoCommitSeconds = 0.05;

    await manager.handleStart('d1', FORMAT, {});
    manager.handleChunk({ dictationId: 'd1', seq: 0, audioBase64: loudChunkBase64(1600) });
    await waitFor(() => session.commits >= 1);
    manager.handleChunk({ dictationId: 'd1', seq: 1, audioBase64: loudChunkBase64(1600) });
    manager.handleFinish('d1', 1);

    await waitFor(() => messages.some((m) => m.type === 'final'));

    const final = messages.find((m) => m.type === 'final');
    if (!final) throw new Error('Expected final dictation event');
    expect(final.payload.text).toBe('first part second part');
    const partials = messages.filter((m) => m.type === 'partial');
    expect(partials.length).toBeGreaterThan(0);
  });
});
