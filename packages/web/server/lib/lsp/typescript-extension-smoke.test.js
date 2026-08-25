import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PIARIUM_BUILTIN_EXTENSION_PACKAGE_ROOTS,
} from '@piarium/extension-builtins/host';
import {
  PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
} from '@piarium/extension-builtins';
import { createDocumentAuthorityHarness } from '../documents/contract-fixtures.js';
import { createLanguageSupervisor } from './supervisor.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (probe, timeoutMs = 15_000) => {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(50);
  }
  throw lastError ?? new Error('Timed out waiting for TypeScript language service');
};

describe('built-in TypeScript language extension', () => {
  it('serves a real project through the same Host authority used by extensions', async () => {
    const packageRoot = PIARIUM_BUILTIN_EXTENSION_PACKAGE_ROOTS.get(
      PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID,
    );
    if (!packageRoot) throw new Error('TypeScript language extension package root is unavailable');
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    const events = [];
    try {
      const utilityContent = [
        'export function greet(name: string): string {',
        '  return `Hello ${name}`;',
        '}',
        'export const answer: number = "wrong";',
        '',
      ].join('\n');
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
        include: ['*.ts'],
      }));
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'util.ts'), utilityContent);
      await fs.promises.writeFile(path.join(harness.workspaceRoot, 'main.ts'), 'const value = gre\n');
      language.registerProvider({
        providerId: 'piarium.typescript-language',
        command: process.execPath,
        args: [path.join(packageRoot, 'runtime', 'typescript-language-server.mjs'), '--stdio'],
        initializationOptions: {
          tsserver: { fallbackPath: path.join(packageRoot, 'runtime', 'typescript', 'lib', 'tsserver.js') },
        },
        languageIds: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'],
        source: 'builtin',
      });
      language.subscribe(harness.identity.workspaceId, (event) => events.push(event));
      const utility = harness.resource('util.ts');
      const main = harness.resource('main.ts');
      const utilitySync = await language.syncDocument({
        resource: utility,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: utilityContent,
      });
      if (utilitySync.status !== 'synced') throw new Error(utilitySync.message ?? utilitySync.status);
      expect(await language.syncDocument({
        resource: main,
        languageId: 'typescript',
        documentVersion: 1,
        reason: 'open',
        content: 'const value = gre\n',
      })).toMatchObject({ status: 'synced' });

      const completion = await language.completion({
        resource: main,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 17 },
      });
      expect(completion.status).toBe('ready');
      const greetCompletion = completion.value.find((item) => item.label === 'greet');
      expect(greetCompletion).toBeTruthy();
      const resolvedCompletion = await language.completionResolve({
        resource: main,
        languageId: 'typescript',
        documentVersion: 1,
        resolveToken: greetCompletion.resolveToken,
      });
      expect(resolvedCompletion).toMatchObject({ status: 'ready' });
      expect(resolvedCompletion.value.additionalTextEdits?.length).toBeGreaterThan(0);

      const mainContent = "import { greet } from './util';\nconst value = greet('Piarium');\n";
      await language.syncDocument({
        resource: main,
        languageId: 'typescript',
        documentVersion: 2,
        reason: 'change',
        content: mainContent,
      });
      const position = { line: 1, character: 15 };
      expect(await language.hover({ resource: main, languageId: 'typescript', documentVersion: 2, position })).toMatchObject({
        status: 'ready', value: { contents: expect.any(Array) },
      });
      expect(await language.definition({ resource: main, languageId: 'typescript', documentVersion: 2, position })).toMatchObject({
        status: 'ready', value: [expect.objectContaining({ resource: utility })],
      });
      expect(await language.references({ resource: main, languageId: 'typescript', documentVersion: 2, position })).toMatchObject({
        status: 'ready', value: expect.arrayContaining([expect.objectContaining({ resource: utility })]),
      });
      const renamed = await language.rename({
        resource: utility,
        languageId: 'typescript',
        documentVersion: 1,
        position: { line: 0, character: 17 },
        newName: 'welcome',
      });
      expect(renamed).toMatchObject({ status: 'ready' });
      expect(new Set(renamed.value.documentChanges
        .filter((change) => change.kind === 'text')
        .map((change) => change.resource.resourceId))).toEqual(new Set(['main.ts', 'util.ts']));
      expect(await language.documentFormatting({
        resource: main,
        languageId: 'typescript',
        documentVersion: 2,
        formatting: { tabSize: 2, insertSpaces: true },
      })).toMatchObject({ status: 'ready', value: expect.any(Array) });

      const utilityDiagnostic = await waitUntil(() => events.find((event) => (
        event.kind === 'diagnostics'
        && event.resourceId === 'util.ts'
        && event.items.some((item) => /string|number|assignable/i.test(item.message))
      )));
      expect(utilityDiagnostic.items.length).toBeGreaterThan(0);

      const missingImportContent = "const value = greet('Piarium');\n";
      await language.syncDocument({
        resource: main,
        languageId: 'typescript',
        documentVersion: 3,
        reason: 'change',
        content: missingImportContent,
      });
      const missingImportDiagnostic = await waitUntil(() => events.findLast((event) => (
        event.kind === 'diagnostics'
        && event.resourceId === 'main.ts'
        && event.items.some((item) => /greet|cannot find name/i.test(item.message))
      )));
      const actions = await language.codeActions({
        resource: main,
        languageId: 'typescript',
        documentVersion: 3,
        range: { start: { line: 0, character: 14 }, end: { line: 0, character: 19 } },
        diagnostics: missingImportDiagnostic.items,
      });
      expect(actions.status).toBe('ready');
      expect(actions.value.some((action) => action.edit || action.resolveToken || action.command)).toBe(true);
    } finally {
      await language.dispose();
      await harness.cleanup();
    }
  }, 30_000);
});
