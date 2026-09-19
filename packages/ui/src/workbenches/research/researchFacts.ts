import { runtimeFetch } from '@piarium/application-client';
import type {
  ExperimentArtifactView,
  ExperimentAttemptView,
  ExperimentCollectResult,
  ExperimentLogsResult,
  ResourceMachineView,
  ResearchSourceView,
} from '@piarium/protocol';

/**
 * Research facts loader (7F, D-300): the workbench reads the same durable
 * experiment/resource/source records the agent tools manage, through the
 * session-scoped harness routes — never through the Pi runtime `resource.list`
 * namespace, which is a different contract.
 */

export interface ResearchFactsSnapshot {
  attempts: ExperimentAttemptView[];
  machines: ResourceMachineView[];
  sources: ResearchSourceView[];
  generatedAt: number;
}

export interface ResearchAttemptDetails {
  attempt: ExperimentAttemptView;
  artifacts: ExperimentArtifactView[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const ATTEMPT_STATES = new Set([
  'submitted', 'queued', 'running', 'stopping', 'completed', 'failed', 'cancelled', 'lost',
]);

const parseAttempt = (value: unknown): ExperimentAttemptView | null => {
  if (!isRecord(value)) return null;
  if (typeof value.attemptId !== 'string' || typeof value.specId !== 'string') return null;
  if (typeof value.state !== 'string') return null;
  if (typeof value.createdAt !== 'number') return null;
  // Keep an attempt visible when a newer service adds a state. Unknown is a
  // terminal-looking fact, but it must remain distinct from known terminals
  // so the UI does not offer an action the service cannot honour.
  const state = ATTEMPT_STATES.has(value.state) ? value.state : 'unknown';
  return { ...value, state } as unknown as ExperimentAttemptView;
};

const parseArtifact = (value: unknown): ExperimentArtifactView | null => {
  if (!isRecord(value)) return null;
  if (typeof value.artifactId !== 'string' || typeof value.attemptId !== 'string') return null;
  if (typeof value.name !== 'string' || typeof value.kind !== 'string' || typeof value.state !== 'string') return null;
  return value as unknown as ExperimentArtifactView;
};

const parseMachine = (value: unknown): ResourceMachineView | null => {
  if (!isRecord(value)) return null;
  if (typeof value.machineId !== 'string' || typeof value.kind !== 'string') return null;
  if (typeof value.state !== 'string') return null;
  if (!isRecord(value.connection) || typeof value.connection.status !== 'string') return null;
  if (!Array.isArray(value.commitments) || !Array.isArray(value.queued)) return null;
  return value as unknown as ResourceMachineView;
};

const parseSource = (value: unknown): ResearchSourceView | null => {
  if (!isRecord(value)) return null;
  if (typeof value.sourceId !== 'string' || typeof value.kind !== 'string') return null;
  if (typeof value.createdAt !== 'number') return null;
  return value as unknown as ResearchSourceView;
};

const readJson = async (response: Response): Promise<unknown> => {
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Research facts request failed (${response.status})`);
  }
  return response.json() as Promise<unknown>;
};

/**
 * Returns `null` when the session is not bound to a harness workspace — an
 * empty snapshot would falsely claim "no experiments" for a scope that does
 * not exist yet.
 */
export const loadResearchFacts = async (
  sessionId: string,
  signal?: AbortSignal,
): Promise<ResearchFactsSnapshot | null> => {
  const base = `/api/harness/sessions/${encodeURIComponent(sessionId)}`;
  const init: RequestInit = { cache: 'no-store', ...(signal ? { signal } : {}) };
  const [experimentsBody, resourcesBody, sourcesBody] = await Promise.all([
    runtimeFetch(`${base}/experiments`, init).then(readJson),
    runtimeFetch(`${base}/resources`, init).then(readJson),
    runtimeFetch(`${base}/sources`, init).then(readJson),
  ]);
  if (experimentsBody === null && resourcesBody === null && sourcesBody === null) return null;
  const attempts = isRecord(experimentsBody) && Array.isArray(experimentsBody.attempts)
    ? experimentsBody.attempts.map(parseAttempt).filter((entry): entry is ExperimentAttemptView => entry !== null)
    : [];
  const machines = isRecord(resourcesBody) && Array.isArray(resourcesBody.machines)
    ? resourcesBody.machines.map(parseMachine).filter((entry): entry is ResourceMachineView => entry !== null)
    : [];
  const sources = isRecord(sourcesBody) && Array.isArray(sourcesBody.sources)
    ? sourcesBody.sources.map(parseSource).filter((entry): entry is ResearchSourceView => entry !== null)
    : [];
  const generatedAt = isRecord(resourcesBody) && typeof resourcesBody.generatedAt === 'number'
    ? resourcesBody.generatedAt
    : Date.now();
  return { attempts, machines, sources, generatedAt };
};

export const loadResearchAttemptDetails = async (
  sessionId: string,
  attemptId: string,
  signal?: AbortSignal,
): Promise<ResearchAttemptDetails | null> => {
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/experiments/${encodeURIComponent(attemptId)}`,
    { cache: 'no-store', ...(signal ? { signal } : {}) },
  );
  const body = await readJson(response);
  if (body === null || !isRecord(body)) return null;
  const attempt = parseAttempt(body.attempt);
  if (!attempt) throw new Error('Research attempt details are malformed');
  const artifacts = Array.isArray(body.artifacts)
    ? body.artifacts.map(parseArtifact).filter((entry): entry is ExperimentArtifactView => entry !== null)
    : [];
  return { attempt, artifacts };
};

export const loadResearchAttemptLogs = async (
  sessionId: string,
  attemptId: string,
  options: { stream: 'stdout' | 'stderr'; offset?: number; maxBytes?: number },
  signal?: AbortSignal,
): Promise<ExperimentLogsResult | null> => {
  const query = new URLSearchParams({ stream: options.stream });
  if (options.offset !== undefined) query.set('offset', String(options.offset));
  if (options.maxBytes !== undefined) query.set('maxBytes', String(options.maxBytes));
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/experiments/${encodeURIComponent(attemptId)}/logs?${query.toString()}`,
    { cache: 'no-store', ...(signal ? { signal } : {}) },
  );
  const body = await readJson(response);
  if (body === null || !isRecord(body) || typeof body.text !== 'string') return null;
  return body as unknown as ExperimentLogsResult;
};

export const loadResearchArtifact = async (
  sessionId: string,
  attemptId: string,
  artifactId: string,
): Promise<Blob> => {
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/experiments/${encodeURIComponent(attemptId)}/artifacts/${encodeURIComponent(artifactId)}`,
    { cache: 'no-store' },
  );
  if (!response.ok) throw new Error(`Artifact request failed (${response.status})`);
  return response.blob();
};

export const cancelResearchAttempt = async (sessionId: string, attemptId: string): Promise<void> => {
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/experiments/${encodeURIComponent(attemptId)}/cancel`,
    { method: 'POST', cache: 'no-store' },
  );
  if (!response.ok) throw new Error(`Cancel failed (${response.status})`);
};

export const collectResearchAttempt = async (sessionId: string, attemptId: string): Promise<ExperimentCollectResult> => {
  const response = await runtimeFetch(
    `/api/harness/sessions/${encodeURIComponent(sessionId)}/experiments/${encodeURIComponent(attemptId)}/collect`,
    { method: 'POST', cache: 'no-store' },
  );
  if (!response.ok) throw new Error(`Collect failed (${response.status})`);
  const body = await response.json() as unknown;
  if (!isRecord(body)) throw new Error('Collect response is malformed');
  const attempt = parseAttempt(body.attempt);
  if (!attempt) throw new Error('Collect response is missing the attempt');
  const artifacts = Array.isArray(body.artifacts)
    ? body.artifacts.map(parseArtifact).filter((entry): entry is ExperimentArtifactView => entry !== null)
    : [];
  return { attempt, artifacts };
};
