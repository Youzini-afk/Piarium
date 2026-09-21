import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import {
  normalizeTargetArchitecture,
  readElectronBuilderArchitecture,
  resolveTargetArchitecture,
} from './target-architecture.mjs';

const require = createRequire(import.meta.url);
const {
  defaultKernelTargetTriple,
  detectKernelBinaryIdentity,
  normalizeKernelArchitecture,
} = require('../../../scripts/kernel-binary-identity.cjs');

test('normalizes host and release architecture aliases', () => {
  assert.equal(normalizeTargetArchitecture('amd64').node, 'x64');
  assert.equal(normalizeTargetArchitecture('x86_64').electronBuilder, 'x64');
  assert.equal(normalizeTargetArchitecture('aarch64').node, 'arm64');
});

test('reads a single electron-builder target architecture', () => {
  assert.equal(readElectronBuilderArchitecture(['--linux', '--arch=aarch64']), 'arm64');
  assert.equal(readElectronBuilderArchitecture(['--linux', '--x64']), 'x64');
});

test('rejects unsupported architectures', () => {
  assert.throws(() => normalizeTargetArchitecture('ia32'), /Supported architectures: x64, arm64/);
});

test('rejects conflicting architecture inputs', () => {
  assert.throws(
    () => resolveTargetArchitecture({
      platform: 'linux',
      hostArchitecture: 'x64',
      environment: { VARIN_TARGET_ARCH: 'x64', ELECTRON_BUILDER_ARCH: 'arm64' },
    }),
    /Conflicting target architectures/,
  );
});

test('rejects cross-architecture Linux packaging', () => {
  assert.throws(
    () => resolveTargetArchitecture({
      platform: 'linux',
      hostArchitecture: 'x86_64',
      environment: { VARIN_TARGET_ARCH: 'aarch64' },
    }),
    /must be built natively.*host is x64, target is arm64/,
  );
});

test('accepts matching native Linux architecture aliases', () => {
  assert.equal(resolveTargetArchitecture({
    platform: 'linux',
    hostArchitecture: 'x64',
    environment: { VARIN_TARGET_ARCH: 'amd64' },
  }).node, 'x64');
});

test('normalizes kernel aliases and binds the target triple', () => {
  assert.equal(normalizeKernelArchitecture('amd64'), 'x64');
  assert.equal(normalizeKernelArchitecture('aarch64'), 'arm64');
  assert.equal(defaultKernelTargetTriple('win32', 'amd64'), 'x86_64-pc-windows-msvc');
});

test('reads the architecture from the actual kernel binary header', () => {
  const x64 = Buffer.alloc(0x80);
  x64.write('MZ', 0, 'ascii');
  x64.writeUInt32LE(0x40, 0x3c);
  x64.write('PE\0\0', 0x40, 'binary');
  x64.writeUInt16LE(0x8664, 0x44);
  assert.deepEqual(detectKernelBinaryIdentity(x64), { platform: 'win32', arch: 'x64', format: 'pe' });

  const arm64 = Buffer.from(x64);
  arm64.writeUInt16LE(0xaa64, 0x44);
  assert.deepEqual(detectKernelBinaryIdentity(arm64), { platform: 'win32', arch: 'arm64', format: 'pe' });
});
