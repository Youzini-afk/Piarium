import { createJsonRpcServer } from './jsonrpc.js';

const files = new Map();

const positionToOffset = (text, position) => {
  const targetLine = Math.max(0, position?.line ?? 0);
  const targetCharacter = Math.max(0, position?.character ?? 0);
  let offset = 0;
  let line = 0;
  while (line < targetLine && offset < text.length) {
    const newline = text.indexOf('\n', offset);
    if (newline < 0) return text.length;
    offset = newline + 1;
    line += 1;
  }
  const lineEnd = text.indexOf('\n', offset);
  const max = lineEnd < 0 ? text.length : lineEnd;
  return Math.min(offset + targetCharacter, max);
};

const applyContentChanges = (content, changes) => {
  let next = content;
  for (const change of changes) {
    if (!change?.range) {
      next = typeof change?.text === 'string' ? change.text : next;
      continue;
    }
    const from = positionToOffset(next, change.range.start);
    const to = positionToOffset(next, change.range.end);
    next = `${next.slice(0, from)}${typeof change.text === 'string' ? change.text : ''}${next.slice(to)}`;
  }
  return next;
};

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
      const changes = Array.isArray(params?.contentChanges) ? params.contentChanges : [];
      const text = applyContentChanges(files.get(uri)?.text ?? '', changes);
      files.set(uri, { text, version });
      publish(server, uri, text.includes('FIXTURE_STALE_DIAG') ? 0 : version, text);
    }
    if (method === 'textDocument/didClose') {
      files.delete(params?.textDocument?.uri);
    }
  },
});
