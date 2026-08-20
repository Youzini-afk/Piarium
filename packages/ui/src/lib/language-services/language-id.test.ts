import { afterEach, describe, expect, test } from 'bun:test';
import { languageIdFromResourceId } from './language-id';
import {
  getLanguageDiagnosticsForResource,
  replaceLanguageDiagnostics,
  resetLanguageDiagnostics,
} from './diagnostics-registry';
import { resetWorkbenchPanelsForRuntimeSwitch } from '@/lib/workbench/editors/panels';

afterEach(() => {
  resetLanguageDiagnostics();
  resetWorkbenchPanelsForRuntimeSwitch();
});

describe('language id', () => {
  test('maps known extensions and falls back to plaintext', () => {
    expect(languageIdFromResourceId('src/app.ts')).toBe('typescript');
    expect(languageIdFromResourceId('src/app.py')).toBe('python');
    expect(languageIdFromResourceId('README')).toBe('plaintext');
  });
});

describe('language diagnostics registry', () => {
  test('keeps previous diagnostics when a newer version is stale', () => {
    const accepted = (resourceId: string, documentVersion: number) => (
      resourceId === 'a.ts' && documentVersion === 1
    );
    replaceLanguageDiagnostics('ws', 'typescript', 'a.ts', [{
      resource: { workspaceId: 'ws', resourceId: 'a.ts' },
      documentVersion: 1,
      severity: 'error',
      message: 'old',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    }], accepted);
    replaceLanguageDiagnostics('ws', 'typescript', 'b.ts', [{
      resource: { workspaceId: 'ws', resourceId: 'b.ts' },
      documentVersion: 1,
      severity: 'warning',
      message: 'other',
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
    }], () => true);
    replaceLanguageDiagnostics('ws', 'typescript', 'a.ts', [{
      resource: { workspaceId: 'ws', resourceId: 'a.ts' },
      documentVersion: 2,
      severity: 'error',
      message: 'new',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    }], accepted);
    expect(getLanguageDiagnosticsForResource('ws', 'a.ts').map((item) => item.message)).toEqual(['old']);
    expect(getLanguageDiagnosticsForResource('ws', 'b.ts').map((item) => item.message)).toEqual(['other']);
  });

  test('clears a resource when the language server publishes an empty diagnostic set', () => {
    replaceLanguageDiagnostics('ws', 'typescript', 'a.ts', [{
      resource: { workspaceId: 'ws', resourceId: 'a.ts' },
      documentVersion: 1,
      severity: 'error',
      message: 'gone',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    }], () => true);
    replaceLanguageDiagnostics('ws', 'typescript', 'a.ts', [], () => true);
    expect(getLanguageDiagnosticsForResource('ws', 'a.ts')).toEqual([]);
  });
});
