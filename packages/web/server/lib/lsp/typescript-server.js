import { createJsonRpcServer } from './jsonrpc.js';
import { fileURLToPath } from 'node:url';
import { createTypescriptLanguageWorkspace } from './typescript-service.js';

const workspace = createTypescriptLanguageWorkspace();

const uriToFile = (uri) => {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
};

const offsetAt = (text, position) => {
  const lines = text.split('\n');
  let offset = 0;
  for (let index = 0; index < (position?.line ?? 0); index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }
  return offset + (position?.character ?? 0);
};

const publishDiagnostics = (notify, uri, fileName, version) => {
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
  async onRequest(method, params) {
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
  onNotification(method, params) {
    if (method === 'exit') {
      workspace.dispose();
      process.exit(0);
      return;
    }
    if (method === 'textDocument/didOpen') {
      const documentUri = params?.textDocument?.uri;
      const fileName = uriToFile(documentUri);
      workspace.setFile(fileName, params?.textDocument?.text ?? '', params?.textDocument?.version ?? 0);
      publishDiagnostics(server.notify, documentUri, fileName, params?.textDocument?.version ?? 0);
      return;
    }
    if (method === 'textDocument/didChange') {
      const documentUri = params?.textDocument?.uri;
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
