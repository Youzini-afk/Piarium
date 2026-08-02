import { describe, expect, test } from 'bun:test';
import { findPiPackage, piPackageNameFromSource } from './packages';

describe('Pi package identity', () => {
  test('recognizes unpinned and versioned npm sources', () => {
    expect(piPackageNameFromSource('npm:pi-workspace-history')).toBe('pi-workspace-history');
    expect(piPackageNameFromSource('npm:pi-workspace-history@0.2.2')).toBe('pi-workspace-history');
    expect(piPackageNameFromSource('npm:@example/history@1.0.0')).toBe('@example/history');
  });

  test('recognizes local Windows and file URL working copies', () => {
    expect(piPackageNameFromSource('D:\\project\\opencr\\pi-wtf')).toBe('pi-wtf');
    expect(piPackageNameFromSource('file:///D:/project/opencr/pi-workspace-history.git')).toBe('pi-workspace-history');
  });

  test('finds a configured integration without replacing its original source', () => {
    const configured = findPiPackage([
      { enabled: true, name: 'D:\\project\\opencr\\pi-wtf', source: 'D:\\project\\opencr\\pi-wtf' },
    ], 'pi-wtf');
    expect(configured?.source).toBe('D:\\project\\opencr\\pi-wtf');
  });
});
