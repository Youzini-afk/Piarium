import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hostRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(hostRoot, '..', '..', '..');

const listFiles = (root: string): string[] => {
  const results: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else results.push(absolutePath);
    }
  };
  visit(root);
  return results;
};

const relativeHostPath = (absolutePath: string): string => (
  path.relative(hostRoot, absolutePath).split(path.sep).join('/')
);

describe('Application Host source boundary', () => {
  it('keeps Application Host source fully TypeScript', () => {
    const javascriptSources = listFiles(hostRoot)
      .filter((file) => /\.(?:js|mjs|cjs)$/u.test(file))
      .map(relativeHostPath)
      .sort();

    expect(javascriptSources).toEqual([]);
  });

  it('does not disable TypeScript checking in migrated Host files', () => {
    const offenders = listFiles(hostRoot)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /@ts-(?:nocheck|ignore)/u.test(readFileSync(file, 'utf8')))
      .map(relativeHostPath);

    expect(offenders).toEqual([]);
  });

  it('does not depend on renderer or Electron implementation code', () => {
    const importLine = /^\s*import\s.*(?:@piarium\/ui|packages\/web\/src|packages\/electron|\.\.\/src\/)/u;
    const offenders = listFiles(hostRoot)
      .filter((file) => /\.(?:[cm]?[jt]s)$/u.test(file) && !file.endsWith('.test.ts') && !file.endsWith('.test.js'))
      .filter((file) => importLine.test(readFileSync(file, 'utf8')))
      .map(relativeHostPath);

    expect(offenders).toEqual([]);
  });

  it('keeps emitted JavaScript and declarations out of TypeScript source trees', () => {
    const sourceRoots = [
      'packages/extension-builtins/src',
      'packages/extension-contract/src',
      'packages/extension-host/src',
      'packages/protocol/src',
    ].map((entry) => path.join(repoRoot, entry));
    const offenders = sourceRoots.flatMap((root) => listFiles(root))
      .filter((file) => /(?:\.js|\.js\.map|\.d\.ts|\.d\.ts\.map)$/u.test(file))
      .map((file) => path.relative(repoRoot, file).split(path.sep).join('/'));

    expect(offenders).toEqual([]);
  });
});
