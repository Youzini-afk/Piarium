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
      if (process.env.PIARIUM_LSP_FIXTURE_MINIMAL === '1') {
        return {
          capabilities: {
            textDocumentSync: 2,
            completionProvider: {},
          },
        };
      }
      return {
        capabilities: {
          textDocumentSync: 2,
          completionProvider: { resolveProvider: true, triggerCharacters: ['.'] },
          hoverProvider: true,
          signatureHelpProvider: { triggerCharacters: ['(', ','] },
          definitionProvider: true,
          referencesProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          renameProvider: true,
          codeActionProvider: { resolveProvider: true },
          documentFormattingProvider: true,
          documentRangeFormattingProvider: true,
          documentOnTypeFormattingProvider: { firstTriggerCharacter: '}', moreTriggerCharacter: [';'] },
          semanticTokensProvider: {
            legend: { tokenTypes: ['variable'], tokenModifiers: ['readonly'] },
            full: true,
            range: true,
          },
          inlayHintProvider: { resolveProvider: true },
          documentHighlightProvider: true,
          foldingRangeProvider: true,
          selectionRangeProvider: true,
          documentLinkProvider: { resolveProvider: true },
          colorProvider: true,
        },
      };
    }
    if (method === 'shutdown') return null;
    if (method === 'textDocument/completion') {
      return { items: [{
        label: 'fixtureItem',
        kind: 3,
        detail: 'fixture',
        documentation: { kind: 'markdown', value: '**fixture completion**' },
        insertText: 'fixtureItem(${1:value})',
        insertTextFormat: 2,
        textEdit: {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          newText: 'fixtureItem(${1:value})',
        },
        additionalTextEdits: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: 'import { fixtureItem } from "fixture";\n',
        }],
        data: { fixture: 'completion' },
      }] };
    }
    if (method === 'completionItem/resolve') {
      return { ...params, detail: 'resolved fixture', documentation: { kind: 'markdown', value: '**resolved**' } };
    }
    if (method === 'textDocument/hover') {
      const uri = params?.textDocument?.uri;
      const text = files.get(uri)?.text ?? '';
      if (text.includes('FIXTURE_HOVER_FAIL')) {
        throw new Error('fixture hover failed');
      }
      return { contents: { kind: 'markdown', value: 'fixture-hover' } };
    }
    if (method === 'textDocument/signatureHelp') {
      return {
        signatures: [{
          label: 'fixtureItem(value: string): void',
          documentation: { kind: 'markdown', value: 'Fixture signature' },
          parameters: [{ label: [12, 25], documentation: 'Fixture value' }],
        }],
        activeSignature: 0,
        activeParameter: 0,
      };
    }
    if (method === 'textDocument/definition') {
      const uri = params?.textDocument?.uri;
      return uri ? [{
        targetUri: uri,
        targetRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        targetSelectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
        originSelectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
      }] : [];
    }
    if (method === 'textDocument/references') {
      const uri = params?.textDocument?.uri;
      return uri ? [{ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] : [];
    }
    if (method === 'textDocument/documentSymbol') {
      return [{
        name: 'fixtureSymbol',
        detail: 'fixture container',
        kind: 13,
        range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        children: [{
          name: 'fixtureChild',
          kind: 12,
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
          selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
        }],
      }];
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
      const uri = params?.textDocument?.uri;
      return [{
        title: 'Fixture action',
        kind: 'quickfix',
        isPreferred: true,
        edit: uri ? { changes: { [uri]: [{ range: params.range, newText: 'fixed' }] } } : undefined,
        data: { fixture: 'action' },
      }];
    }
    if (method === 'codeAction/resolve') {
      return { ...params, command: { title: 'Finish fixture action', command: 'fixture.finish', arguments: ['done'] } };
    }
    if (
      method === 'textDocument/formatting'
      || method === 'textDocument/rangeFormatting'
      || method === 'textDocument/onTypeFormatting'
    ) {
      return [{
        range: params?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: 'formatted',
      }];
    }
    if (method === 'textDocument/semanticTokens/full' || method === 'textDocument/semanticTokens/range') {
      return { resultId: 'fixture-semantic-1', data: [0, 0, 7, 0, 1] };
    }
    if (method === 'textDocument/inlayHint') {
      return [{ position: { line: 0, character: 7 }, label: ': string', kind: 1, data: { fixture: 'hint' } }];
    }
    if (method === 'inlayHint/resolve') {
      return { ...params, tooltip: { kind: 'markdown', value: 'Resolved fixture hint' }, paddingLeft: true };
    }
    if (method === 'textDocument/documentHighlight') {
      return [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, kind: 2 }];
    }
    if (method === 'textDocument/foldingRange') {
      return [{ startLine: 0, endLine: 2, kind: 'region' }];
    }
    if (method === 'textDocument/selectionRange') {
      return (params?.positions ?? []).map((position) => ({
        range: { start: position, end: { line: position.line, character: position.character + 1 } },
        parent: { range: { start: { line: position.line, character: 0 }, end: { line: position.line, character: 8 } } },
      }));
    }
    if (method === 'textDocument/documentLink') {
      return [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
        tooltip: 'Fixture link',
        data: { fixture: 'link' },
      }];
    }
    if (method === 'documentLink/resolve') {
      return { ...params, target: params?.data?.uri ?? params?.target ?? 'https://example.com/fixture' };
    }
    if (method === 'textDocument/documentColor') {
      return [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
        color: { red: 1, green: 0.5, blue: 0, alpha: 1 },
      }];
    }
    if (method === 'textDocument/colorPresentation') {
      return [{ label: '#ff8000', textEdit: { range: params.range, newText: '#ff8000' } }];
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
