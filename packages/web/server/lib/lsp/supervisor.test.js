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
      expect(language.getStatus(harness.identity.workspaceId, 'typescript').status).toBe('ready');
      const completion = await language.completion({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 0 },
      });
      expect(completion).toMatchObject({ status: 'ready', value: [{ label: 'fixtureItem' }] });
      const hover = await language.hover({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 0 },
      });
      expect(hover).toMatchObject({ status: 'ready', value: 'fixture-hover' });
      const actions = await language.codeActions({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      });
      expect(actions).toMatchObject({ status: 'ready', value: [{ title: 'Fixture action' }] });
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
      expect(stale).toEqual({ status: 'stale', documentVersion: 4 });
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
      await language.syncDocument({
        resource: harness.resource('note.ts'),
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const value = 1;\n',
      });
      const first = language.getStatus(harness.identity.workspaceId, 'typescript');
      expect(first.status).toBe('ready');
      await language.disposeWorkspace(harness.identity.workspaceId);
      expect(language.getStatus(harness.identity.workspaceId, 'typescript').status).toBe('absent');
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
});
