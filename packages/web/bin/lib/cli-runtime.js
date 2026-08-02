import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { requestJson } from './cli-http.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const requestRuntimeMethod = async (port, method, params = {}, options = {}) => {
  const { response, body } = await requestJson(port, '/api/piarium/runtime/request', {
    ...options,
    timeoutMs: Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 60_000,
    method: 'POST',
    body: JSON.stringify({ method, params, trustProject: options.trustProject !== false }),
  });
  if (response?.ok) return body?.result;
  const message = asNonEmptyString(body?.error) || `Pi runtime method ${method} failed`;
  const status = Number(response?.status);
  throw new TunnelCliError(
    message,
    status === 400 || status === 404 ? EXIT_CODE.USAGE_ERROR : EXIT_CODE.GENERAL_ERROR,
  );
};

export const requestPiariumApi = async (port, endpoint, options = {}) => {
  const { response, body } = await requestJson(port, endpoint, options);
  if (response?.ok) return body;
  const message = asNonEmptyString(body?.error) || `Piarium API request failed: ${endpoint}`;
  const status = Number(response?.status);
  throw new TunnelCliError(
    message,
    status === 400 || status === 404 ? EXIT_CODE.USAGE_ERROR : EXIT_CODE.GENERAL_ERROR,
  );
};

export const waitForSessionIdle = async (port, sessionId, options = {}) => {
  const timeoutSeconds = Number(options.timeout) > 0 ? Number(options.timeout) : 600;
  const deadline = Date.now() + (timeoutSeconds * 1000);
  while (Date.now() < deadline) {
    const snapshot = await requestRuntimeMethod(port, 'session.snapshot', { sessionId }, options);
    if (!snapshot?.busy && !snapshot?.isStreaming && !snapshot?.isCompacting) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new TunnelCliError(`Session ${sessionId} did not become idle within ${timeoutSeconds}s.`, EXIT_CODE.GENERAL_ERROR);
};
