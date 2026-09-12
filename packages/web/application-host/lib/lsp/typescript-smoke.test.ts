import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createLanguageSupervisor } from './supervisor.js';
import { PIARIUM_LSP_TYPESCRIPT_SERVER_ARGS } from './servers.js';

interface TestEvent extends Record<string, unknown> { items: Array<Record<string, unknown>>; kind?: string }
const featureValue = <Value>(result: object): Value => (result as { value: unknown }).value as Value;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async <Value>(probe: () => Value | Promise<Value>, timeoutMs = 8000): Promise<NonNullable<Value>> => {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value as NonNullable<Value>;
    } catch (error) {
      lastError = error;
    }
    await wait(25);
  }
  throw lastError ?? new Error('Timed out waiting for TypeScript language server');
};

describe('typescript language server smoke', () => {
  it('reports a real TypeScript type error and serves hover/completion', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, 'hello.ts'),
        'const greeting: number = "hi";\n',
      );
      language.registerProvider({
        providerId: 'typescript-smoke',
        command: 'node',
        args: PIARIUM_LSP_TYPESCRIPT_SERVER_ARGS,
        languageIds: ['typescript'],
        source: 'host',
      });
      const events: TestEvent[] = [];
      language.subscribe(harness.identity.workspaceId, (event) => events.push(event as TestEvent));
      const resource = harness.resource('hello.ts');
      const synced = await language.syncDocument({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const greeting: number = "hi";\n',
      });
      expect(synced.status).toBe('synced');
      expect(language.getStatus(harness.identity.workspaceId, 'typescript').status).toBe('ready');
      const diagnostic = await waitUntil(() => events.find((event) => (
        event.kind === 'diagnostics'
        && event.items.some((item) => /string|number|assignable/i.test(String(item.message)))
      )));
      expect(diagnostic.items.some((item) => /string|number|assignable/i.test(String(item.message)))).toBe(true);
      const hover = await language.hover({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 6 },
      });
      expect(hover.status).toBe('ready');
      const hoverValue = featureValue<Record<string, unknown>>(hover);
      expect(hoverValue).toMatchObject({ contents: expect.any(Array) });
      expect(JSON.stringify(hoverValue.contents)).toMatch(/greeting|number|string/i);
      const completion = await language.completion({
        resource,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 0 },
      });
      expect(completion.status).toBe('ready');
      expect(featureValue<Array<Record<string, unknown>>>(completion)
        .some((item) => typeof item.label === 'string' && item.label.length > 0)).toBe(true);
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  }, 20000);

  it('resolves cross-file references and call hierarchy through the bundled server', async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    try {
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, 'def.ts'),
        'export function uniqueTarget() { return 1; }\n',
      );
      await fs.promises.writeFile(
        path.join(harness.workspaceRoot, 'caller.ts'),
        'import { uniqueTarget } from "./def";\nexport function driver() { return uniqueTarget(); }\n',
      );
      language.registerProvider({
        providerId: 'typescript-smoke',
        command: 'node',
        args: PIARIUM_LSP_TYPESCRIPT_SERVER_ARGS,
        languageIds: ['typescript'],
        source: 'host',
      });
      const def = harness.resource('def.ts');
      const caller = harness.resource('caller.ts');
      const defSync = await language.syncDocument({
        resource: def,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'export function uniqueTarget() { return 1; }\n',
      });
      expect(defSync.status).toBe('synced');
      // The server reads caller.ts from the workspace root on its own — it was
      // never didOpen'd, which is exactly what "unpinned cross-file site" means.
      const references = await language.references({
        resource: def,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 16 },
      });
      expect(references.status).toBe('ready');
      const sites = featureValue<Array<{ resource: { resourceId: string } }>>(references);
      expect(sites.some((site) => site.resource.resourceId === 'caller.ts')).toBe(true);

      const prepared = await language.prepareCallHierarchy({
        resource: def,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 16 },
      });
      expect(prepared.status).toBe('ready');
      const items = featureValue<Array<{ name: string; itemToken: string }>>(prepared);
      expect(items[0]?.name).toBe('uniqueTarget');
      const incoming = await language.callHierarchyIncoming({
        resource: def,
        languageId: 'typescript',
        documentVersion: 1,
        itemToken: items[0]!.itemToken,
      });
      expect(incoming.status).toBe('ready');
      const calls = featureValue<Array<{ from: { name: string; resource: { resourceId: string } } }>>(incoming);
      expect(calls.some((call) => call.from.name === 'driver' && call.from.resource.resourceId === 'caller.ts')).toBe(true);

      // The caller makes an outgoing call to uniqueTarget.
      const callerSync = await language.syncDocument({
        resource: caller,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'import { uniqueTarget } from "./def";\nexport function driver() { return uniqueTarget(); }\n',
      });
      expect(callerSync.status).toBe('synced');
      const callerPrepared = await language.prepareCallHierarchy({
        resource: caller,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 1, character: 16 },
      });
      expect(callerPrepared.status).toBe('ready');
      const callerItems = featureValue<Array<{ name: string; itemToken: string }>>(callerPrepared);
      const outgoing = await language.callHierarchyOutgoing({
        resource: caller,
        languageId: 'typescript',
        documentVersion: 1,
        itemToken: callerItems[0]!.itemToken,
      });
      expect(outgoing.status).toBe('ready');
      const outgoingCalls = featureValue<Array<{ to: { name: string; resource: { resourceId: string } } }>>(outgoing);
      expect(outgoingCalls.some((call) => call.to.name === 'uniqueTarget' && call.to.resource.resourceId === 'def.ts')).toBe(true);
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  }, 30000);
});
