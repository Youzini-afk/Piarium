import path from 'node:path';
import ts from 'typescript';

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  allowJs: true,
  strict: true,
};

const normalizeFileName = (fileName: string): string => fileName.replace(/\\/g, '/');

export interface TypescriptLanguageWorkspace {
  closeFile(fileName: string): void;
  completion(fileName: string, offset: number): string[];
  diagnostics(fileName: string): string[];
  dispose(): void;
  getText(fileName: string): string;
  hover(fileName: string, offset: number): string;
  setFile(fileName: string, text: string, version: number): void;
}

export const createTypescriptLanguageWorkspace = (): TypescriptLanguageWorkspace => {
  const files = new Map<string, string>();
  const versions = new Map<string, number>();
  let projectVersion = 0;

  const host: ts.LanguageServiceHost = {
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

  const refresh = (): void => {
    service.dispose();
    service = ts.createLanguageService(host, ts.createDocumentRegistry());
  };

  const setFile = (fileName: string, text: string, version: number): void => {
    const normalized = normalizeFileName(fileName);
    files.set(normalized, text);
    versions.set(normalized, version);
    projectVersion += 1;
    refresh();
  };

  const closeFile = (fileName: string): void => {
    const normalized = normalizeFileName(fileName);
    files.delete(normalized);
    versions.delete(normalized);
    projectVersion += 1;
    refresh();
  };

  const lookup = (fileName: string): string => normalizeFileName(fileName);

  return {
    setFile,
    closeFile,
    getText(fileName: string): string {
      return files.get(lookup(fileName)) ?? '';
    },
    diagnostics(fileName: string): string[] {
      const normalized = lookup(fileName);
      return [
        ...service.getSyntacticDiagnostics(normalized),
        ...service.getSemanticDiagnostics(normalized),
      ].map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
    hover(fileName: string, offset: number): string {
      const info = service.getQuickInfoAtPosition(lookup(fileName), offset);
      if (!info) return '';
      return ts.displayPartsToString(info.displayParts);
    },
    completion(fileName: string, offset: number): string[] {
      const info = service.getCompletionsAtPosition(lookup(fileName), offset, undefined);
      return (info?.entries ?? []).map((entry) => entry.name);
    },
    dispose(): void {
      service.dispose();
    },
  };
};
