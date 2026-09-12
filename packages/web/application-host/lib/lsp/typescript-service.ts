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

export interface TypescriptTextSpan {
  start: number;
  length: number;
}

export interface TypescriptCallItem {
  name: string;
  kind: string;
  containerName?: string;
  file: string;
  span: TypescriptTextSpan;
  selectionSpan: TypescriptTextSpan;
}

export interface TypescriptLanguageWorkspace {
  callHierarchyIncoming(fileName: string, offset: number): Array<{ from: TypescriptCallItem; fromSpans: TypescriptTextSpan[] }>;
  callHierarchyOutgoing(fileName: string, offset: number): Array<{ to: TypescriptCallItem; fromSpans: TypescriptTextSpan[] }>;
  closeFile(fileName: string): void;
  completion(fileName: string, offset: number): string[];
  definition(fileName: string, offset: number): Array<{ fileName: string; span: TypescriptTextSpan }>;
  diagnostics(fileName: string): string[];
  dispose(): void;
  getText(fileName: string): string;
  hover(fileName: string, offset: number): string;
  prepareCallHierarchy(fileName: string, offset: number): TypescriptCallItem[];
  references(fileName: string, offset: number): Array<{ fileName: string; span: TypescriptTextSpan }>;
  setFile(fileName: string, text: string, version: number): void;
  /**
   * Set the workspace root from the LSP `initialize` request. The project-wide
   * disk scan and `getCurrentDirectory` use this root once set (D-240 rework).
   */
  setWorkspaceRoot(root: string): void;
}

export interface TypescriptWorkspaceOptions {
  /**
   * Workspace root from the LSP `initialize` request (`rootUri` /
   * `workspaceFolders[0].uri`). The program's `getCurrentDirectory` and the
   * lazy project-wide disk scan use this root — never the parent directory of
   * the first opened file, which would misidentify the root when the first
   * opened file lives in a subdirectory (D-240 rework).
   */
  workspaceRoot?: string;
}

export const createTypescriptLanguageWorkspace = (options: TypescriptWorkspaceOptions = {}): TypescriptLanguageWorkspace => {
  const files = new Map<string, string>();
  const versions = new Map<string, number>();
  // Project-wide disk membership is enabled lazily by the relation queries
  // (references / call hierarchy): a whole-root scan on every program build
  // would make hover/diagnostics pay for a directory walk they never need.
  let projectDiskFiles: string[] | null = null;
  let projectVersion = 0;
  // Mutable so the LSP `initialize` request can set the real workspace root
  // after the workspace is constructed (D-240 rework).
  let workspaceRoot = options.workspaceRoot;

  const rootOf = (): string => {
    if (workspaceRoot) return workspaceRoot;
    // No initialize root: fall back to cwd rather than guessing from the first
    // opened file's parent — a file in `src/a` would otherwise make `src/a`
    // the project root and hide callers in `src/b` (D-240 rework).
    return process.cwd();
  };

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getProjectVersion: () => String(projectVersion),
    // With project membership enabled, the program includes every script under
    // the workspace root, not just didOpen'd files — a real project load.
    // Unopened members are read through readFile/ts.sys below, which is exactly
    // what "the language server read the file itself" means for cross-file
    // results.
    getScriptFileNames: () => [...new Set([...files.keys(), ...(projectDiskFiles ?? [])])],
    getScriptVersion: (fileName) => String(versions.get(normalizeFileName(fileName)) ?? 0),
    getScriptSnapshot: (fileName) => {
      const normalized = normalizeFileName(fileName);
      const text = files.get(normalized) ?? ts.sys.readFile(normalized);
      if (typeof text !== 'string') return undefined;
      return ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: rootOf,
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

  /**
   * Extend the program to every script under the workspace root once — the
   * stand-in for a real project load — then refresh so the language service
   * picks the membership up. Only relation queries pay for it.
   */
  const ensureProjectFiles = (): void => {
    if (projectDiskFiles !== null || files.size === 0) return;
    projectDiskFiles = ts.sys.readDirectory(
      rootOf(),
      ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
      ['node_modules'],
      ['**/*'],
      8,
    ).map(normalizeFileName);
    projectVersion += 1;
    refresh();
  };

  const callItem = (item: ts.CallHierarchyItem): TypescriptCallItem => ({
    name: item.name,
    kind: item.kind,
    ...(item.containerName ? { containerName: item.containerName } : {}),
    file: item.file,
    span: { start: item.span.start, length: item.span.length },
    selectionSpan: { start: item.selectionSpan.start, length: item.selectionSpan.length },
  });

  return {
    setFile,
    closeFile,
    getText(fileName: string): string {
      const normalized = lookup(fileName);
      return files.get(normalized) ?? ts.sys.readFile(normalized) ?? '';
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
    definition(fileName: string, offset: number): Array<{ fileName: string; span: TypescriptTextSpan }> {
      const infos = service.getDefinitionAtPosition(lookup(fileName), offset) ?? [];
      return infos.map((info) => ({
        fileName: info.fileName,
        span: { start: info.textSpan.start, length: info.textSpan.length },
      }));
    },
    references(fileName: string, offset: number): Array<{ fileName: string; span: TypescriptTextSpan }> {
      ensureProjectFiles();
      const symbols = service.findReferences(lookup(fileName), offset) ?? [];
      const sites: Array<{ fileName: string; span: TypescriptTextSpan }> = [];
      for (const symbol of symbols) {
        for (const reference of symbol.references) {
          sites.push({
            fileName: reference.fileName,
            span: { start: reference.textSpan.start, length: reference.textSpan.length },
          });
        }
      }
      return sites;
    },
    prepareCallHierarchy(fileName: string, offset: number): TypescriptCallItem[] {
      ensureProjectFiles();
      const prepared = service.prepareCallHierarchy(lookup(fileName), offset);
      const items = Array.isArray(prepared) ? prepared : prepared ? [prepared] : [];
      return items.map(callItem);
    },
    callHierarchyIncoming(fileName: string, offset: number): Array<{ from: TypescriptCallItem; fromSpans: TypescriptTextSpan[] }> {
      ensureProjectFiles();
      const calls = service.provideCallHierarchyIncomingCalls(lookup(fileName), offset) ?? [];
      return calls.map((call) => ({
        from: callItem(call.from),
        fromSpans: call.fromSpans.map((span) => ({ start: span.start, length: span.length })),
      }));
    },
    callHierarchyOutgoing(fileName: string, offset: number): Array<{ to: TypescriptCallItem; fromSpans: TypescriptTextSpan[] }> {
      ensureProjectFiles();
      const calls = service.provideCallHierarchyOutgoingCalls(lookup(fileName), offset) ?? [];
      return calls.map((call) => ({
        to: callItem(call.to),
        fromSpans: call.fromSpans.map((span) => ({ start: span.start, length: span.length })),
      }));
    },
    dispose(): void {
      service.dispose();
    },
    setWorkspaceRoot(root: string): void {
      const normalized = root.replace(/\\/g, '/');
      if (workspaceRoot === normalized) return;
      workspaceRoot = normalized;
      // A new root changes the project-wide disk scan and `getCurrentDirectory`;
      // reset the lazy scan and rebuild the language service.
      projectDiskFiles = null;
      projectVersion += 1;
      refresh();
    },
  };
};
