// @ts-nocheck
const ENABLED_VALUES = new Set(['1', 'true']);
const ALLOWED_PHASES = new Set([
  'web.pipeline.start',
  'web.listener.ready',
  'pi-runtime.warmup.start',
  'pi-runtime.warmup.ready',
  'pi-runtime.warmup.error',
]);
const ALLOWED_OUTCOMES = new Set(['ready', 'timeout', 'aborted', 'error']);
const ALLOWED_ROUTE_CLASSES = new Set(['session-messages', 'session', 'events', 'other']);

const finiteNonNegative = (value) => Number.isFinite(value) && value >= 0 ? value : undefined;
const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0 ? value : undefined;

const isStartupPerformanceEnabled = () => (
  ENABLED_VALUES.has(String(process.env.PIARIUM_STARTUP_PERF ?? '').toLowerCase())
);

export const recordStartupPerformance = (phase, details = {}) => {
  if (!isStartupPerformanceEnabled() || !ALLOWED_PHASES.has(phase)) return;

  const event = {
    phase,
    at: Date.now(),
  };
  const durationMs = finiteNonNegative(details.durationMs);
  const totalDurationMs = finiteNonNegative(details.totalDurationMs);
  const attempt = nonNegativeInteger(details.attempt);
  if (durationMs !== undefined) event.durationMs = durationMs;
  if (totalDurationMs !== undefined) event.totalDurationMs = totalDurationMs;
  if (attempt !== undefined) event.attempt = attempt;
  if (ALLOWED_OUTCOMES.has(details.outcome)) event.outcome = details.outcome;
  if (ALLOWED_ROUTE_CLASSES.has(details.routeClass)) event.routeClass = details.routeClass;

  console.info('[startup-performance]', event);
};
