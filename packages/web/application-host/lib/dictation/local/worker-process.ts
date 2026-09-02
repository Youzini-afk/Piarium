/**
 * Dictation local-speech worker process.
 *
 * Hosts the sherpa-onnx native inference (Parakeet STT) in a separate process
 * so ONNX decoding never blocks the main Piarium server. Communicates
 * with the parent over child_process IPC (advanced serialization, so Buffers
 * survive the trip as Uint8Array).
 *
 * Request/response protocol (parent -> worker):
 *   { type: 'session.create', requestId, sessionId, modelsDir, modelId }
 *   { type: 'session.append', requestId, sessionId, audio }
 *   { type: 'session.commit' | 'session.clear' | 'session.close', requestId, sessionId }
 * Worker -> parent:
 *   { type: 'response', requestId, ok, result?, error? }
 *   { type: 'session.committed' | 'session.transcript' | 'session.error', sessionId, ... }
 */

import {
  SherpaOfflineRecognizerEngine,
  SherpaRealtimeTranscriptionSession,
} from './sherpa-recognizer.js';
import { SherpaTtsEngine } from './sherpa-tts.js';
import { getLocalSttModelDir, getLocalSttModelSpec } from './model-catalog.js';
import { pcm16ToWav } from '../audio.js';
import path from 'path';
import type { WorkerRequest } from '../types.js';

process.title = 'Piarium Dictation';

const engines = new Map<string, SherpaOfflineRecognizerEngine>();
const ttsEngines = new Map<string, SherpaTtsEngine>();
const sessions = new Map<string, SherpaRealtimeTranscriptionSession>();
let ipcClosing = false;

function sendToParent(message: unknown): void {
  if (ipcClosing || !process.connected || !process.send) {
    return;
  }
  try {
    process.send(message, (error) => {
      if (error) {
        ipcClosing = true;
      }
    });
  } catch {
    ipcClosing = true;
  }
}

function sendOk(requestId: string | undefined, result?: unknown): void {
  sendToParent({ type: 'response', requestId, ok: true, ...(result !== undefined ? { result } : {}) });
}

function getEngine(modelsDir: string, modelId: string): SherpaOfflineRecognizerEngine {
  const key = `${modelsDir}:${modelId}`;
  const existing = engines.get(key);
  if (existing) {
    return existing;
  }
  const modelDir = getLocalSttModelDir(modelsDir, modelId);
  const spec = getLocalSttModelSpec(modelId);
  if (spec.type !== 'nemo_transducer' && spec.type !== 'whisper') {
    throw new Error(`Model is not an STT recognizer: ${modelId}`);
  }
  if (!spec.files.encoder || !spec.files.decoder) {
    throw new Error(`STT model is missing encoder or decoder metadata: ${modelId}`);
  }
  if (spec.type === 'nemo_transducer' && !spec.files.joiner) {
    throw new Error(`Transducer model is missing joiner metadata: ${modelId}`);
  }
  const common = {
    encoder: path.join(modelDir, spec.files.encoder),
    decoder: path.join(modelDir, spec.files.decoder),
    tokens: path.join(modelDir, spec.files.tokens),
    numThreads: 2,
  };
  const created = spec.type === 'nemo_transducer'
    ? new SherpaOfflineRecognizerEngine({
        ...common,
        type: 'nemo_transducer',
        joiner: path.join(modelDir, spec.files.joiner as string),
      })
    : new SherpaOfflineRecognizerEngine({ ...common, type: 'whisper' });
  engines.set(key, created);
  return created;
}

function cleanupSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  try {
    session?.close();
  } catch {
    // ignore
  }
}

function toBuffer(audio: unknown): Buffer {
  if (Buffer.isBuffer(audio)) {
    return audio;
  }
  if (audio instanceof Uint8Array) {
    return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  }
  if (audio && typeof audio === 'object' && 'type' in audio && audio.type === 'Buffer' && 'data' in audio && Array.isArray(audio.data)) {
    return Buffer.from(audio.data.filter((byte): byte is number => typeof byte === 'number'));
  }
  throw new Error('Unsupported audio payload in dictation worker');
}

