import { Octokit } from '@octokit/rest';
import { getGitHubAuth, isGhCliActive, isGhCliDisabled } from './auth.js';
import { getGhCliToken } from './gh-cli-credential.js';

// Per-request timeout for every GitHub call. Octokit v22 uses native fetch,
// which has no built-in timeout — without this, a stuck connection hangs until
// some outer bound (the PR-status route's 12s overall budget) fires, and a
// single slow request can eat the whole budget. Bounding each request lets the
// caller fail fast and fall back to cached state instead.
const OCTOKIT_REQUEST_TIMEOUT_MS = 8000;

type FetchInput = string | URL | Request;
interface EtagEntry { body: ArrayBuffer; etag: string; headers: Headers }

const timeoutFetch = (url: FetchInput, options: RequestInit = {}): Promise<Response> => {
  // Respect a caller-provided signal if present; otherwise attach our timeout.
  if (options.signal) {
    return fetch(url, options);
  }
  return fetch(url, { ...options, signal: AbortSignal.timeout(OCTOKIT_REQUEST_TIMEOUT_MS) });
};

// Conditional-request cache for GET calls: GitHub serves 304 Not Modified for
// matching If-None-Match WITHOUT counting the request against the REST rate
// limit, so polling unchanged PRs/checks becomes rate-limit-free. Keyed by
// token+URL so different identities never share responses.
const ETAG_CACHE_MAX_ENTRIES = 300;
const etagCache = new Map<string, EtagEntry>();

const rememberEtag = (key: string, etag: string, body: ArrayBuffer, headers: Headers): void => {
  etagCache.delete(key);
  etagCache.set(key, { etag, body, headers });
  if (etagCache.size > ETAG_CACHE_MAX_ENTRIES) {
    const oldest = etagCache.keys().next().value;
    if (oldest !== undefined) {
      etagCache.delete(oldest);
    }
  }
};

const createConditionalFetch = (token: string) => async (
  url: FetchInput,
  options: RequestInit = {},
): Promise<Response> => {
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    return timeoutFetch(url, options);
  }

  const cacheKey = `${token}\n${String(url)}`;
  const cached = etagCache.get(cacheKey);
  const headers = new Headers(options.headers);
  if (cached?.etag) {
    headers.set('if-none-match', cached.etag);
  }

  const response = await timeoutFetch(url, { ...options, headers });

  if (response.status === 304 && cached) {
    // Touch for LRU and replay the cached success response.
    rememberEtag(cacheKey, cached.etag, cached.body, cached.headers);
    return new Response(cached.body, { status: 200, headers: cached.headers });
  }

  if (response.ok) {
    const etag = response.headers.get('etag');
    if (etag) {
      const body = await response.arrayBuffer();
      rememberEtag(cacheKey, etag, body, new Headers(response.headers));
      return new Response(body, { status: response.status, headers: response.headers });
    }
  }

  return response;
};

/** Create an Octokit instance with per-request timeout + ETag revalidation. */
export function createOctokit(token: string): Octokit {
  return new Octokit({ auth: token, request: { fetch: createConditionalFetch(token) } });
}

export function getOctokitOrNull(): Octokit | null {
  const auth = getGitHubAuth();
  const ghToken = !isGhCliDisabled() ? getGhCliToken() : null;
  const token = isGhCliActive() ? ghToken || auth?.accessToken : auth?.accessToken || ghToken;
  if (!token) {
    return null;
  }
  return createOctokit(token);
}
