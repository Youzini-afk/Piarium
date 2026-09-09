/**
 * Host-local MiniLM via `@huggingface/transformers`. The pack is resolved
 * through the content-addressed store; missing weights are `unavailable`,
 * not an empty ready index.
 */

import os from "node:os";
import { basename, dirname } from "node:path";
import { intraOpThreads, LOCAL_MINILM_SPACE, type VectorSpaceIdentity } from "./identity.js";
import type { SemanticEmbedder, SemanticEmbedderStatus } from "./embedder.js";
import { resolveInstalledModelPack, type ResolvedModelPack } from "./model-store.js";

type Encoded = { length: number } | ArrayLike<number>;

type TransformersModule = {
  env: {
    allowRemoteModels?: boolean;
    localModelPath?: string;
    backends?: {
      onnx?: {
        wasm?: { numThreads?: number };
      };
    };
  };
  AutoTokenizer: {
    from_pretrained: (source: string, options?: { local_files_only?: boolean }) => Promise<{
      encode: (text: string) => Encoded | Promise<Encoded>;
    }>;
  };
  pipeline: (
    task: "feature-extraction",
    model: string,
    options?: { local_files_only?: boolean; dtype?: string },
  ) => Promise<(
    texts: string | string[],
    options?: { pooling?: string; normalize?: boolean },
  ) => Promise<{ tolist: () => number[] | number[][] } | number[][]>>;
};

const encodedLength = (value: Encoded): number => (
  typeof (value as { length: number }).length === "number" ? (value as { length: number }).length : 0
);

/**
 * Kept out of the bundler's static graph so a desktop build does not inline the
 * runtime, but a real dynamic import so it actually loads and is testable — the
 * previous `new Function("return import(...)")` form threw "A dynamic import
 * callback was not specified" under the test runner, which is why this path had
 * never run (D-172).
 */
const TRANSFORMERS_MODULE_ID = "@huggingface/transformers";
// 32 is the measured CPU batch size for near-window inputs. It is only an
// inference grain: embed() always walks every input and preserves its order.
const INFERENCE_BATCH_SIZE = 32;

const loadTransformers = async (): Promise<TransformersModule> => (
  await import(/* @vite-ignore */ TRANSFORMERS_MODULE_ID) as TransformersModule
);

export function createLocalMinilmEmbedder(options: {
  dataDir: string;
  pack?: ResolvedModelPack | null;
  parallelism?: number;
}): SemanticEmbedder {
  const pack = options.pack !== undefined
    ? options.pack
    : resolveInstalledModelPack(options.dataDir);
  const space: VectorSpaceIdentity = pack?.space ?? LOCAL_MINILM_SPACE;
  const status: SemanticEmbedderStatus = pack?.onnxPath ? "ready" : "unavailable";
  let encode: ((text: string) => number) | null = null;
  let prepared = false;
  let extractor: ((texts: readonly string[]) => Promise<number[][]>) | null = null;

  const configureThreads = (mod: TransformersModule): void => {
    const threads = intraOpThreads(options.parallelism ?? os.availableParallelism());
    if (mod.env.backends?.onnx?.wasm) mod.env.backends.onnx.wasm.numThreads = threads;
  };

  return {
    status,
    space,
    prepare: async () => {
      if (prepared) return;
      if (!pack?.root) {
        prepared = true;
        return;
      }
      const mod = await loadTransformers();
      configureThreads(mod);
      // transformers.js resolves a local pack as `${env.localModelPath}/${id}`
      // and looks for `onnx/<file>` inside it. A file:// URL as the id makes it
      // read `tokenizer_config.json` off the wrong base (D-172).
      mod.env.allowRemoteModels = false;
      mod.env.localModelPath = dirname(pack.root);
      const source = basename(pack.root);
      if (pack.tokenizerPath) {
        const tokenizer = await mod.AutoTokenizer.from_pretrained(source, { local_files_only: true });
        encode = (text) => {
          const ids = tokenizer.encode(text);
          return encodedLength(ids as Encoded);
        };
      }
      if (pack.onnxPath) {
        // `dtype` picks the weight filename: q8 resolves `onnx/model_quantized.onnx`,
        // which is the file the pack recipe names (D-172).
        const pipe = await mod.pipeline("feature-extraction", source, { local_files_only: true, dtype: "q8" });
        extractor = async (texts) => {
          const vectors: number[][] = [];
          for (let offset = 0; offset < texts.length; offset += INFERENCE_BATCH_SIZE) {
            const batch = texts.slice(offset, offset + INFERENCE_BATCH_SIZE);
            const output = await pipe(batch, { pooling: space.pooling, normalize: space.normalize });
            const listed = typeof (output as { tolist?: () => number[] | number[][] }).tolist === "function"
              ? (output as { tolist: () => number[] | number[][] }).tolist()
              : output as number[][];
            const rows = Array.isArray(listed[0]) ? listed as number[][] : [listed as number[]];
            if (rows.length !== batch.length || rows.some((row) => row.length !== space.dim)) {
              throw new Error(`MiniLM returned ${rows.length} vectors for ${batch.length} inputs in ${space.dim} dimensions.`);
            }
            vectors.push(...rows);
          }
          return vectors;
        };
      }
      prepared = true;
    },
    countTokens: (text) => {
      if (encode) return encode(text);
      throw new Error("MiniLM tokenizer is not prepared.");
    },
    embed: async (texts) => {
      if (status !== "ready" || !extractor) throw new Error("MiniLM model pack is unavailable.");
      return extractor(texts);
    },
  };
}
