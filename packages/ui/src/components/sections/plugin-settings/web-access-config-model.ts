import type { JsonValue } from '@piarium/protocol';
import {
  hasJsonPath,
  readJsonPath,
  type JsonObject,
} from './plugin-config-model';

export const WEB_ACCESS_RESOLVED_PROVIDERS = [
  'openai',
  'brave',
  'parallel',
  'tinyfish',
  'search1api',
  'searchinfinity',
  'querit',
  'tavily',
  'serpdive',
  'anysearch',
  'searxng',
  'exa',
  'perplexity',
  'gemini',
] as const;

export const WEB_ACCESS_SEARCH_PROVIDERS = [
  'auto',
  'all',
  ...WEB_ACCESS_RESOLVED_PROVIDERS,
] as const;

export const WEB_ACCESS_FALLBACK_KINDS = ['transient', 'quota', 'network'] as const;

export const WEB_ACCESS_CREDENTIAL_KEYS = [
  'openaiApiKey',
  'braveApiKey',
  'parallelApiKey',
  'tinyfishApiKey',
  'search1apiApiKey',
  'searchinfinityApiKey',
  'queritApiKey',
  'tavilyApiKey',
  'serpdiveApiKey',
  'anysearchApiKey',
  'firecrawlApiKey',
  'exaApiKey',
  'perplexityApiKey',
  'geminiApiKey',
  'cloudflareApiKey',
] as const;

export type WebAccessPanel = 'routing' | 'providers' | 'curator' | 'content' | 'security';
export type WebAccessRoutingMode = 'auto' | 'single' | 'concurrent' | 'all' | 'fallback';
export type WebAccessCuratorMode = 'local' | 'derived' | 'custom';

export type WebAccessDraftIssue = {
  code: 'invalid-value';
  field: string;
};

const TOOL_NAME_DEFAULTS = {
  webSearch: 'web_search',
  sourceCheck: 'source_check',
  fetchContent: 'fetch_content',
  getSearchContent: 'get_search_content',
} as const;

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV_CREDENTIAL_PATTERN = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;

const COMMON_BOOLEAN_PATHS: readonly (readonly string[])[] = [
  ['webSearch', 'enabled'],
  ['autoOpenBrowser'],
  ['allowBrowserCookies'],
  ['githubClone', 'enabled'],
  ['youtube', 'enabled'],
  ['video', 'enabled'],
  ['firecrawlFreshScrape'],
  ['ssrf', 'trustEnvProxy'],
];

const isObject = (value: JsonValue | undefined): value is JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const normalizedString = (value: JsonValue | undefined): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

function configuredProviderValue(draft: JsonObject): JsonValue | undefined {
  return hasJsonPath(draft, ['searchProvider'])
    ? readJsonPath(draft, ['searchProvider'])
    : readJsonPath(draft, ['provider']);
}

export function webAccessProviderPath(draft: JsonObject): readonly ['searchProvider'] | readonly ['provider'] {
  return hasJsonPath(draft, ['searchProvider']) ? ['searchProvider'] : ['provider'];
}

export function webAccessProviderValue(draft: JsonObject): JsonValue | undefined {
  return configuredProviderValue(draft);
}

export function webAccessRoutingMode(draft: JsonObject): WebAccessRoutingMode {
  const configured = configuredProviderValue(draft);
  if (Array.isArray(configured)) return 'concurrent';
  if (typeof configured === 'string') {
    const normalized = configured.trim().toLowerCase();
    if (normalized === 'all') return 'all';
    if (normalized && normalized !== 'auto') return 'single';
    return 'auto';
  }
  return isObject(readJsonPath(draft, ['searchRouting'])) ? 'fallback' : 'auto';
}

export function webAccessCuratorMode(draft: JsonObject): WebAccessCuratorMode {
  const value = readJsonPath(draft, ['curatorRemote']);
  if (value === true) return 'derived';
  if (isObject(value)) return 'custom';
  return 'local';
}

export function webAccessCuratorRemoteEnabled(draft: JsonObject): boolean {
  return webAccessCuratorMode(draft) !== 'local';
}

function validProviderSelection(value: JsonValue | undefined): boolean {
  if (typeof value === 'string') {
    return (WEB_ACCESS_SEARCH_PROVIDERS as readonly string[]).includes(value.trim().toLowerCase());
  }
  if (!Array.isArray(value) || value.length === 0) return false;
  const providers = value.map((entry) => (
    typeof entry === 'string' ? entry.trim().toLowerCase() : ''
  ));
  return providers.every((provider) => (
    (WEB_ACCESS_RESOLVED_PROVIDERS as readonly string[]).includes(provider)
  )) && new Set(providers).size === providers.length;
}

