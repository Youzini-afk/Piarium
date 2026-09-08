/**
 * Host-local MiniLM via `@huggingface/transformers`. The pack is resolved
 * through the content-addressed store; missing weights are `unavailable`,
 * not an empty ready index.
 */

import os from "node:os";
import { pathToFileURL } from "node:url";
import { intraOpThreads, LOCAL_MINILM_SPACE, type VectorSpaceIdentity } from "./identity.js";
import type { SemanticEmbedder, SemanticEmbedderStatus } from "./embedder.js";
import { resolveInstalledModelPack, type ResolvedModelPack } from "./model-store.js";

type Encoded = { length: number } | ArrayLike<number>;

type TransformersModule = {
  env: {
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
    options?: { local_files_only?: boolean },
  ) => Promise<(
    texts: string | string[],
    options?: { pooling?: string; normalize?: boolean },
  ) => Promise<{ tolist: () => number[] | number[][] } | number[][]>>;
};

const encodedLength = (value: Encoded): number => (
  typeof (value as { length: number }).length === "number" ? (value as { length: number }).length : 0
);

const loadTransformers = async (): Promise<TransformersModule> => {
  const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<TransformersModule>;
  return load("@huggingface/transformers");
};

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
      const source = pack.root.startsWith("file:") ? pack.root : pathToFileURL(pack.root).href;
      if (pack.tokenizerPath) {
        const tokenizer = await mod.AutoTokenizer.from_pretrained(source, { local_files_only: true });
        encode = (text) => {
          const ids = tokenizer.encode(text);
          return encodedLength(ids as Encoded);
        };
      }
      if (pack.onnxPath) {
        const pipe = await mod.pipeline("feature-extraction", source, { local_files_only: true });
        extractor = async (texts) => {
          const vectors: number[][] = [];
          for (const text of texts) {
            const output = await pipe(text, { pooling: space.pooling, normalize: space.normalize });
            const listed = typeof (output as { tolist?: () => number[] | number[][] }).tolist === "function"
              ? (output as { tolist: () => number[] | number[][] }).tolist()
              : output as number[][];
            vectors.push(Array.isArray(listed[0]) ? listed[0] as number[] : listed as number[]);
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
