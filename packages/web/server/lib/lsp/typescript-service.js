import path from 'node:path';
import ts from 'typescript';

const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  allowJs: true,
  strict: true,
};

const normalizeFileName = (fileName) => fileName.replace(/\\/g, '/');

export const createTypescriptLanguageWorkspace = () => {
  const files = new Map();
  const versions = new Map();
  let projectVersion = 0;

  const host = {
    getCompilationSettings: () => compilerOptions,
    getProjectVersion: () => String(projectVersion),
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: (fileName) => String(versions.get(normalizeFileName(fileName)) ?? 0),
  getScriptSnapshot: (fileName) => {
    const text = files.get(normalizeFileName(fileName));
    if (typeof text !== 'string') return undefined;
    return ts.ScriptSnapshot.fromString(text);
  },
    getCurrentDirectory: () => {
      const first = [...files.keys()][0];
      return first ? path.dirname(first) : process.cwd();
    },
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (fileName) => files.has(normalizeFileName(fileName)) || ts.sys.fileExists(fileName),
    readFile: (fileName) => {
      const normalized = normalizeFileName(fileName);
      return files.has(normalized) ? files.get(normalized) : ts.sys.readFile(fileName);
    },
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  let service = ts.createLanguageService(host, ts.createDocumentRegistry());

  const refresh = () => {
    service.dispose();
    service = ts.createLanguageService(host, ts.createDocumentRegistry());
  };

  const setFile = (fileName, text, version) => {
    const normalized = normalizeFileName(fileName);
    files.set(normalized, text);
    versions.set(normalized, version);
    projectVersion += 1;
    refresh();
  };

  const closeFile = (fileName) => {
    const normalized = normalizeFileName(fileName);
    files.delete(normalized);
    versions.delete(normalized);
    projectVersion += 1;
    refresh();
  };

  const lookup = (fileName) => normalizeFileName(fileName);

  return {
    setFile,
    closeFile,
    getText(fileName) {
      return files.get(lookup(fileName)) ?? '';
    },
    diagnostics(fileName) {
      const normalized = lookup(fileName);
      return [
        ...service.getSyntacticDiagnostics(normalized),
        ...service.getSemanticDiagnostics(normalized),
      ].map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
    hover(fileName, offset) {
      const info = service.getQuickInfoAtPosition(lookup(fileName), offset);
      if (!info) return '';
      return ts.displayPartsToString(info.displayParts);
    },
    completion(fileName, offset) {
      const info = service.getCompletionsAtPosition(lookup(fileName), offset, undefined);
      return (info?.entries ?? []).map((entry) => entry.name);
    },
    dispose() {
      service.dispose();
    },
  };
};
