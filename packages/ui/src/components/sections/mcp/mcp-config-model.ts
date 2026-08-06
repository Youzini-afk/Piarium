import type { JsonValue } from '@piarium/protocol';
import {
  asJsonObject,
  parseJsoncObject,
  readJsonPath,
  removeJsoncPath,
  updateJsoncPath,
  type JsonObject,
} from '@/components/sections/plugin-settings/plugin-config-model';

export type McpServerTransportMode = 'http' | 'socket' | 'stdio' | 'unconfigured';

const STDIO_FIELDS = ['command', 'args', 'env', 'cwd'] as const;
const HTTP_FIELDS = [
  'url',
  'headers',
  'auth',
  'bearerToken',
  'bearerTokenEnv',
  'oauth',
] as const;
const URL_BOUND_AUTH_FIELDS = ['headers', 'bearerToken', 'bearerTokenEnv'] as const;

export const parseMcpConfigObject = (content: string): JsonObject => parseJsoncObject(content);

export const canLeaveMcpConfigSource = (dirty: boolean): boolean => !dirty;

export const mcpSourceBooleanState = (
  document: JsonObject,
  path: readonly string[],
): 'disabled' | 'enabled' | 'not-set' => {
  const value = readJsonPath(document, path);
  if (value === true) return 'enabled';
  if (value === false) return 'disabled';
  return 'not-set';
};

export const mcpServerNames = (document: JsonObject): string[] => (
  Object.keys(asJsonObject(readJsonPath(document, ['mcpServers'])))
    .sort((left, right) => left.localeCompare(right))
);

export const mcpServerSourceConflicts = (
  sourceServerIndex: Readonly<Record<string, readonly string[]>>,
  sourceOrder: readonly string[],
): Array<[serverName: string, sourceIds: string[]]> => {
  const provenance = new Map<string, string[]>();
  for (const sourceId of sourceOrder) {
    for (const serverName of sourceServerIndex[sourceId] ?? []) {
      const sources = provenance.get(serverName) ?? [];
      if (!sources.includes(sourceId)) sources.push(sourceId);
      provenance.set(serverName, sources);
    }
  }
  return [...provenance.entries()]
    .filter(([, sourceIds]) => sourceIds.length > 1)
    .sort(([left], [right]) => left.localeCompare(right));
};

export const mcpServerTransport = (
  document: JsonObject,
  serverName: string,
): McpServerTransportMode => {
  const server = asJsonObject(readJsonPath(document, ['mcpServers', serverName]));
  if (typeof server.command === 'string') return 'stdio';
  if (typeof server.url === 'string') return 'http';
  if (typeof server.socket === 'string') return 'socket';
  return 'unconfigured';
};

export const setMcpConfigValue = (
  content: string,
  path: readonly string[],
  value: JsonValue,
): string => updateJsoncPath(content, path, value);

export const removeMcpConfigValue = (
  content: string,
  path: readonly string[],
): string => removeJsoncPath(content, path);

export const switchMcpServerTransport = (
  content: string,
  serverName: string,
  transport: McpServerTransportMode,
): string => {
  const document = parseMcpConfigObject(content);
  const server = asJsonObject(readJsonPath(document, ['mcpServers', serverName]));
  let next = content;

  if (transport === 'stdio') {
    next = updateJsoncPath(next, ['mcpServers', serverName, 'command'], (
      typeof server.command === 'string' ? server.command : ''
    ));
    for (const field of [...HTTP_FIELDS, 'socket'] as const) {
      next = removeJsoncPath(next, ['mcpServers', serverName, field]);
    }
    return next;
  }

  if (transport === 'http') {
    next = updateJsoncPath(next, ['mcpServers', serverName, 'url'], (
      typeof server.url === 'string' ? server.url : ''
    ));
    for (const field of [...STDIO_FIELDS, 'socket'] as const) {
      next = removeJsoncPath(next, ['mcpServers', serverName, field]);
    }
    return next;
  }

  if (transport === 'socket') {
    next = updateJsoncPath(next, ['mcpServers', serverName, 'socket'], (
      typeof server.socket === 'string' ? server.socket : ''
    ));
    for (const field of [...STDIO_FIELDS, ...HTTP_FIELDS] as const) {
      next = removeJsoncPath(next, ['mcpServers', serverName, field]);
    }
    return next;
  }

  for (const field of [...STDIO_FIELDS, ...HTTP_FIELDS, 'socket'] as const) {
    next = removeJsoncPath(next, ['mcpServers', serverName, field]);
  }
  return next;
};

export const updateMcpServerUrl = (
  content: string,
  serverName: string,
  url: string,
): string => updateJsoncPath(content, ['mcpServers', serverName, 'url'], url);

/**
 * URL-bound credentials are removed only at the save boundary. Editing an URL
 * is reversible: typing a temporary value and restoring the loaded URL must
 * not silently delete credentials from the draft.
 */
export const prepareMcpConfigForSave = (
  sourceContent: string,
  draftContent: string,
): string => {
  const source = parseMcpConfigObject(sourceContent);
  const draft = parseMcpConfigObject(draftContent);
  const sourceServers = asJsonObject(readJsonPath(source, ['mcpServers']));
  let next = draftContent;

  for (const serverName of Object.keys(sourceServers)) {
    const sourceServer = asJsonObject(sourceServers[serverName]);
    if (typeof sourceServer.url !== 'string') continue;
    const draftServer = asJsonObject(readJsonPath(draft, ['mcpServers', serverName]));
    if (draftServer.url === sourceServer.url) continue;

    for (const field of URL_BOUND_AUTH_FIELDS) {
      next = removeJsoncPath(next, ['mcpServers', serverName, field]);
    }
    if (draftServer.oauth !== false) {
      next = removeJsoncPath(next, ['mcpServers', serverName, 'oauth']);
    }
  }

  return next;
};
