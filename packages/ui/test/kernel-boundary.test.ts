import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

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

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('kernel boundary', () => {
  for (const kernelDir of KERNEL_DIRS) {
    test(`${kernelDir} does not import from components, apps, contexts, stores, or zustand`, () => {
      const absDir = join(uiRoot, kernelDir);
      let files: string[] = [];
      try { files = walkTs(absDir); } catch { /* dir may not exist yet */ }
      for (const file of files) {
        const content = readFileSync(file, 'utf8');
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(content)) {
            assert.fail(`${relative(uiRoot, file)} imports from a forbidden UI layer: ${pattern}`);
          }
        }
      }
    });
  }
});
