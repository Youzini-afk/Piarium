import type { JsonValue } from '@piarium/protocol';

export const PERMISSION_SYSTEM_STATUS_CHANNEL = 'pi-permission-system/status/v1';

export interface PermissionSystemPromptSnapshot {
  agentName: string | null;
  forwarding: {
    requesterAgentName: string | null;
    requesterSessionId: string | null;
  } | null;
  requestId: string;
  source: string;
  surface: string | null;
  value: string | null;
}

export interface PermissionSystemDecisionSnapshot {
  agentName: string | null;
  matchedPattern: string | null;
  origin: string | null;
  requestId: string;
  resolution: string;
  result: 'allow' | 'deny';
  surface: string;
  value: string;
}

export interface PermissionSystemStatusSnapshot {
  adjudicatesLocally: boolean;
  lastDecision: PermissionSystemDecisionSnapshot | null;
  pending: PermissionSystemPromptSnapshot[];
  ready: true;
  version: 1;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const nullableString = (value: unknown): string | null | undefined => (
  value === null ? null : typeof value === 'string' ? value : undefined
);

const parseForwarding = (value: unknown): PermissionSystemPromptSnapshot['forwarding'] | undefined => {
  if (value === null) return null;
  const record = asRecord(value);
  if (!record) return undefined;
  const requesterAgentName = nullableString(record.requesterAgentName);
  const requesterSessionId = nullableString(record.requesterSessionId);
  if (requesterAgentName === undefined || requesterSessionId === undefined) return undefined;
  return { requesterAgentName, requesterSessionId };
};

const parsePrompt = (value: unknown): PermissionSystemPromptSnapshot | null => {
  const record = asRecord(value);
  if (!record || typeof record.requestId !== 'string' || typeof record.source !== 'string') return null;
  const agentName = nullableString(record.agentName);
  const forwarding = parseForwarding(record.forwarding);
  const surface = nullableString(record.surface);
  const promptValue = nullableString(record.value);
  if (agentName === undefined || forwarding === undefined || surface === undefined || promptValue === undefined) return null;
  return {
    agentName,
    forwarding,
    requestId: record.requestId,
    source: record.source,
    surface,
    value: promptValue,
  };
};

const parseDecision = (value: unknown): PermissionSystemDecisionSnapshot | null | undefined => {
  if (value === null) return null;
  const record = asRecord(value);
  if (
    !record
    || typeof record.requestId !== 'string'
    || typeof record.resolution !== 'string'
    || (record.result !== 'allow' && record.result !== 'deny')
    || typeof record.surface !== 'string'
    || typeof record.value !== 'string'
  ) return undefined;
  const agentName = nullableString(record.agentName);
  const matchedPattern = nullableString(record.matchedPattern);
  const origin = nullableString(record.origin);
  if (agentName === undefined || matchedPattern === undefined || origin === undefined) return undefined;
  return {
    agentName,
    matchedPattern,
    origin,
    requestId: record.requestId,
    resolution: record.resolution,
    result: record.result,
    surface: record.surface,
    value: record.value,
  };
};

export const parsePermissionSystemStatus = (
  value: JsonValue | undefined,
): PermissionSystemStatusSnapshot | null => {
  const record = asRecord(value);
  if (
    !record
    || record.version !== 1
    || record.ready !== true
    || typeof record.adjudicatesLocally !== 'boolean'
    || !Array.isArray(record.pending)
  ) return null;
  const pending = record.pending.map(parsePrompt);
  const lastDecision = parseDecision(record.lastDecision);
  if (pending.some((entry) => entry === null) || lastDecision === undefined) return null;
  return {
    adjudicatesLocally: record.adjudicatesLocally,
    lastDecision,
    pending: pending as PermissionSystemPromptSnapshot[],
    ready: true,
    version: 1,
  };
};
