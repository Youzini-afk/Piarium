import { describe, expect, test } from 'bun:test';
import { readJsonPath } from '@/components/sections/plugin-settings/plugin-config-model';
import {
  mcpServerNames,
  mcpServerTransport,
  parseMcpConfigObject,
  switchMcpServerTransport,
  updateMcpServerUrl,
} from './mcp-config-model';

describe('MCP native config editing', () => {
  test('discovers current server names and transport without computing merged state', () => {
    const document = parseMcpConfigObject(`{
      "mcpServers": {
        "remote": { "url": "https://example.com/mcp" },
        "local": { "command": "node" }
      }
    }`);
    expect(mcpServerNames(document)).toEqual(['local', 'remote']);
    expect(mcpServerTransport(document, 'local')).toBe('stdio');
    expect(mcpServerTransport(document, 'remote')).toBe('http');
    expect(mcpServerTransport(document, 'future')).toBe('unconfigured');
  });

  test('switches transport in the selected source while preserving unrelated fields and comments', () => {
    const source = `{
      // Pi project override
      "mcpServers": {
        "docs": {
          "url": "https://example.com/mcp",
          "headers": { "Authorization": "$DOCS_TOKEN" },
          "disabled": true,
          "future": { "preserve": true }
        }
      },
      "settings": { "toolPrefix": "short" }
    }`;
    const next = switchMcpServerTransport(source, 'docs', 'stdio');
    const document = parseMcpConfigObject(next);
    expect(next).toContain('// Pi project override');
    expect(readJsonPath(document, ['mcpServers', 'docs'])).toEqual({
      command: '',
      disabled: true,
      future: { preserve: true },
    });
    expect(readJsonPath(document, ['settings'])).toEqual({ toolPrefix: 'short' });
    expect(next).not.toContain('Authorization');
    expect(next).not.toContain('"url"');
  });

  test('clears URL-bound local credentials when repointing a server', () => {
    const source = JSON.stringify({
      mcpServers: {
        docs: {
          auth: 'oauth',
          bearerToken: '$OLD_TOKEN',
          headers: { 'X-Api-Key': '$OLD_KEY' },
          oauth: { clientId: 'old-client', clientSecret: '$OLD_SECRET' },
          trace: true,
          url: 'https://old.example/mcp',
        },
        localPolicy: {
          oauth: false,
          url: 'https://old.example/mcp',
        },
      },
    }, null, 2);

    const changed = parseMcpConfigObject(updateMcpServerUrl(
      source,
      'docs',
      'https://new.example/mcp',
    ));
    expect(readJsonPath(changed, ['mcpServers', 'docs'])).toEqual({
      auth: 'oauth',
      trace: true,
      url: 'https://new.example/mcp',
    });

    const keptFalse = parseMcpConfigObject(updateMcpServerUrl(
      source,
      'localPolicy',
      'https://new.example/mcp',
    ));
    expect(readJsonPath(keptFalse, ['mcpServers', 'localPolicy'])).toEqual({
      oauth: false,
      url: 'https://new.example/mcp',
    });
  });
});
