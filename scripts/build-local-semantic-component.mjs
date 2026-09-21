#!/usr/bin/env node
/** Build the separately installed, target-native local embedding component. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { prepareOnnxRuntime } from '../packages/electron/scripts/prepare-onnx-runtime.mjs';

const repository = path.resolve(import.meta.dirname, '..');
const webRoot = path.join(repository, 'packages/web');
const electronRoot = path.join(repository, 'packages/electron');
const webRequire = createRequire(path.join(webRoot, 'package.json'));
const electronRequire = createRequire(path.join(electronRoot, 'package.json'));
const tar = webRequire('tar');
const version = JSON.parse(fs.readFileSync(path.join(electronRoot, 'package.json'), 'utf8')).version;
const architecture = process.env.VARIN_TARGET_ARCH || process.arch;
if (architecture !== process.arch) throw new Error('Build local inference components on a matching native runner');
const outputArgument = process.argv.indexOf('--output');
const outputDirectory = path.resolve(outputArgument >= 0 ? process.argv[outputArgument + 1] : path.join(electronRoot, 'dist'));
await fsp.mkdir(outputDirectory, { recursive: true });
const artifact = path.join(outputDirectory, `Varin-local-semantic-${version}-${process.platform}-${architecture}.tar.gz`);
const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'varin-local-semantic-build-'));
const modules = path.join(staging, 'runtime/node_modules');
const copied = new Map();
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function resolvePackage(name, importerManifest) {
  const resolver = createRequire(importerManifest);
  for (const base of resolver.resolve.paths(name) || []) {
    const candidate = path.join(base, name, 'package.json');
    if (fs.existsSync(candidate)) return fs.realpathSync(path.dirname(candidate));
  }
  throw new Error(`Missing ${name}, required by ${importerManifest}`);
}

function supportsTarget(manifest) {
  const matches = (values, actual) => !Array.isArray(values)
    || (!values.includes(`!${actual}`) && (!values.some((value) => !value.startsWith('!')) || values.includes(actual)));
  return matches(manifest.os, process.platform) && matches(manifest.cpu, architecture)
    && matches(manifest.libc, 'glibc');
}

async function copyPackage(name, importerManifest, parentModules = modules) {
  const source = resolvePackage(name, importerManifest);
  const manifest = readJson(path.join(source, 'package.json'));
  if (!supportsTarget(manifest)) return;
  let destination = path.join(modules, name);
  if (copied.has(destination)) {
    if (copied.get(destination) === manifest.version) return;
    destination = path.join(parentModules, name);
  }
  if (copied.has(destination)) {
    if (copied.get(destination) !== manifest.version) throw new Error(`Conflicting dependency ${name}`);
    return;
  }
  copied.set(destination, manifest.version);
  await fsp.cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (file) => {
      const relative = path.relative(source, file).replaceAll('\\', '/');
      const parts = relative.split('/');
      if (parts.includes('node_modules') || ['test', 'tests', 'docs', 'examples'].includes(parts[0])) return false;
      if (/\.(?:map|d\.ts|tsbuildinfo)$/.test(relative)) return false;
      if (name === '@huggingface/transformers') {
        return relative === '' || ['package.json', 'LICENSE', 'dist', 'dist/transformers.node.mjs'].includes(relative);
      }
      if (name === 'onnxruntime-node' && relative.startsWith('bin/napi-v6/')) {
        return parts[2] === process.platform && (parts.length < 4 || parts[3] === architecture);
      }
      return true;
    },
  });
  // transformers.node.mjs already inlines its browser backend, tokenizer and
  // template code. Only its external Node imports belong in this component.
  const dependencies = name === '@huggingface/transformers'
    ? { 'onnxruntime-node': manifest.dependencies['onnxruntime-node'], 'sharp': manifest.dependencies.sharp }
    : manifest.dependencies || {};
  for (const dependency of Object.keys(dependencies)) {
    await copyPackage(dependency, path.join(source, 'package.json'), path.join(destination, 'node_modules'));
  }
  for (const dependency of Object.keys(manifest.optionalDependencies || {})) {
    let optional;
    try { optional = readJson(path.join(resolvePackage(dependency, path.join(source, 'package.json')), 'package.json')); }
    catch { continue; }
    if (supportsTarget(optional)) await copyPackage(dependency, path.join(source, 'package.json'), path.join(destination, 'node_modules'));
  }
}

try {
  execFileSync(process.execPath, [path.join(webRoot, 'scripts/copy-semantic-model.mjs')], { stdio: 'inherit', windowsHide: true });
  prepareOnnxRuntime();
  await copyPackage('@huggingface/transformers', path.join(webRoot, 'package.json'));
  const sourceModel = path.join(webRoot, 'application-host/lib/knowledge/semantic/runtime/all-minilm-l6-v2');
  const modelFiles = ['recipe.json', 'tokenizer.json', 'tokenizer_config.json', 'config.json', 'special_tokens_map.json', 'onnx/model_quantized.onnx'];
  for (const file of modelFiles) {
    const destination = path.join(staging, 'model', file);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(path.join(sourceModel, file), destination);
  }
  await fsp.copyFile(path.join(modules, '@huggingface/transformers/LICENSE'), path.join(staging, 'model/LICENSE'));
  const recipe = readJson(path.join(sourceModel, 'recipe.json'));
  await fsp.writeFile(path.join(staging, 'model/NOTICE.txt'), [
    'all-MiniLM-L6-v2 ONNX weights: Xenova/all-MiniLM-L6-v2',
    `Source revision: https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/${recipe.modelRevision}`,
    'Base model: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2',
    'License: Apache-2.0 (see LICENSE in this directory).',
    '',
  ].join('\n'));
  const transformersEntry = 'runtime/node_modules/@huggingface/transformers/dist/transformers.node.mjs';
  const check = `
    import assert from 'node:assert/strict';
    const { pipeline, env } = await import(${JSON.stringify(pathToFileURL(path.join(staging, transformersEntry)).href)});
    env.allowRemoteModels = false;
    env.localModelPath = ${JSON.stringify(staging)};
    const extract = await pipeline('feature-extraction', 'model', { local_files_only: true, dtype: 'q8' });
    const result = await extract(['Varin optional local inference'], { pooling: 'mean', normalize: true });
    const vectors = result.tolist();
    assert.equal(vectors[0].length, 384);
    assert.ok(vectors[0].every(Number.isFinite));
    assert.ok(vectors[0].some(value => value !== 0));
    await extract.dispose();
    console.log('[local-semantic] staged component produced a real 384-dimensional vector');
  `;
  execFileSync(electronRequire('electron'), ['--input-type=module', '-e', check], {
    cwd: staging, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' }, stdio: 'inherit', windowsHide: true,
  });
  const files = {};
  async function recordFiles(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await recordFiles(file);
      else {
        const bytes = await fsp.readFile(file);
        files[path.relative(staging, file).replaceAll('\\', '/')] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
      }
    }
  }
  await recordFiles(staging);
  await fsp.writeFile(path.join(staging, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, id: 'local-semantic', version, platform: process.platform, arch: architecture,
    modelPath: 'model', transformersEntry, files,
  }, null, 2) + '\n');
  await tar.c({ cwd: staging, file: `${artifact}.tmp`, gzip: true, portable: true }, ['manifest.json', 'model', 'runtime']);
  await fsp.rename(`${artifact}.tmp`, artifact);
  const bytes = await fsp.readFile(artifact);
  await fsp.writeFile(`${artifact}.sha256`, `${createHash('sha256').update(bytes).digest('hex')}  ${path.basename(artifact)}\n`);
  console.log(`[local-semantic] ${artifact} (${(bytes.length / 1048576).toFixed(1)} MiB; ${Object.keys(files).length} files)`);
} finally {
  await fsp.rm(staging, { recursive: true, force: true });
}
