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
  'hover',
  'definition',
  'references',
  'documentSymbols',
  'workspaceSymbols',
  'rename',
  'codeActions',
  'restart',
  'disposeWorkspace',
  'registerProvider',
]);

export const createLanguageCapabilityHandler = (language) => async (method, params) => {
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
    await language.disposeWorkspace(params?.workspaceId ?? params);
    return { status: 'disposed' };
  }
  return language[method](params);
};
