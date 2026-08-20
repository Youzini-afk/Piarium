import { createJsonRpcServer } from './jsonrpc.js';

const files = new Map();

const publish = (server, uri, version, text) => {
  const diagnostics = [];
  if (text.includes('FIXTURE_ERROR')) {
    diagnostics.push({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 1,
      message: 'fixture error',
    });
  }
  server.notify('textDocument/publishDiagnostics', { uri, version, diagnostics });
};

const server = createJsonRpcServer({
  input: process.stdin,
  output: process.stdout,
  async onRequest(method, params) {
    if (method === 'initialize') {
      return {
        capabilities: {
          textDocumentSync: 2,
          completionProvider: {},
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
    if (method === 'textDocument/completion') {
      return { items: [{ label: 'fixtureItem', detail: 'fixture', insertText: 'fixtureItem' }] };
    }
    if (method === 'textDocument/hover') {
      const uri = params?.textDocument?.uri;
      const text = files.get(uri)?.text ?? '';
      if (text.includes('FIXTURE_HOVER_FAIL')) {
        throw new Error('fixture hover failed');
      }
      return { contents: { kind: 'markdown', value: 'fixture-hover' } };
    }
    if (method === 'textDocument/definition' || method === 'textDocument/references') {
      const uri = params?.textDocument?.uri;
      return uri ? [{ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] : [];
    }
    if (method === 'textDocument/documentSymbol') {
      return [{ name: 'fixtureSymbol', kind: 13, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } }];
    }
    if (method === 'workspace/symbol') {
      const uri = [...files.keys()][0];
      if (!uri) return [];
      return [{ name: 'fixtureWorkspaceSymbol', kind: 12, location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } } }];
    }
    if (method === 'textDocument/rename') {
      const uri = params?.textDocument?.uri;
      return uri ? { changes: { [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: params?.newName ?? 'renamed' }] } } : { changes: {} };
    }
    if (method === 'textDocument/codeAction') {
      return [{ title: 'Fixture action', kind: 'quickfix' }];
    }
    return null;
  },
  onNotification(method, params) {
    if (method === 'initialized' && process.env.PIARIUM_LSP_FIXTURE_CRASH === '1') {
      process.exit(17);
      return;
    }
    if (method === 'exit') {
      process.exit(0);
      return;
    }
    if (method === 'textDocument/didOpen') {
      const uri = params?.textDocument?.uri;
      const text = params?.textDocument?.text ?? '';
      const version = params?.textDocument?.version ?? 0;
      files.set(uri, { text, version });
      publish(server, uri, text.includes('FIXTURE_STALE_DIAG') ? 0 : version, text);
      return;
    }
    if (method === 'textDocument/didChange') {
      const uri = params?.textDocument?.uri;
      const version = params?.textDocument?.version ?? 0;
      const change = Array.isArray(params?.contentChanges) ? params.contentChanges[params.contentChanges.length - 1] : null;
      const text = typeof change?.text === 'string' ? change.text : files.get(uri)?.text ?? '';
      files.set(uri, { text, version });
      publish(server, uri, text.includes('FIXTURE_STALE_DIAG') ? 0 : version, text);
    }
    if (method === 'textDocument/didClose') {
      files.delete(params?.textDocument?.uri);
    }
  },
});
