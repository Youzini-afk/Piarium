import { createJsonRpcServer } from './jsonrpc.js';
import { fileURLToPath } from 'node:url';
import { createTypescriptLanguageWorkspace } from './typescript-service.js';

const workspace = createTypescriptLanguageWorkspace();

interface Position { character?: number; line?: number }
interface ServerParams extends Record<string, unknown> {
  contentChanges?: Array<{ text?: string }>;
  position?: Position;
  textDocument?: { text?: string; uri?: string; version?: number };
}

const uriToFile = (uri: unknown): string => {
  if (typeof uri !== 'string') return '';
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
};

const offsetAt = (text: string, position?: Position): number => {
  const lines = text.split('\n');
  let offset = 0;
  for (let index = 0; index < (position?.line ?? 0); index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return offset + (position?.character ?? 0);
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
      return {
        capabilities: {
          textDocumentSync: 1,
          completionProvider: { triggerCharacters: ['.'] },
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
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
      if (method === 'textDocument/definition' || method === 'textDocument/references') {
        return uri ? [{ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] : [];
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
