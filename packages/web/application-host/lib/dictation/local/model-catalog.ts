/**
 * Catalog of local sherpa-onnx STT models available for dictation.
 * Models are downloaded on demand from the k2-fsa GitHub releases and
 * extracted under the Piarium speech-models directory.
 *
 * `type` selects the recognizer construction path in the worker:
 * - 'nemo_transducer': encoder/decoder/joiner transducer (Parakeet)
 * - 'whisper': encoder/decoder Whisper export
 * `files` maps logical roles to file names inside the extracted directory.
 */

import path from 'path';
import type { LocalSpeechModelCatalog, LocalSpeechModelSpec } from '../types.js';

export const LOCAL_STT_MODEL_CATALOG = {
  'parakeet-tdt-0.6b-v2-int8': {
    type: 'nemo_transducer',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
    extractedDir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    files: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
    },
    description: 'NVIDIA Parakeet TDT v2 (English)',
  },
  'parakeet-tdt-0.6b-v3-int8': {
    type: 'nemo_transducer',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
    extractedDir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    files: {
      encoder: 'encoder.int8.onnx',
      decoder: 'decoder.int8.onnx',
      joiner: 'joiner.int8.onnx',
      tokens: 'tokens.txt',
    },
    description: 'NVIDIA Parakeet TDT v3 (25 European languages, auto-detected)',
  },
  'whisper-base-int8': {
    type: 'whisper',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.tar.bz2',
    extractedDir: 'sherpa-onnx-whisper-base',
    files: {
      encoder: 'base-encoder.int8.onnx',
      decoder: 'base-decoder.int8.onnx',
      tokens: 'base-tokens.txt',
    },
    description: 'OpenAI Whisper base (multilingual, smaller and lighter)',
  },
  'whisper-tiny-int8': {
    type: 'whisper',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2',
    extractedDir: 'sherpa-onnx-whisper-tiny',
    files: {
      encoder: 'tiny-encoder.int8.onnx',
      decoder: 'tiny-decoder.int8.onnx',
      tokens: 'tiny-tokens.txt',
    },
    description: 'OpenAI Whisper tiny (multilingual, fastest and lightest)',
  },
} as const satisfies LocalSpeechModelCatalog;

/**
 * Local text-to-speech models (sherpa-onnx OfflineTts). Downloaded and
 * managed through the same pipeline as the STT models.
 */
export const LOCAL_TTS_MODEL_CATALOG = {
  'kokoro-en-v0_19': {
    type: 'kokoro',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2',
    extractedDir: 'kokoro-en-v0_19',
    files: {
      model: 'model.onnx',
      voices: 'voices.bin',
      tokens: 'tokens.txt',
      espeakData: 'espeak-ng-data',
    },
    description: 'Kokoro TTS (English, natural voices)',
  },
} as const satisfies LocalSpeechModelCatalog;

export type LocalSttModelId = keyof typeof LOCAL_STT_MODEL_CATALOG;
export type LocalTtsModelId = keyof typeof LOCAL_TTS_MODEL_CATALOG;
export type LocalSpeechModelId = LocalSttModelId | LocalTtsModelId;

export const DEFAULT_LOCAL_STT_MODEL: LocalSttModelId = 'parakeet-tdt-0.6b-v2-int8';
export const DEFAULT_LOCAL_TTS_MODEL: LocalTtsModelId = 'kokoro-en-v0_19';

export const LOCAL_STT_MODEL_IDS = Object.keys(LOCAL_STT_MODEL_CATALOG) as LocalSttModelId[];
export const LOCAL_TTS_MODEL_IDS = Object.keys(LOCAL_TTS_MODEL_CATALOG) as LocalTtsModelId[];

/**
 * @param {string} modelId
 * @returns {boolean}
 */
export function isLocalSttModelId(modelId: unknown): modelId is LocalSttModelId {
  return typeof modelId === 'string' && Object.hasOwn(LOCAL_STT_MODEL_CATALOG, modelId);
}

/**
 * @param {string} modelId
 * @returns {boolean}
 */
export function isLocalTtsModelId(modelId: unknown): modelId is LocalTtsModelId {
  return typeof modelId === 'string' && Object.hasOwn(LOCAL_TTS_MODEL_CATALOG, modelId);
}

/**
 * Any managed local model (STT or TTS).
 * @param {string} modelId
 * @returns {boolean}
 */
export function isLocalModelId(modelId: unknown): modelId is LocalSpeechModelId {
  return isLocalSttModelId(modelId) || isLocalTtsModelId(modelId);
}

/**
 * Spec lookup across both catalogs (STT and TTS).
 * @param {string} modelId
 */
export function getLocalSttModelSpec(modelId: string): LocalSpeechModelSpec & { id: string; requiredFiles: string[] } {
  const sttSpec = isLocalSttModelId(modelId) ? LOCAL_STT_MODEL_CATALOG[modelId] : undefined;
  const ttsSpec = isLocalTtsModelId(modelId) ? LOCAL_TTS_MODEL_CATALOG[modelId] : undefined;
  const spec: LocalSpeechModelSpec | undefined = sttSpec ?? ttsSpec;
  if (!spec) {
    throw new Error(`Unknown local speech model id: ${modelId}`);
  }
  return {
    id: modelId,
    ...spec,
    requiredFiles: Object.values(spec.files),
  };
}

/**
 * @param {string} modelsDir
 * @param {string} modelId
 * @returns {string}
 */
export function getLocalSttModelDir(modelsDir: string, modelId: string): string {
  return path.join(modelsDir, getLocalSttModelSpec(modelId).extractedDir);
}
