import { toJsonValue, type JsonCapabilityHandler } from '../extensions/json-value.js';

const SEARCH_METHODS = new Set(['searchContent']);

export const createWorkspaceSearchCapabilityHandler = (search: {
  searchContent(params: Record<string, unknown>): unknown;
}): JsonCapabilityHandler => async (method, params) => {
  if (!SEARCH_METHODS.has(method)) {
    throw new Error(`workspace.search does not implement ${method}`);
  }
  return toJsonValue(await search.searchContent(params && typeof params === 'object' ? params as Record<string, unknown> : {}));
};

const LANGUAGE_METHODS = new Set([
  'getStatus',
  'syncDocument',
  'completion',
  'completionResolve',
  'hover',
  'signatureHelp',
  'definition',
  'references',
  'documentSymbols',
  'workspaceSymbols',
  'rename',
  'codeActions',
  'codeActionResolve',
  'executeCommand',
  'documentFormatting',
  'documentRangeFormatting',
  'onTypeFormatting',
  'semanticTokens',
  'inlayHints',
  'inlayHintResolve',
  'documentHighlights',
  'foldingRanges',
  'selectionRanges',
  'documentLinks',
  'documentLinkResolve',
  'documentColors',
  'colorPresentations',
  'restart',
  'disposeWorkspace',
  'registerProvider',
  'unregisterProvider',
]);

type LanguageCapability = Record<string, unknown>;

const callLanguage = (language: LanguageCapability, method: string, ...args: unknown[]): unknown => {
  const handler = language[method];
  if (typeof handler !== 'function') throw new Error(`workspace.language method is unavailable: ${method}`);
  return (handler as (...values: unknown[]) => unknown)(...args);
};

export const createLanguageCapabilityHandler = (language: LanguageCapability): JsonCapabilityHandler => async (
  method,
  params,
  context,
) => {
  const result = await (async (): Promise<unknown> => {
  if (!LANGUAGE_METHODS.has(method)) {
    throw new Error(`workspace.language does not implement ${method}`);
  }
  if (method === 'getStatus') {
    const input = params && typeof params === 'object' ? params as Record<string, unknown> : {};
    return callLanguage(language, 'getStatus', input.workspaceId, input.languageId);
  }
  if (method === 'restart') {
    const input = params && typeof params === 'object' ? params as Record<string, unknown> : {};
    return callLanguage(language, 'restart', input.workspaceId, input.languageId);
  }
  if (method === 'disposeWorkspace') {
    const input = params && typeof params === 'object' ? params as Record<string, unknown> : {};
    await callLanguage(language, 'disposeWorkspace', input.workspaceId ?? params, context?.owner);
    return { status: 'disposed' };
  }
  if (method === 'registerProvider') {
    return callLanguage(language, 'registerProvider', params, context?.owner);
  }
  if (method === 'unregisterProvider') {
    const input = params && typeof params === 'object' ? params as Record<string, unknown> : {};
    return callLanguage(language, 'unregisterProvider', input.providerId, context?.owner);
  }
  return callLanguage(language, method, params);
  })();
  return toJsonValue(result);
};