function validCredentialSource(value: JsonValue | undefined): boolean {
  if (typeof value !== 'string') return false;
  const source = value.trim();
  if (!source) return true;
  if (source.startsWith('$$') || source.startsWith('$!')) return true;
  if (source.startsWith('$')) return ENV_CREDENTIAL_PATTERN.test(source);
  if (source.startsWith('!')) return source.slice(1).trim().length > 0;
  return true;
}

function validHttpUrl(value: JsonValue | undefined, forbidCredentials: boolean): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (!forbidCredentials || (!url.username && !url.password));
  } catch {
    return false;
  }
}

function validHostname(value: string): boolean {
  const hostname = value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || /\s|[\\/?#@]/.test(hostname)) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return hostname.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  if (hostname.includes(':')) {
    try {
      return new URL(`http://[${hostname}]/`).hostname.length > 0;
    } catch {
      return false;
    }
  }
  return hostname.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname);
}

function validCidr(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const slash = trimmed.lastIndexOf('/');
  const address = slash >= 0 ? trimmed.slice(0, slash) : trimmed;
  const prefixText = slash >= 0 ? trimmed.slice(slash + 1) : undefined;
  if (prefixText !== undefined && !/^\d+$/.test(prefixText)) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
    if (!address.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)) return false;
    const prefix = prefixText === undefined ? 32 : Number(prefixText);
    return prefix >= 1 && prefix <= 32;
  }
  if (!address.includes(':')) return false;
  try {
    new URL(`http://[${address}]/`);
  } catch {
    return false;
  }
  const prefix = prefixText === undefined ? 128 : Number(prefixText);
  return prefix >= 1 && prefix <= 128;
}

function invalidStringArray(
  value: JsonValue | undefined,
  validate?: (value: string) => boolean,
): boolean {
  return !Array.isArray(value) || value.some((entry) => (
    typeof entry !== 'string' || (validate ? !validate(entry) : false)
  ));
}

