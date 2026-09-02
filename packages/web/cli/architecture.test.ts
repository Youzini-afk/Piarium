import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliRoot = fileURLToPath(new URL('.', import.meta.url));

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

const relativeCliPath = (absolutePath: string): string => (
  path.relative(cliRoot, absolutePath).split(path.sep).join('/')
);

describe('Web CLI source boundary', () => {
  it('keeps CLI source fully TypeScript', () => {
    const javascriptSources = listFiles(cliRoot)
      .filter((file) => /\.(?:js|mjs|cjs)$/u.test(file))
      .map(relativeCliPath)
      .sort();

    expect(javascriptSources).toEqual([]);
  });

  it('does not disable TypeScript checking in CLI files', () => {
    const offenders = listFiles(cliRoot)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /@ts-(?:nocheck|ignore)/u.test(readFileSync(file, 'utf8')))
      .map(relativeCliPath);

    expect(offenders).toEqual([]);
  });

  it('does not import renderer or Electron implementation code', () => {
    // Only check actual import statements, not comments that mention package names.
    const importLine = /^\s*import\s.*(?:@piarium\/ui|packages\/electron|\.\.\/src\/)/mu;
    const offenders = listFiles(cliRoot)
      .filter((file) => /\.(?:[cm]?[jt]s)$/u.test(file) && !file.endsWith('.test.ts'))
      .filter((file) => importLine.test(readFileSync(file, 'utf8')))
      .map(relativeCliPath);

    expect(offenders).toEqual([]);
  });
});
