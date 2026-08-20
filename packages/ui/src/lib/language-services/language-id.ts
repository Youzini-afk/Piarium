const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescriptreact',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascriptreact',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  json: 'json',
  md: 'markdown',
  css: 'css',
  html: 'html',
};

export const languageIdFromResourceId = (resourceId: string): string => {
  const name = resourceId.split('/').pop()?.toLowerCase() ?? '';
  const index = name.lastIndexOf('.');
  const extension = index >= 0 ? name.slice(index + 1) : '';
  return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext';
};
