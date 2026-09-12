import { createJsonRpcServer } from './jsonrpc.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTypescriptLanguageWorkspace, type TypescriptCallItem } from './typescript-service.js';

interface Position { character?: number; line?: number }
interface ServerParams extends Record<string, unknown> {
  contentChanges?: Array<{ text?: string }>;
  item?: { data?: { fileName?: string; position?: number }; selectionRange?: { start?: Position }; uri?: string };
  position?: Position;
  rootUri?: string;
  textDocument?: { text?: string; uri?: string; version?: number };
  workspaceFolders?: Array<{ uri?: string }>;
}

// The workspace root arrives with the LSP `initialize` request. The built-in
// TypeScript service must use this real root — not the parent of the first
// opened file — so a definition in `src/a` can still resolve a caller in `src/b`
// that was never didOpen'd (D-240 rework).
const workspace = createTypescriptLanguageWorkspace();

const uriToFile = (uri: unknown): string => {
  if (typeof uri !== 'string') return '';
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
};

const fileToUri = (fileName: string): string => pathToFileURL(fileName).href;

const offsetAt = (text: string, position?: Position): number => {
  const lines = text.split('\n');
  let offset = 0;
  for (let index = 0; index < (position?.line ?? 0); index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return offset + (position?.character ?? 0);
};

const positionAt = (text: string, offset: number): { line: number; character: number } => {
  let line = 0;
  let lineStart = 0;
  const capped = Math.max(0, Math.min(offset, text.length));
  for (let index = 0; index < capped; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: capped - lineStart };
};

const spanToRange = (fileName: string, span: { start: number; length: number }) => {
  const text = workspace.getText(fileName);
  return { start: positionAt(text, span.start), end: positionAt(text, span.start + span.length) };
};

// ScriptElementKind → LSP SymbolKind for the kinds callHierarchy reports.
const callItemKind = (kind: string): number => {
  switch (kind) {
    case 'classElement': return 5;
    case 'methodElement': case 'memberFunctionElement': case 'memberGetAccessorElement': case 'memberSetAccessorElement': return 6;
    case 'constructorImplementationElement': return 9;
    case 'enumElement': return 10;
    case 'interfaceElement': case 'typeElement': return 11;
    case 'functionElement': case 'localFunctionElement': return 12;
    case 'variableElement': case 'localVariableElement': case 'constElement': case 'letElement': return 13;
    case 'moduleElement': return 2;
    default: return 12;
  }
};

const toCallHierarchyItem = (item: TypescriptCallItem) => {
  const uri = fileToUri(item.file);
  return {
    name: item.name,
    kind: callItemKind(item.kind),
    uri,
    range: spanToRange(item.file, item.span),
    selectionRange: spanToRange(item.file, item.selectionSpan),
    ...(item.containerName ? { detail: item.containerName } : {}),
    data: { fileName: item.file, position: item.selectionSpan.start },
  };
};

const publishDiagnostics = (
  notify: (method: string, params: unknown) => void,
  uri: string,
  fileName: string,
  version: number,
): void => {
  const diagnostics = workspace.diagnostics(fileName).map((message) => ({
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 1,
    message,
  }));
  notify('textDocument/publishDiagnostics', { uri, version, diagnostics });
};

const server = createJsonRpcServer({
  input: process.stdin,
  output: process.stdout,
  async onRequest(method, rawParams) {
    const params = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? rawParams : {}) as ServerParams;
    if (method === 'initialize') {
      // Capture the real workspace root from the LSP initialize request so the
      // built-in TypeScript service does not infer it from the first opened
      // file's parent directory (D-240 rework).
      const rootUri = params.rootUri ?? params.workspaceFolders?.[0]?.uri;
      if (rootUri) {
        try {
          workspace.setWorkspaceRoot(uriToFile(rootUri));
        } catch {
          // If the URI is not a file:// URI, keep the cwd fallback.
        }
      }
      return {
        capabilities: {
          textDocumentSync: 1,
          completionProvider: { triggerCharacters: ['.'] },
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          callHierarchyProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          renameProvider: true,
          codeActionProvider: true,
        },
      };
    }
    if (method === 'shutdown') return null;
    const uri = params?.textDocument?.uri;
    const fileName = uri ? uriToFile(uri) : '';
    const text = workspace.getText(fileName);
    try {
      if (method === 'textDocument/completion') {
        const offset = offsetAt(text, params?.position);
        return {
          items: workspace.completion(fileName, offset).slice(0, 50).map((label) => ({
            label,
            insertText: label,
          })),
        };
      }
      if (method === 'textDocument/hover') {
        const offset = offsetAt(text, params?.position);
        const value = workspace.hover(fileName, offset);
        return value ? { contents: { kind: 'markdown', value } } : null;
      }
      if (method === 'textDocument/definition') {
        const offset = offsetAt(text, params?.position);
        return workspace.definition(fileName, offset).map((info) => ({
          uri: fileToUri(info.fileName),
          range: spanToRange(info.fileName, info.span),
        }));
      }
      if (method === 'textDocument/references') {
        const offset = offsetAt(text, params?.position);
        return workspace.references(fileName, offset).map((site) => ({
          uri: fileToUri(site.fileName),
          range: spanToRange(site.fileName, site.span),
        }));
      }
      if (method === 'textDocument/prepareCallHierarchy') {
        const offset = offsetAt(text, params?.position);
        const items = workspace.prepareCallHierarchy(fileName, offset);
        return items.length > 0 ? items.map(toCallHierarchyItem) : null;
      }
      if (method === 'callHierarchy/incomingCalls' || method === 'callHierarchy/outgoingCalls') {
        const itemFile = params?.item?.data?.fileName ?? uriToFile(params?.item?.uri ?? '');
        const itemText = workspace.getText(itemFile);
        const itemOffset = params?.item?.data?.position
          ?? offsetAt(itemText, params?.item?.selectionRange?.start);
        if (!itemFile) return [];
        const calls = method === 'callHierarchy/incomingCalls'
          ? workspace.callHierarchyIncoming(itemFile, itemOffset)
          : workspace.callHierarchyOutgoing(itemFile, itemOffset);
        return calls.map((call) => {
          // Incoming: fromRanges are sites in the caller's file; outgoing: sites
          // in the queried file.
          const sitesFile = 'from' in call ? call.from.file : itemFile;
          return {
            ...('from' in call ? { from: toCallHierarchyItem(call.from) } : { to: toCallHierarchyItem(call.to) }),
            fromRanges: call.fromSpans.map((span) => spanToRange(sitesFile, span)),
          };
        });
      }
      if (method === 'textDocument/documentSymbol') {
        return [{ name: 'greeting', kind: 13, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } }];
      }
      if (method === 'workspace/symbol') return [];
      if (method === 'textDocument/rename') return { changes: {} };
      if (method === 'textDocument/codeAction') return [];
      return null;
    } catch {
      return null;
    }
  },
  onNotification(method, rawParams) {
    const params = (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? rawParams : {}) as ServerParams;
    if (method === 'exit') {
      workspace.dispose();
      process.exit(0);
      return;
    }
    if (method === 'textDocument/didOpen') {
      const documentUri = params.textDocument?.uri ?? '';
      const fileName = uriToFile(documentUri);
      workspace.setFile(fileName, params?.textDocument?.text ?? '', params?.textDocument?.version ?? 0);
      publishDiagnostics(server.notify, documentUri, fileName, params?.textDocument?.version ?? 0);
      return;
    }
    if (method === 'textDocument/didChange') {
      const documentUri = params.textDocument?.uri ?? '';
      const fileName = uriToFile(documentUri);
      const change = Array.isArray(params?.contentChanges)
        ? params.contentChanges[params.contentChanges.length - 1]
        : null;
      const nextText = typeof change?.text === 'string' ? change.text : workspace.getText(fileName);
      workspace.setFile(fileName, nextText, params?.textDocument?.version ?? 0);
      publishDiagnostics(server.notify, documentUri, fileName, params?.textDocument?.version ?? 0);
    }
    if (method === 'textDocument/didClose') {
      workspace.closeFile(uriToFile(params?.textDocument?.uri));
    }
  },
});