export function webAccessDraftIssue(draft: JsonObject): WebAccessDraftIssue | null {
  for (const path of COMMON_BOOLEAN_PATHS) {
    if (hasJsonPath(draft, path) && typeof readJsonPath(draft, path) !== 'boolean') {
      return { code: 'invalid-value', field: path.join('.') };
    }
  }

  for (const path of [['provider'], ['searchProvider']] as const) {
    if (hasJsonPath(draft, path) && !validProviderSelection(readJsonPath(draft, path))) {
      return { code: 'invalid-value', field: path.join('.') };
    }
  }

  const routing = readJsonPath(draft, ['searchRouting']);
  if (routing !== undefined) {
    if (!isObject(routing)) return { code: 'invalid-value', field: 'searchRouting' };
    const providers = routing.providers;
    if (!Array.isArray(providers) || providers.length === 0 || !validProviderSelection(providers)) {
      return { code: 'invalid-value', field: 'searchRouting.providers' };
    }
    const fallbackOn = routing.fallbackOn;
    if (
      !Array.isArray(fallbackOn)
      || fallbackOn.length === 0
      || fallbackOn.some((entry) => (
        typeof entry !== 'string'
        || !(WEB_ACCESS_FALLBACK_KINDS as readonly string[]).includes(entry)
      ))
    ) return { code: 'invalid-value', field: 'searchRouting.fallbackOn' };
  }

  const workflow = readJsonPath(draft, ['workflow']);
  if (workflow !== undefined && !['summary-review', 'auto-summary', 'none'].includes(String(workflow))) {
    return { code: 'invalid-value', field: 'workflow' };
  }

  const toolNames = readJsonPath(draft, ['toolNames']);
  if (toolNames !== undefined) {
    if (!isObject(toolNames)) return { code: 'invalid-value', field: 'toolNames' };
    const resolved: Record<keyof typeof TOOL_NAME_DEFAULTS, string> = { ...TOOL_NAME_DEFAULTS };
    for (const key of Object.keys(TOOL_NAME_DEFAULTS) as Array<keyof typeof TOOL_NAME_DEFAULTS>) {
      const value = toolNames[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !TOOL_NAME_PATTERN.test(value.trim())) {
        return { code: 'invalid-value', field: `toolNames.${key}` };
      }
      resolved[key] = value.trim();
    }
    const registered = readJsonPath(draft, ['webSearch', 'enabled']) === false
      ? [resolved.fetchContent, resolved.getSearchContent]
      : Object.values(resolved);
    if (new Set(registered).size !== registered.length) {
      return { code: 'invalid-value', field: 'toolNames' };
    }
  }

  for (const key of WEB_ACCESS_CREDENTIAL_KEYS) {
    if (hasJsonPath(draft, [key]) && !validCredentialSource(readJsonPath(draft, [key]))) {
      return { code: 'invalid-value', field: key };
    }
  }

  for (const path of [
    ['summaryModel'],
    ['searchModel'],
    ['geminiBaseUrl'],
    ['chromeProfile'],
    ['serpdiveModel'],
    ['githubClone', 'clonePath'],
    ['youtube', 'preferredModel'],
    ['video', 'preferredModel'],
    ['shortcuts', 'curate'],
    ['shortcuts', 'activity'],
  ] as const) {
    if (hasJsonPath(draft, path) && typeof readJsonPath(draft, path) !== 'string') {
      return { code: 'invalid-value', field: path.join('.') };
    }
  }

  for (const [path, min, max] of [
    [['curatorTimeoutSeconds'], 1, 600],
    [['githubClone', 'maxRepoSizeMB'], Number.MIN_VALUE, Number.POSITIVE_INFINITY],
    [['githubClone', 'cloneTimeoutSeconds'], Number.MIN_VALUE, Number.POSITIVE_INFINITY],
    [['video', 'maxSizeMB'], Number.MIN_VALUE, Number.POSITIVE_INFINITY],
    [['pdf', 'maxSizeMB'], Number.MIN_VALUE, 50],
  ] as const) {
    const value = readJsonPath(draft, path);
    if (value !== undefined && (
      typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
    )) return { code: 'invalid-value', field: path.join('.') };
  }

  for (const [path, forbidCredentials] of [
    [['openaiResponsesUrl'], false],
    [['searxngBaseUrl'], true],
    [['firecrawlBaseUrl'], true],
  ] as const) {
    if (hasJsonPath(draft, path) && !validHttpUrl(readJsonPath(draft, path), forbidCredentials)) {
      return { code: 'invalid-value', field: path.join('.') };
    }
  }

  const openaiSearchModel = readJsonPath(draft, ['openaiSearchModel']);
  if (hasJsonPath(draft, ['openaiSearchModel']) && !normalizedString(openaiSearchModel)) {
    return { code: 'invalid-value', field: 'openaiSearchModel' };
  }

  const firecrawlVersion = readJsonPath(draft, ['firecrawlApiVersion']);
  if (
    firecrawlVersion !== undefined
    && (typeof firecrawlVersion !== 'string'
      || !['', 'v1', 'v2'].includes(firecrawlVersion.trim().toLowerCase()))
  ) return { code: 'invalid-value', field: 'firecrawlApiVersion' };

  const fetchContent = readJsonPath(draft, ['fetchContent']);
  if (fetchContent !== undefined && fetchContent !== null && !isObject(fetchContent)) {
    return { code: 'invalid-value', field: 'fetchContent' };
  }
  const domainPolicy = readJsonPath(draft, ['fetchContent', 'domainPolicy']);
  if (domainPolicy !== undefined && domainPolicy !== null && !isObject(domainPolicy)) {
    return { code: 'invalid-value', field: 'fetchContent.domainPolicy' };
  }
  for (const path of [
    ['fetchContent', 'domainPolicy', 'allow'],
    ['fetchContent', 'domainPolicy', 'deny'],
  ] as const) {
    const value = readJsonPath(draft, path);
    if (value !== undefined && value !== null && invalidStringArray(value, validHostname)) {
      return { code: 'invalid-value', field: path.join('.') };
    }
  }

  const ssrf = readJsonPath(draft, ['ssrf']);
  if (ssrf !== undefined && ssrf !== null && !isObject(ssrf)) {
    return { code: 'invalid-value', field: 'ssrf' };
  }
  const allowRanges = readJsonPath(draft, ['ssrf', 'allowRanges']);
  if (allowRanges !== undefined && allowRanges !== null && invalidStringArray(allowRanges, validCidr)) {
    return { code: 'invalid-value', field: 'ssrf.allowRanges' };
  }

  return null;
}
