import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createLanguageSupervisor } from './supervisor.js';
import { PIARIUM_LSP_FIXTURE_SERVER_PATH } from './servers.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (probe, timeoutMs = 8000) => {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(25);
  }
  throw lastError ?? new Error('Timed out waiting for language supervisor condition');
};

const fixtureProvider = (overrides = {}) => ({
  providerId: overrides.providerId ?? 'fixture',
  command: process.execPath,
  args: [PIARIUM_LSP_FIXTURE_SERVER_PATH],
  languageIds: overrides.languageIds ?? ['typescript'],
  source: overrides.source ?? 'host',
  ...(overrides.env ? { env: overrides.env } : {}),
});

describe('language supervisor', () => {
  it('initializes a fixture server and serves completion, hover, and code actions', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      expect(language.getStatus(harness.identity.workspaceId, 'typescript').status).toBe('absent');
      language.registerProvider(fixtureProvider());
      const resource = harness.resource('note.ts');
      const synced = await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const value = 1;\n',
      });
      expect(synced.status).toBe('synced');
      expect(language.getStatus(harness.identity.workspaceId, 'typescript')).toMatchObject({
        status: 'ready',
        features: {
          completionTriggerCharacters: ['.'],
          signatureHelpTriggerCharacters: ['(', ','],
          onTypeFormattingTriggerCharacters: ['}', ';'],
        },
      });
      const completion = await language.completion({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 0 },
      });
      expect(completion).toMatchObject({
        status: 'ready',
        providerId: 'fixture',
        generation: 1,
        value: [{
          label: 'fixtureItem',
          insertTextFormat: 'snippet',
          detail: 'fixture',
          documentation: { kind: 'markdown', value: '**fixture completion**' },
          textEdit: { newText: 'fixtureItem(${1:value})' },
          additionalTextEdits: [{ newText: 'import { fixtureItem } from "fixture";\n' }],
        }],
      });
      const resolvedCompletion = await language.completionResolve({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        resolveToken: completion.value[0].resolveToken,
      });
      expect(resolvedCompletion).toMatchObject({
        status: 'ready',
        value: { detail: 'resolved fixture', documentation: { kind: 'markdown', value: '**resolved**' } },
      });
      const hover = await language.hover({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 0 },
      });
      expect(hover).toMatchObject({
        status: 'ready',
        value: { contents: [{ kind: 'markdown', value: 'fixture-hover' }] },
      });
      const signature = await language.signatureHelp({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 1 },
      });
      expect(signature).toMatchObject({
        status: 'ready',
        value: { signatures: [{ label: 'fixtureItem(value: string): void' }] },
      });
      const actions = await language.codeActions({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      });
      expect(actions).toMatchObject({
        status: 'ready',
        value: [{ title: 'Fixture action', isPreferred: true, edit: { documentChanges: [{ kind: 'text' }] } }],
      });
      const resolvedAction = await language.codeActionResolve({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        resolveToken: actions.value[0].resolveToken,
      });
      expect(resolvedAction).toMatchObject({
        status: 'ready',
        value: { command: { command: 'fixture.finish', arguments: ['done'] } },
      });
      expect(await language.executeCommand({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        providerId: 'fixture',
        generation: 1,
        command: 'fixture.finish',
        arguments: ['done'],
      })).toMatchObject({ status: 'ready', value: { finished: 'done' } });
      expect(await language.executeCommand({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        providerId: 'fixture',
        generation: 1,
        command: 'fixture.not-declared',
      })).toMatchObject({ status: 'failed', reason: 'unsupported' });
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('drops stale diagnostics and completions for a newer document version', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider());
      const events = [];
      language.subscribe(harness.identity.workspaceId, (event) => events.push(event));
      const resource = harness.resource('stale.ts');
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 4,
        reason: 'open',
        content: 'FIXTURE_STALE_DIAG\n',
      });
      await wait(200);
      expect(events.some((event) => event.kind === 'diagnostics' && event.items.length > 0)).toBe(false);
      const stale = await language.completion({
        resource,
        languageId: 'typescript',
        documentVersion: 9,
        position: { line: 0, character: 0 },
      });
      expect(stale).toMatchObject({ status: 'stale', documentVersion: 4, providerId: 'fixture', generation: 1 });
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('activates workspace language extensions on demand and stops after the last document closes', async () => {
    const harness = await createDocumentAuthorityHarness();
    let activations = 0;
    let language;
    language = createLanguageSupervisor({
      activateProviders: async () => {
        activations += 1;
        language.registerProvider(fixtureProvider());
      },
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      const resource = harness.resource('lazy.ts');
      expect(await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const lazy = true;\n',
      })).toMatchObject({ status: 'synced', generation: 1 });
      expect(activations).toBe(1);
      expect(language.getStatus(harness.identity.workspaceId, 'typescript').status).toBe('ready');
      expect(await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'close',
      })).toMatchObject({ status: 'synced', generation: 1 });
      expect(language.getStatus(harness.identity.workspaceId, 'typescript').status).toBe('absent');
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('keeps an activation failure distinct from an absent provider', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      activateProviders: async () => { throw new Error('extension activation failed'); },
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      expect(await language.syncDocument({
        resource: harness.resource('failed.ts'),
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const failed = true;\n',
      })).toMatchObject({ status: 'failed', message: 'extension activation failed' });
      expect(language.getStatus(harness.identity.workspaceId, 'typescript')).toMatchObject({
        status: 'failed',
        message: 'extension activation failed',
      });
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('maps navigation, symbols, formatting, semantic, inlay, link, and color contracts', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider());
      const resource = harness.resource('rich.ts');
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 2,
        reason: 'open',
        content: 'fixture\nchild\nend\n',
      });
      const point = { line: 0, character: 1 };
      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } };

      expect(await language.definition({ resource, languageId: 'typescript', documentVersion: 2, position: point })).toMatchObject({
        status: 'ready',
        value: [{ resource, targetRange: { end: { character: 8 } }, targetSelectionRange: { end: { character: 7 } }, originSelectionRange: { end: { character: 3 } } }],
      });
      expect(await language.references({ resource, languageId: 'typescript', documentVersion: 2, position: point })).toMatchObject({
        status: 'ready', value: [{ resource }],
      });
      expect(await language.documentSymbols({ resource, languageId: 'typescript', documentVersion: 2 })).toMatchObject({
        status: 'ready', value: [{ name: 'fixtureSymbol', children: [{ name: 'fixtureChild' }] }],
      });
      expect(await language.rename({ resource, languageId: 'typescript', documentVersion: 2, position: point, newName: 'renamed' })).toMatchObject({
        status: 'ready', value: { documentChanges: [{ kind: 'text', resource, edits: [{ newText: 'renamed' }] }] },
      });
      expect(await language.documentFormatting({
        resource,
        languageId: 'typescript',
        documentVersion: 2,
        formatting: { tabSize: 2, insertSpaces: true },
      })).toMatchObject({ status: 'ready', value: [{ newText: 'formatted' }] });
      expect(await language.semanticTokens({ resource, languageId: 'typescript', documentVersion: 2 })).toMatchObject({
        status: 'ready',
        value: {
          data: [0, 0, 7, 0, 1],
          resultId: 'fixture-semantic-1',
          legend: { tokenTypes: ['variable'], tokenModifiers: ['readonly'] },
        },
      });
      const hints = await language.inlayHints({ resource, languageId: 'typescript', documentVersion: 2, range });
      expect(hints).toMatchObject({ status: 'ready', value: [{ label: ': string', kind: 'type' }] });
      const resolvedHint = await language.inlayHintResolve({
        resource,
        languageId: 'typescript',
        documentVersion: 2,
        resolveToken: hints.value[0].resolveToken,
      });
      expect(resolvedHint).toMatchObject({ status: 'ready', value: { paddingLeft: true, tooltip: { value: 'Resolved fixture hint' } } });
      expect(await language.documentHighlights({ resource, languageId: 'typescript', documentVersion: 2, position: point })).toMatchObject({
        status: 'ready', value: [{ kind: 'read' }],
      });
      expect(await language.foldingRanges({ resource, languageId: 'typescript', documentVersion: 2 })).toMatchObject({
        status: 'ready', value: [{ startLine: 0, endLine: 2, kind: 'region' }],
      });
      expect(await language.selectionRanges({ resource, languageId: 'typescript', documentVersion: 2, positions: [point] })).toMatchObject({
        status: 'ready', value: [{ parent: { range: { end: { character: 8 } } } }],
      });
      const links = await language.documentLinks({ resource, languageId: 'typescript', documentVersion: 2 });
      expect(links).toMatchObject({ status: 'ready', value: [{ tooltip: 'Fixture link' }] });
      expect(await language.documentLinkResolve({
        resource,
        languageId: 'typescript',
        documentVersion: 2,
        resolveToken: links.value[0].resolveToken,
      })).toMatchObject({ status: 'ready', value: { target: { kind: 'uri', uri: 'https://example.com/fixture' } } });
      expect(await language.documentColors({ resource, languageId: 'typescript', documentVersion: 2 })).toMatchObject({
        status: 'ready', value: [{ color: { red: 1, green: 0.5, blue: 0, alpha: 1 } }],
      });
      expect(await language.colorPresentations({
        resource,
        languageId: 'typescript',
        documentVersion: 2,
        range,
        color: { red: 1, green: 0.5, blue: 0, alpha: 1 },
      })).toMatchObject({ status: 'ready', value: [{ label: '#ff8000', textEdit: { newText: '#ff8000' } }] });
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('returns typed unsupported without degrading a provider that omitted a capability', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider({ env: { PIARIUM_LSP_FIXTURE_MINIMAL: '1' } }));
      const resource = harness.resource('unsupported.ts');
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'fixture\n',
      });
      const hover = await language.hover({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 0 },
      });
      expect(hover).toMatchObject({
        status: 'failed',
        reason: 'unsupported',
        providerId: 'fixture',
        generation: 1,
      });
      expect(language.getStatus(harness.identity.workspaceId, 'typescript')).toMatchObject({ status: 'ready' });
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('applies multiple incremental edits against the same document version', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider());
      const events = [];
      language.subscribe(harness.identity.workspaceId, (event) => events.push(event));
      const resource = harness.resource('incremental.ts');
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'xFIXTURE_ERROXy',
      });
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 2,
        reason: 'change',
        changes: [
          { from: 0, to: 1, insert: '' },
          { from: 13, to: 15, insert: 'R' },
        ],
      });
      await waitUntil(() => events.some((event) => (
        event.kind === 'diagnostics'
        && event.resourceId === 'incremental.ts'
        && event.items.some((item) => item.message === 'fixture error' && item.documentVersion === 2)
      )));
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('publishes versioned diagnostics and isolates a crashed language session', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider({ providerId: 'crash', languageIds: ['typescript'], env: { PIARIUM_LSP_FIXTURE_CRASH: '1' } }));
      language.registerProvider(fixtureProvider({ providerId: 'python', languageIds: ['python'], env: { PIARIUM_LSP_FIXTURE_CRASH: '' } }));
      const events = [];
      language.subscribe(harness.identity.workspaceId, (event) => events.push(event));
      await language.syncDocument({
        resource: harness.resource('ok.py'),
        languageId: 'python',
        documentVersion: 1,
        reason: 'open',
        content: 'FIXTURE_ERROR\n',
      });
      await waitUntil(() => events.some((event) => (
        event.kind === 'diagnostics'
        && event.resourceId === 'ok.py'
        && event.items.some((item) => item.message === 'fixture error' && item.documentVersion === 1)
      )));
      await language.syncDocument({
        resource: harness.resource('boom.ts'),
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const x = 1;\n',
      });
      await waitUntil(() => language.getStatus(harness.identity.workspaceId, 'typescript').status === 'failed');
      expect(language.getStatus(harness.identity.workspaceId, 'python').status).toBe('ready');
      const hover = await language.hover({
        resource: harness.resource('ok.py'),
        languageId: 'python',
        documentVersion: 1,
        position: { line: 0, character: 0 },
      });
      expect(hover.status).toBe('ready');
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('refuses project-provided commands in untrusted workspaces without spawning', async () => {
    const harness = await createDocumentAuthorityHarness();
    let spawned = 0;
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn: (...args) => {
        spawned += 1;
        return spawn(...args);
      },
      pathModule: path,
      isTrusted: async () => false,
    });
    try {
      language.registerProvider(fixtureProvider({ source: 'workspace' }));
      const result = await language.syncDocument({
        resource: harness.resource('note.ts'),
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const value = 1;\n',
      });
      expect(result.status).toBe('failed');
      expect(result.message).toMatch(/Untrusted workspace/i);
      expect(spawned).toBe(0);
      expect(language.getStatus(harness.identity.workspaceId, 'typescript').status).toBe('failed');
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('marks a live session degraded when a feature request fails', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider());
      const resource = harness.resource('hover.ts');
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'FIXTURE_HOVER_FAIL\n',
      });
      const hover = await language.hover({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 0 },
      });
      expect(hover.status).toBe('failed');
      expect(language.getStatus(harness.identity.workspaceId, 'typescript').status).toBe('degraded');
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('increments generation after disposeWorkspace', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider());
      const events = [];
      language.subscribe(harness.identity.workspaceId, (event) => events.push(event));
      await language.syncDocument({
        resource: harness.resource('note.ts'),
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const value = 1;\n',
      });
      const first = language.getStatus(harness.identity.workspaceId, 'typescript');
      expect(first.status).toBe('ready');
      events.length = 0;
      await language.disposeWorkspace(harness.identity.workspaceId);
      expect(language.getStatus(harness.identity.workspaceId, 'typescript').status).toBe('absent');
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'diagnostics',
          resourceId: 'note.ts',
          providerId: 'fixture',
          generation: first.generation,
          items: [],
        }),
        expect.objectContaining({
          kind: 'status',
          snapshot: expect.objectContaining({
            status: 'absent',
            providerId: 'fixture',
            generation: first.generation,
          }),
        }),
      ]));
      await language.syncDocument({
        resource: harness.resource('note.ts'),
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const value = 1;\n',
      });
      const second = language.getStatus(harness.identity.workspaceId, 'typescript');
      expect(second.status).toBe('ready');
      expect(second.generation).toBeGreaterThan(first.generation);
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });

  it('reopens the current in-memory buffer before serving a replacement provider generation', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      language.registerProvider(fixtureProvider());
      const events = [];
      language.subscribe(harness.identity.workspaceId, (event) => events.push(event));
      const resource = harness.resource('generation.ts');
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const clean = true;\n',
      });
      await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 2,
        reason: 'change',
        content: 'FIXTURE_ERROR\n',
      });
      const first = language.getStatus(harness.identity.workspaceId, 'typescript');
      language.registerProvider(fixtureProvider());
      events.length = 0;

      const hover = await language.hover({
        resource,
        languageId: 'typescript',
        documentVersion: 2,
        position: { line: 0, character: 0 },
      });
      expect(hover).toMatchObject({ status: 'ready', generation: first.generation + 1 });
      await waitUntil(() => events.some((event) => (
        event.kind === 'diagnostics'
        && event.resourceId === 'generation.ts'
        && event.generation === first.generation + 1
        && event.items.some((item) => item.message === 'fixture error' && item.documentVersion === 2)
      )));
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  });
});
