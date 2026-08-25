const SEARCH_METHODS = new Set(['searchContent']);

export const createWorkspaceSearchCapabilityHandler = (search) => async (method, params) => {
  if (!SEARCH_METHODS.has(method)) {
    throw new Error(`workspace.search does not implement ${method}`);
  }
  return search.searchContent(params && typeof params === 'object' ? params : {});
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

export const createLanguageCapabilityHandler = (language) => async (method, params, context) => {
  if (!LANGUAGE_METHODS.has(method)) {
    throw new Error(`workspace.language does not implement ${method}`);
  }
  if (method === 'getStatus') {
    return language.getStatus(params?.workspaceId, params?.languageId);
  }
  if (method === 'restart') {
    return language.restart(params?.workspaceId, params?.languageId);
  }
  if (method === 'disposeWorkspace') {
    await language.disposeWorkspace(params?.workspaceId ?? params, context?.owner);
    return { status: 'disposed' };
  }
  if (method === 'registerProvider') {
    return language.registerProvider(params, context?.owner);
  }
  if (method === 'unregisterProvider') {
    return language.unregisterProvider(params?.providerId, context?.owner);
  }
  return language[method](params);
};
