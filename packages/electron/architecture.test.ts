import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const electronRoot = fileURLToPath(new URL('.', import.meta.url));

const listFiles = (root: string, skipDirs: Set<string>): string[] => {
  const results: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const relative = path.relative(root, absolutePath);
        if (skipDirs.has(relative)) continue;
        visit(absolutePath);
      } else {
        results.push(absolutePath);
      }
    }
  };
  visit(root);
  return results;
};

const relativeElectronPath = (absolutePath: string): string => (
  path.relative(electronRoot, absolutePath).split(path.sep).join('/')
);

// Directories that are NOT product runtime source — they are build tooling,
// generated output, or resources. The architecture test excludes them.
const NON_SOURCE_DIRS = new Set([
  'dist-bundle',
  'dist',
  'resources',
  'scripts',
  'node_modules',
]);

describe('Electron source boundary', () => {
  it('keeps Electron root product runtime fully TypeScript (no .js/.mjs/.cjs source)', () => {
    const jsSources = listFiles(electronRoot, NON_SOURCE_DIRS)
      .filter((file) => /\.(?:js|mjs|cjs)$/u.test(file))
      .map(relativeElectronPath)
      .sort();

    expect(jsSources).toEqual([]);
  });

  it('does not disable TypeScript checking in Electron source files', () => {
    const offenders = listFiles(electronRoot, NON_SOURCE_DIRS)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /@ts-(?:nocheck|ignore)/u.test(readFileSync(file, 'utf8')))
      .map(relativeElectronPath);

    expect(offenders).toEqual([]);
  });

  it('does not use explicit any in Electron source files', () => {
    // The word "any" in comments is fine — we only flag the TypeScript type.
    // Match `: any`, `as any`, `<any>`, `Array<any>`, `Record<..., any>`, etc.
    const explicitAny = /(?::\s*any\b|as\s+any\b|<any>|Array\s*<\s*any\s*>|Record\s*<[^>]*,\s*any\s*>)/u;
    const offenders = listFiles(electronRoot, NON_SOURCE_DIRS)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter((file) => explicitAny.test(readFileSync(file, 'utf8')))
      .map(relativeElectronPath);

    expect(offenders).toEqual([]);
  });

  it('keeps scripts as tooling (JS/MJS/CJS allowed only in scripts/)', () => {
    const scriptsDir = path.join(electronRoot, 'scripts');
    expect(existsSync(scriptsDir)).toBe(true);

    // Scripts directory IS allowed to have JS — it's build tooling.
    const scriptFiles = listFiles(scriptsDir, new Set(['node_modules']))
      .filter((file) => /\.(?:js|mjs|cjs)$/u.test(file));
    // Just verify scripts exist — they are the tooling exception.
    expect(scriptFiles.length).toBeGreaterThan(0);
  });
});
