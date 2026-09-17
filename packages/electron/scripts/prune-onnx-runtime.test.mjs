import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pruneOnnxRuntime from './prune-onnx-runtime.cjs';

const targets = ['linux/x64', 'linux/arm64', 'darwin/x64', 'darwin/arm64', 'win32/x64', 'win32/arm64'];

test('native packages retain only the target ONNX binding and all its companion libraries', (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'piarium-onnx-package-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const target of targets) {
    const modules = path.join(fixture, target, 'node_modules');
    const root = path.join(modules, 'onnxruntime-node/bin/napi-v6');
    for (const candidate of targets) {
      const directory = path.join(root, candidate);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'onnxruntime_binding.node'), candidate);
      fs.writeFileSync(path.join(directory, 'companion-library'), `library:${candidate}`);
    }
    pruneOnnxRuntime(modules, ...target.split('/'));
    for (const candidate of targets) {
      assert.equal(fs.existsSync(path.join(root, candidate)), candidate === target);
    }
    assert.equal(fs.readFileSync(path.join(root, target, 'onnxruntime_binding.node'), 'utf8'), target);
    assert.equal(fs.readFileSync(path.join(root, target, 'companion-library'), 'utf8'), `library:${target}`);
  }
});

test('a missing target binding fails before pruning other targets', (t) => {
  const modules = fs.mkdtempSync(path.join(os.tmpdir(), 'piarium-onnx-missing-'));
  t.after(() => fs.rmSync(modules, { recursive: true, force: true }));
  const foreign = path.join(modules, 'onnxruntime-node/bin/napi-v6/darwin/arm64');
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, 'onnxruntime_binding.node'), 'foreign');
  assert.throws(() => pruneOnnxRuntime(modules, 'linux', 'x64'), /Missing target ONNX runtime binding/);
  assert.equal(fs.readFileSync(path.join(foreign, 'onnxruntime_binding.node'), 'utf8'), 'foreign');
});
