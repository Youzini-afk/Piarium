import { describe, expect, test } from 'bun:test';
import {
  webAccessCuratorMode,
  webAccessDraftIssue,
  webAccessProviderPath,
  webAccessRoutingMode,
} from './web-access-config-model';

describe('Web Access config model', () => {
  test('models provider precedence and every supported routing shape', () => {
    expect(webAccessRoutingMode({})).toBe('auto');
    expect(webAccessRoutingMode({ provider: 'openai' })).toBe('single');
    expect(webAccessRoutingMode({ provider: ['brave', 'exa'] })).toBe('concurrent');
    expect(webAccessRoutingMode({ provider: 'all' })).toBe('all');
    expect(webAccessRoutingMode({
      searchRouting: { providers: ['openai', 'exa'], fallbackOn: ['network'] },
    })).toBe('fallback');
    expect(webAccessRoutingMode({ provider: 'openai', searchProvider: 'brave' })).toBe('single');
    expect(webAccessProviderPath({ provider: 'openai', searchProvider: 'brave' })).toEqual(['searchProvider']);
  });

  test('models local, derived remote, and explicit curator network settings', () => {
    expect(webAccessCuratorMode({})).toBe('local');
    expect(webAccessCuratorMode({ curatorRemote: false })).toBe('local');
    expect(webAccessCuratorMode({ curatorRemote: true })).toBe('derived');
    expect(webAccessCuratorMode({ curatorRemote: { host: 'pi.example', bind: '10.0.0.2' } })).toBe('custom');
    expect(webAccessCuratorMode({ curatorRemote: 'ignored-by-plugin' })).toBe('local');
  });

  test('validates current routing, tool-name, and credential contracts', () => {
    expect(webAccessDraftIssue({
      futureField: { enabled: true },
      provider: ['openai', 'exa'],
      toolNames: { webSearch: 'research_web', futureTool: 'future' },
      braveApiKey: '${BRAVE_KEY}',
    })).toBeNull();

    expect(webAccessDraftIssue({ provider: ['openai', 'all'] })).toEqual({
      code: 'invalid-value',
      field: 'provider',
    });
    expect(webAccessDraftIssue({
      searchRouting: { providers: ['openai', 'openai'], fallbackOn: ['network'] },
    })).toEqual({
      code: 'invalid-value',
      field: 'searchRouting.providers',
    });
    expect(webAccessDraftIssue({
      toolNames: { webSearch: 'duplicate', sourceCheck: 'duplicate' },
    })).toEqual({
      code: 'invalid-value',
      field: 'toolNames',
    });
    expect(webAccessDraftIssue({ geminiApiKey: '$BAD-SOURCE' })).toEqual({
      code: 'invalid-value',
      field: 'geminiApiKey',
    });
    expect(webAccessDraftIssue({
      searchRouting: {
        providers: ['openai', 'exa'],
        fallbackOn: ['network', 'network'],
      },
    })).toBeNull();
  });

  test('validates remote endpoints and security lists without rejecting future keys', () => {
    expect(webAccessDraftIssue({
      firecrawlBaseUrl: 'https://crawl.example.test',
      fetchContent: { domainPolicy: { allow: null, deny: ['private.example.com'] } },
      ssrf: { allowRanges: null, trustEnvProxy: true },
      futureSecurityMode: 'strict',
    })).toBeNull();

    expect(webAccessDraftIssue({ searxngBaseUrl: 'ftp://search.example.test' })).toEqual({
      code: 'invalid-value',
      field: 'searxngBaseUrl',
    });
    expect(webAccessDraftIssue({ fetchContent: { domainPolicy: { deny: ['https://example.com'] } } })).toEqual({
      code: 'invalid-value',
      field: 'fetchContent.domainPolicy.deny',
    });
    expect(webAccessDraftIssue({ ssrf: { allowRanges: ['0.0.0.0/0'] } })).toEqual({
      code: 'invalid-value',
      field: 'ssrf.allowRanges',
    });
    expect(webAccessDraftIssue({ fetchContent: 'not-an-object' })).toEqual({
      code: 'invalid-value',
      field: 'fetchContent',
    });
    expect(webAccessDraftIssue({ fetchContent: { domainPolicy: [] } })).toEqual({
      code: 'invalid-value',
      field: 'fetchContent.domainPolicy',
    });
    expect(webAccessDraftIssue({ ssrf: [] })).toEqual({
      code: 'invalid-value',
      field: 'ssrf',
    });
    expect(webAccessDraftIssue({ pdf: { maxSizeMB: 51 } })).toEqual({
      code: 'invalid-value',
      field: 'pdf.maxSizeMB',
    });
  });
});
