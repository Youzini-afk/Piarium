const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;

// Shared in-process cache of the models.dev catalog. Used by the
// /api/piarium/models-metadata route and the small-model resolver so the
// server fetches the catalog once, not per consumer.
export type ModelsMetadata = Record<string, unknown>;

let cachedMetadata: ModelsMetadata | null = null;
let cachedAt = 0;
let inflight: Promise<ModelsMetadata> | null = null;

const fetchCatalog = async (url: string, timeoutMs: number): Promise<ModelsMetadata> => {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`models.dev responded with status ${response.status}`);
  }
  const metadata = await response.json();
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('models.dev returned an unexpected payload');
  }
  return metadata as ModelsMetadata;
};

export interface GetModelsMetadataOptions {
  timeoutMs?: number | undefined;
  ttlMs?: number | undefined;
  url?: string | undefined;
}

export interface ModelsMetadataResult {
  fromCache: boolean;
  metadata: ModelsMetadata;
  stale?: boolean | undefined;
}

/**
 * Returns the models.dev catalog, serving the in-memory copy while fresh.
 * On fetch failure a stale cached copy is returned when available; otherwise
 * the error propagates.
 */
export async function getModelsMetadata({
  url = MODELS_DEV_API_URL,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: GetModelsMetadataOptions = {}): Promise<ModelsMetadataResult> {
  const now = Date.now();
  if (cachedMetadata && now - cachedAt < ttlMs) {
    return { metadata: cachedMetadata, fromCache: true };
  }

  if (!inflight) {
    inflight = fetchCatalog(url, timeoutMs).finally(() => {
      inflight = null;
    });
  }

  try {
    const metadata = await inflight;
    cachedMetadata = metadata;
    cachedAt = Date.now();
    return { metadata, fromCache: false };
  } catch (error) {
    if (cachedMetadata) {
      return { metadata: cachedMetadata, fromCache: true, stale: true };
    }
    throw error;
  }
}

export { MODELS_DEV_API_URL };
