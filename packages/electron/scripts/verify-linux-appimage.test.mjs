import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { linuxAppImageArchSuffix, readElfArchitecture, verifyExtractedPayload } from './verify-linux-appimage.mjs';

const writeElf = (filePath, architecture) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const header = Buffer.alloc(20);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  header.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18);
  fs.writeFileSync(filePath, header, { mode: 0o755 });
};

const createPayload = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-payload-test-'));
  fs.writeFileSync(path.join(root, 'varin.desktop'), [
    '[Desktop Entry]', 'Name=Varin', 'Exec=AppRun --no-sandbox %U', 'Icon=varin', 'StartupWMClass=varin', '',
  ].join('\n'));
  writeElf(path.join(root, 'varin'), 'x64');
  writeElf(
    path.join(root, 'resources/app.asar.unpacked/node_modules/triviumdb/triviumdb.linux-x64-gnu.node'),
    'x64',
  );
  writeElf(path.join(root, 'resources/kernel/varin-kernel'), 'x64');
  for (const name of ['sherpa-onnx.node']) {
    writeElf(path.join(root, 'resources/app.asar.unpacked/node_modules', name), 'x64');
  }
  return root;
};

test('reads supported ELF architectures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-elf-test-'));
  try {
    writeElf(path.join(root, 'x64'), 'x64');
    writeElf(path.join(root, 'arm64'), 'arm64');
    assert.equal(readElfArchitecture(path.join(root, 'x64')), 'x64');
    assert.equal(readElfArchitecture(path.join(root, 'arm64')), 'arm64');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AppImage artifact names use electron-builder arch suffixes', () => {
  assert.equal(linuxAppImageArchSuffix('x64'), 'x86_64');
  assert.equal(linuxAppImageArchSuffix('arm64'), 'arm64');
});

test('verifies identity and native payload architecture', () => {
  const root = createPayload();
  try {
    const result = verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
    });
    assert.equal(result.nativeModuleCount, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails on a missing native module', () => {
  const root = createPayload();
  try {
    fs.rmSync(path.join(root, 'resources/app.asar.unpacked/node_modules/sherpa-onnx.node'));
    assert.throws(() => verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
    }), /Missing packaged native module: sherpa-onnx\.node/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails on wrong native architecture', () => {
  const root = createPayload();
  try {
    writeElf(path.join(root, 'resources/app.asar.unpacked/node_modules/sherpa-onnx.node'), 'arm64');
    assert.throws(() => verifyExtractedPayload({
      root,
      targetArchitecture: 'x64',
    }), /Native module architecture mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
