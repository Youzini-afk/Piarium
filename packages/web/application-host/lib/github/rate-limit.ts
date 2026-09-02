// Lightweight, process-global GitHub rate-limit gate.
//
// Octokit is configured without the throttling plugin, so a primary or
// secondary rate limit surfaces as a thrown 403/429. Resolving PR status for
// many worktrees fans out dozens of calls; once GitHub starts limiting, every
// further call wastes a round-trip and the cache masks the failure. When we
// detect a rate-limit response we record a cooldown and skip GitHub work until
// it passes, so the burst stops and the reason is visible in the logs.

const MAX_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;

let rateLimitedUntil = 0;

const headerValue = (headers: unknown, name: string): unknown => {
  if (!headers) return undefined;
  // Octokit/fetch headers can be a plain object or a Headers instance.
  if (headers instanceof Headers) return headers.get(name);
  if (typeof headers === 'object' && !Array.isArray(headers)) {
    return (headers as Record<string, unknown>)[name];
  }
  return undefined;
};

const failureRecord = (error: unknown): Record<string, unknown> => (
  error && typeof error === 'object' ? error as Record<string, unknown> : {}
);

const responseRecord = (error: unknown): Record<string, unknown> => {
  const response = failureRecord(error).response;
  return response && typeof response === 'object' ? response as Record<string, unknown> : {};
};

const parseRetryAfterMs = (error: unknown): number | null => {
  const headers = responseRecord(error).headers;
  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter !== undefined && retryAfter !== null) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  }
  const reset = headerValue(headers, 'x-ratelimit-reset');
  if (reset !== undefined && reset !== null) {
    const delta = Number(reset) * 1000 - Date.now();
    if (Number.isFinite(delta) && delta > 0) return delta;
  }
  return null;
};

/** True when an Octokit error represents a primary or secondary rate limit. */
export const isGitHubRateLimitError = (error: unknown): boolean => {
  const failure = failureRecord(error);
  const response = responseRecord(error);
  const status = failure.status ?? response.status;
  if (status === 429) return true;
  if (status !== 403) return false;
  const remaining = headerValue(response.headers, 'x-ratelimit-remaining');
  if (remaining === '0' || remaining === 0) return true;
  if (headerValue(response.headers, 'retry-after') != null) return true;
  const message = String(failure.message ?? '').toLowerCase();
  return message.includes('rate limit');
};

/** Record a cooldown after a detected rate-limit response. */
export const noteGitHubRateLimit = (error: unknown): void => {
  const retryMs = Math.min(parseRetryAfterMs(error) ?? DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS);
  const until = Date.now() + retryMs;
  if (until > rateLimitedUntil) {
    rateLimitedUntil = until;
    console.warn(`[github] rate limited — pausing GitHub PR status calls for ~${Math.round(retryMs / 1000)}s`);
  }
};

/** Convenience: note the error if it is a rate-limit error. Returns whether it was. */
export const noteIfGitHubRateLimit = (error: unknown): boolean => {
  if (!isGitHubRateLimitError(error)) return false;
  noteGitHubRateLimit(error);
  return true;
};

export const isGitHubRateLimited = (): boolean => Date.now() < rateLimitedUntil;
