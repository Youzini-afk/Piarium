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

export const mcpServerNames = (document: JsonObject): string[] => (
  Object.keys(asJsonObject(readJsonPath(document, ['mcpServers'])))
    .sort((left, right) => left.localeCompare(right))
);

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
): string => {
  const document = parseMcpConfigObject(content);
  const path = ['mcpServers', serverName] as const;
  const server = asJsonObject(readJsonPath(document, path));
  const previousUrl = server.url;
  let next = updateJsoncPath(content, [...path, 'url'], url);

  if (typeof previousUrl !== 'string' || previousUrl === url) return next;
  for (const field of URL_BOUND_AUTH_FIELDS) {
    next = removeJsoncPath(next, [...path, field]);
  }
  if (server.oauth !== false) next = removeJsoncPath(next, [...path, 'oauth']);
  return next;
};
