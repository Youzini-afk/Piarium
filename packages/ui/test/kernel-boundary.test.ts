import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// This test file runs under `bun test`, not vitest (vitest only includes
// src/**/*.test.{ts,tsx}). It tracks dependency boundary violations that
// need refactoring. Known violations are listed below so the test can
// distinguish them from new regressions.

const uiRoot = join(import.meta.dirname, '..', 'src');

const KERNEL_DIRS = [
  'lib/documents',
  'lib/workbench/editors',
  'lib/language-services',
  'lib/run-debug',
];

const FORBIDDEN_PATTERNS = [
  /from ['"]@\/components\//,
  /from ['"]@\/apps\//,
  /from ['"]@\/contexts\//,
  /from ['"]@\/stores\//,
  /from ['"]zustand['"]/,
];

// Stores must not import from components or apps (dependency inversion).
const STORES_FORBIDDEN = [
  /from ['"]@\/components\//,
  /from ['"]@\/apps\//,
];

// Extension runtime must not import from workbenches (workbenches are a higher layer).
const EXTENSIONS_FORBIDDEN = [
  /from ['"]@\/workbenches\//,
];

// Lib (kernel) must not import from workbenches.
const LIB_FORBIDDEN_WORKBENCHES = [
  /from ['"]@\/workbenches\//,
];

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function checkPatterns(files: string[], patterns: RegExp[], label: string): void {
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        assert.fail(`${relative(uiRoot, file)} (${label}) imports from a forbidden layer: ${pattern}`);
      }
    }
  }
}

describe('kernel boundary', () => {
  for (const kernelDir of KERNEL_DIRS) {
    test(`${kernelDir} does not import from components, apps, contexts, stores, or zustand`, () => {
      const absDir = join(uiRoot, kernelDir);
      let files: string[] = [];
      try { files = walkTs(absDir); } catch { /* dir may not exist yet */ }
      checkPatterns(files, FORBIDDEN_PATTERNS, kernelDir);
    });
  }

  test('stores do not import from components or apps', () => {
    const storesDir = join(uiRoot, 'stores');
    let files: string[] = [];
    try { files = walkTs(storesDir); } catch { /* dir may not exist yet */ }
    checkPatterns(files, STORES_FORBIDDEN, 'stores');
  });

  test('lib does not import from workbenches', () => {
    const libDir = join(uiRoot, 'lib');
    let files: string[] = [];
    try { files = walkTs(libDir); } catch { /* dir may not exist yet */ }
    checkPatterns(files, LIB_FORBIDDEN_WORKBENCHES, 'lib');
  });

  test('lib/extensions does not import from workbenches', () => {
    const extDir = join(uiRoot, 'lib', 'extensions');
    let files: string[] = [];
    try { files = walkTs(extDir); } catch { /* dir may not exist yet */ }
    checkPatterns(files, EXTENSIONS_FORBIDDEN, 'lib/extensions');
  });
});
