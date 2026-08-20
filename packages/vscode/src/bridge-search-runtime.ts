import { spawn } from 'node:child_process';
import path from 'node:path';
// @ts-expect-error Shared Application Host content search.
import { createWorkspaceContentSearch } from '../../web/server/lib/search/content.js';
import type { BridgeResponse } from './bridge';

type DocumentAuthority = {
  inspectWorkspace: (workspaceId: string) => Promise<{ workspaceId: string; hostId: string; root: string }>;
};

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

const payloadRecord = (value: unknown): Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

export const handleWorkspaceSearchBridgeMessage = async (
  message: BridgeMessageInput,
  deps: { documents: DocumentAuthority },
): Promise<BridgeResponse | null> => {
  if (message.type !== 'api:workspace:search-content') return null;
  const body = payloadRecord(message.payload);
  const search = createWorkspaceContentSearch({
    documents: deps.documents,
    spawn,
    pathModule: path,
    env: process.env,
  });
  const result = await search.searchContent({
    workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : '',
    query: typeof body.query === 'string' ? body.query : '',
    ...(typeof body.maxResults === 'number' ? { maxResults: body.maxResults } : {}),
    ...(body.includeHidden === true ? { includeHidden: true } : {}),
  }, {
    generation: typeof body.generation === 'number' ? body.generation : 0,
  });
  return { id: message.id, type: message.type, success: true, data: result };
};