function getTtsEngine(modelsDir: string, modelId: string): SherpaTtsEngine {
  const key = `${modelsDir}:${modelId}`;
  const existing = ttsEngines.get(key);
  if (existing) {
    return existing;
  }
  const spec = getLocalSttModelSpec(modelId);
  if (
    spec.type !== 'kokoro'
    || !spec.files.model
    || !spec.files.voices
    || !spec.files.espeakData
  ) {
    throw new Error(`Model is not a complete TTS model: ${modelId}`);
  }
  const created = new SherpaTtsEngine({
    modelDir: getLocalSttModelDir(modelsDir, modelId),
    files: {
      model: spec.files.model,
      voices: spec.files.voices,
      tokens: spec.files.tokens,
      espeakData: spec.files.espeakData,
    },
    numThreads: 2,
  });
  ttsEngines.set(key, created);
  return created;
}

const stringField = (message: WorkerRequest, key: string): string => {
  const value = message[key];
  if (typeof value !== 'string' || !value) throw new Error(`Dictation worker request requires ${key}`);
  return value;
};

async function handleRequest(message: WorkerRequest): Promise<void> {
  const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
  switch (message.type) {
    case 'tts.synthesize': {
      const engine = getTtsEngine(stringField(message, 'modelsDir'), stringField(message, 'modelId'));
      const { pcm16, sampleRate } = engine.synthesize(stringField(message, 'text'), {
        ...(typeof message.speakerId === 'number' ? { speakerId: message.speakerId } : {}),
        ...(typeof message.speed === 'number' ? { speed: message.speed } : {}),
      });
      sendOk(requestId, {
        audio: pcm16ToWav(pcm16, sampleRate),
        format: 'audio/wav',
      });
      return;
    }
    case 'session.create': {
      const sessionId = stringField(message, 'sessionId');
      cleanupSession(sessionId);
      const engine = getEngine(stringField(message, 'modelsDir'), stringField(message, 'modelId'));
      const session = new SherpaRealtimeTranscriptionSession({ engine });
      session.on('committed', (payload) => {
        sendToParent({ type: 'session.committed', sessionId, payload });
      });
      session.on('transcript', (payload) => {
        sendToParent({ type: 'session.transcript', sessionId, payload });
      });
      session.on('error', (err) => {
        sendToParent({
          type: 'session.error',
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      await session.connect();
      sessions.set(sessionId, session);
      sendOk(requestId, { requiredSampleRate: session.requiredSampleRate });
      return;
    }
    case 'session.append': {
      sessions.get(stringField(message, 'sessionId'))?.appendPcm16(toBuffer(message.audio));
      sendOk(requestId);
      return;
    }
    case 'session.commit': {
      sessions.get(stringField(message, 'sessionId'))?.commit();
      sendOk(requestId);
      return;
    }
    case 'session.clear': {
      sessions.get(stringField(message, 'sessionId'))?.clear();
      sendOk(requestId);
      return;
    }
    case 'session.close': {
      cleanupSession(stringField(message, 'sessionId'));
      sendOk(requestId);
      return;
    }
    default: {
      throw new Error(`Unknown dictation worker request: ${message?.type}`);
    }
  }
}

process.on('message', (rawMessage: unknown) => {
  const message = rawMessage && typeof rawMessage === 'object' && !Array.isArray(rawMessage)
    ? rawMessage as WorkerRequest
    : { type: 'invalid' };
  void handleRequest(message).catch((error) => {
    sendToParent({
      type: 'response',
      requestId: message?.requestId,
      ok: false,
      error: error instanceof Error ? error.message : 'Dictation worker request failed',
    });
  });
});

process.once('disconnect', () => {
  ipcClosing = true;
  for (const sessionId of Array.from(sessions.keys())) {
    cleanupSession(sessionId);
  }
  for (const engine of engines.values()) {
    engine.free();
  }
  for (const tts of ttsEngines.values()) {
    tts.free();
  }
  process.exit(0);
});
