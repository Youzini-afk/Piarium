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
  jsonc: 'json',
  json5: 'json',
  jsonl: 'json',
  ndjson: 'json',
  geojson: 'json',
  md: 'markdown',
  mdx: 'mdx',
  css: 'css',
  html: 'html',
  htm: 'html',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  yaml: 'yaml',
  yml: 'yaml',
};

type LanguageDefinition = {
  id: string;
  extensions?: string[];
  filenames?: string[];
  filenamePatterns?: string[];
};

const filenameFromResourceId = (resourceId: string): string => (
  resourceId.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
);

const patternMatchesFilename = (pattern: string, filename: string): boolean => {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__PIARIUM_GLOBSTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__PIARIUM_GLOBSTAR__/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i').test(filename);
};

export const languageIdFromResourceId = (resourceId: string): string => {
  const name = filenameFromResourceId(resourceId);
  const index = name.lastIndexOf('.');
  const extension = index >= 0 ? name.slice(index + 1) : '';
  return LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext';
};

export const monacoLanguageIdFromResourceId = (
  resourceId: string,
  definitions: readonly LanguageDefinition[],
): string => {
  const filename = filenameFromResourceId(resourceId);
  if (!filename) return monacoLanguageIdForHostLanguage(languageIdFromResourceId(resourceId));
  const exact = definitions.find((definition) => (
    definition.filenames?.some((candidate) => candidate.toLowerCase() === filename)
  ));
  if (exact) return exact.id;
  const patterned = definitions.find((definition) => (
    definition.filenamePatterns?.some((pattern) => patternMatchesFilename(pattern, filename))
  ));
  if (patterned) return patterned.id;
  const byExtension = definitions
    .flatMap((definition) => (definition.extensions ?? []).map((extension) => ({
      id: definition.id,
      extension: extension.toLowerCase(),
    })))
    .filter(({ extension }) => filename.endsWith(extension))
    .sort((left, right) => right.extension.length - left.extension.length)[0];
  return byExtension?.id ?? monacoLanguageIdForHostLanguage(languageIdFromResourceId(resourceId));
};

export const languageIdsFromResourceId = (
  resourceId: string,
  definitions: readonly LanguageDefinition[],
): { hostLanguageId: string; monacoLanguageId: string } => {
  const staticHostLanguageId = languageIdFromResourceId(resourceId);
  const monacoLanguageId = monacoLanguageIdFromResourceId(resourceId, definitions);
  return {
    hostLanguageId: staticHostLanguageId === 'plaintext' ? monacoLanguageId : staticHostLanguageId,
    monacoLanguageId,
  };
};

export const monacoLanguageIdForHostLanguage = (languageId: string): string => {
  if (languageId === 'typescriptreact') return 'typescript';
  if (languageId === 'javascriptreact') return 'javascript';
  return languageId;
};
