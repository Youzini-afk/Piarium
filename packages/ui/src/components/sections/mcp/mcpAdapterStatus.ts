import type { JsonValue } from '@piarium/protocol';

export const MCP_ADAPTER_STATUS_CHANNEL = 'pi-mcp-adapter/status/v1';

export type McpAdapterServerStatus =
  | 'connected'
  | 'cached'
  | 'failed'
  | 'needs-auth'
  | 'not-connected'
  | 'disabled';

export interface McpAdapterServerSnapshot {
  disabled: boolean;
  failedAgoSeconds?: number;
  name: string;
  resourceCount?: number;
  status: McpAdapterServerStatus;
  toolCount: number;
}

export interface McpAdapterStatusSnapshot {
  connectedCount: number;
  disabledCount: number;
  servers: McpAdapterServerSnapshot[];
  totalResources: number;
  totalTools: number;
  version: 1;
}

const STATUSES = new Set<McpAdapterServerStatus>([
  'connected',
  'cached',
  'failed',
  'needs-auth',
  'not-connected',
  'disabled',
]);

const isRecord = (value: JsonValue | undefined): value is Record<string, JsonValue> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isNumber = (value: JsonValue | undefined): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

export function parseMcpAdapterStatus(value: JsonValue | undefined): McpAdapterStatusSnapshot | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.servers)) return null;
  if (
    !isNumber(value.connectedCount)
    || !isNumber(value.disabledCount)
    || !isNumber(value.totalResources)
    || !isNumber(value.totalTools)
  ) return null;

  const servers: McpAdapterServerSnapshot[] = [];
  for (const candidate of value.servers) {
    if (
      !isRecord(candidate)
      || typeof candidate.name !== 'string'
      || typeof candidate.status !== 'string'
      || !STATUSES.has(candidate.status as McpAdapterServerStatus)
      || typeof candidate.disabled !== 'boolean'
      || !isNumber(candidate.toolCount)
      || (candidate.resourceCount !== undefined && !isNumber(candidate.resourceCount))
      || (candidate.failedAgoSeconds !== undefined && !isNumber(candidate.failedAgoSeconds))
    ) return null;
    servers.push({
      disabled: candidate.disabled,
      ...(candidate.failedAgoSeconds === undefined
        ? {}
        : { failedAgoSeconds: candidate.failedAgoSeconds }),
      name: candidate.name,
      ...(candidate.resourceCount === undefined ? {} : { resourceCount: candidate.resourceCount }),
      status: candidate.status as McpAdapterServerStatus,
      toolCount: candidate.toolCount,
    });
  }

  return {
    connectedCount: value.connectedCount,
    disabledCount: value.disabledCount,
    servers,
    totalResources: value.totalResources,
    totalTools: value.totalTools,
    version: 1,
  };
}
