import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';

import { pathLooksUserConfigured, mergePathValues } from './path-utils.js';

const home = os.homedir();
const delim = path.delimiter;
const pathValue = (...segments: string[]): string => segments.join(delim);

describe('pathLooksUserConfigured', () => {
  it('returns false for empty or non-string values', () => {
    expect(pathLooksUserConfigured('', home, delim)).toBe(false);
    expect(pathLooksUserConfigured(null, home, delim)).toBe(false);
    expect(pathLooksUserConfigured(undefined, home, delim)).toBe(false);
    expect(pathLooksUserConfigured(42, home, delim)).toBe(false);
  });

  it('returns false for minimal system PATH', () => {
    expect(pathLooksUserConfigured(pathValue('/usr/local/bin', '/usr/bin', '/bin'), home, delim)).toBe(false);
  });

  it('detects paths under home directory', () => {
    expect(pathLooksUserConfigured(pathValue(path.join(home, '.bun', 'bin'), '/usr/bin'), home, delim)).toBe(true);
    expect(pathLooksUserConfigured(pathValue(path.join(home, '.local', 'bin'), '/usr/bin'), home, delim)).toBe(true);
  });

  it('detects home directory itself', () => {
    expect(pathLooksUserConfigured(pathValue(home, '/usr/bin'), home, delim)).toBe(true);
  });

  it('detects well-known package manager prefixes', () => {
    expect(pathLooksUserConfigured('/opt/homebrew/bin:/usr/bin', home, delim)).toBe(true);
    expect(pathLooksUserConfigured('/opt/pkg/bin:/usr/bin', home, delim)).toBe(true);
    expect(pathLooksUserConfigured('/snap/bin:/usr/bin', home, delim)).toBe(true);
  });

  it('detects well-known dot-directory basenames', () => {
    expect(pathLooksUserConfigured('/some/path/.cargo/bin:/usr/bin', home, delim)).toBe(true);
    expect(pathLooksUserConfigured('/some/path/.nvm/versions/node/v20/bin:/usr/bin', home, delim)).toBe(true);
    expect(pathLooksUserConfigured('/some/path/.pyenv/shims:/usr/bin', home, delim)).toBe(true);
  });

  it('detects Windows home and toolchain paths', () => {
    const windowsHome = 'C:\\Users\\agent';
    expect(pathLooksUserConfigured('C:\\Users\\agent\\.bun\\bin;C:\\Windows\\System32', windowsHome, ';')).toBe(true);
    expect(pathLooksUserConfigured('C:\\tools\\.cargo\\bin;C:\\Windows\\System32', windowsHome, ';')).toBe(true);
  });
});

describe('mergePathValues', () => {
  it('returns empty string for empty inputs', () => {
    expect(mergePathValues('', '', delim)).toBe('');
  });

  it('returns primary when fallback is empty', () => {
    expect(mergePathValues(pathValue('/a', '/b'), '', delim)).toBe(pathValue('/a', '/b'));
  });

  it('returns fallback when primary is empty', () => {
    expect(mergePathValues('', pathValue('/a', '/b'), delim)).toBe(pathValue('/a', '/b'));
  });

  it('deduplicates segments, preserving primary order', () => {
    expect(mergePathValues(pathValue('/a', '/b', '/c'), pathValue('/b', '/d', '/a'), delim))
      .toBe(pathValue('/a', '/b', '/c', '/d'));
  });

  it('appends all fallback segments when no overlap', () => {
    expect(mergePathValues(pathValue('/a', '/b'), pathValue('/c', '/d'), delim))
      .toBe(pathValue('/a', '/b', '/c', '/d'));
  });
});
