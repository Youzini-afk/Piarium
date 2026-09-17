const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const pruneOnnxRuntime = require('./prune-onnx-runtime.cjs');
const {
  defaultKernelTargetTriple,
  detectKernelBinaryIdentity,
  normalizeKernelArchitecture,
} = require('../../../scripts/kernel-binary-identity.cjs');

const SEMANTIC_MODEL_FILES = [
  'tokenizer.json',
  'tokenizer_config.json',
  'config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx',
];

module.exports = (context) => {
  const resourcesPath = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const unpackedNodeModulesPath = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules');
  const kernelExecutable = context.electronPlatformName === 'win32' ? 'piarium-kernel.exe' : 'piarium-kernel';
  const packagedKernelPath = path.join(resourcesPath, 'kernel', kernelExecutable);
  const kernelManifestPath = path.join(resourcesPath, 'kernel', 'manifest.json');
  if (!fs.existsSync(packagedKernelPath) || !fs.existsSync(kernelManifestPath)) {
    throw new Error(`Missing packaged Rust kernel or manifest at ${path.join(resourcesPath, 'kernel')}`);
  }
  let kernelManifest;
  try {
    kernelManifest = JSON.parse(fs.readFileSync(kernelManifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read packaged Rust kernel manifest at ${kernelManifestPath}: ${error.message}`);
  }
  const kernelBytes = fs.readFileSync(packagedKernelPath);
  const kernelDigest = crypto.createHash('sha256').update(kernelBytes).digest('hex');
  const binaryIdentity = detectKernelBinaryIdentity(kernelBytes);
  const targetArchitecture = normalizeKernelArchitecture(process.env.PIARIUM_TARGET_ARCH || process.arch);
  const expectedTargetTriple = process.env.PIARIUM_TARGET_TRIPLE || defaultKernelTargetTriple(context.electronPlatformName, targetArchitecture);
  if (kernelManifest.schema !== 3 || kernelManifest.executable !== kernelExecutable || kernelManifest.sha256 !== kernelDigest
    || kernelManifest.protocolVersion !== 1 || kernelManifest.platform !== context.electronPlatformName
    || kernelManifest.arch !== targetArchitecture || kernelManifest.targetTriple !== expectedTargetTriple
    || kernelManifest.binaryFormat !== binaryIdentity.format
    || binaryIdentity.platform !== context.electronPlatformName || binaryIdentity.arch !== targetArchitecture
    || typeof kernelManifest.buildIdentity !== 'string' || !kernelManifest.buildIdentity
    || kernelManifest.kernelVersion !== '0.1.0') {
    throw new Error(`Packaged Rust kernel manifest does not match ${packagedKernelPath}`);
  }
  const trivium = path.join(unpackedNodeModulesPath, 'triviumdb');
  const suffix = context.electronPlatformName === 'win32' ? '-msvc' : context.electronPlatformName === 'linux' ? '-gnu' : '';
  const triviumBinary = 'triviumdb.' + context.electronPlatformName + '-' + targetArchitecture + suffix + '.node';
  if (!fs.existsSync(path.join(trivium, triviumBinary))) throw new Error('Missing target TriviumDB binary: ' + triviumBinary);
  for (const name of fs.readdirSync(trivium)) if (name.endsWith('.node') && name !== triviumBinary) fs.rmSync(path.join(trivium, name));
  pruneOnnxRuntime(unpackedNodeModulesPath, context.electronPlatformName, targetArchitecture);
  for (const legacy of ['node-pty', 'bun-pty', 'better-sqlite3']) {
    if (fs.existsSync(path.join(unpackedNodeModulesPath, legacy))) throw new Error('Obsolete native authority entered release: ' + legacy);
  }

  const packagedWebDistPath = path.join(resourcesPath, 'web-dist');
  if (!fs.existsSync(path.join(packagedWebDistPath, 'index.html'))) {
    throw new Error(`Missing packaged web UI at ${packagedWebDistPath}`);
  }
  fs.rmSync(
    path.join(unpackedNodeModulesPath, '@piarium', 'web', 'dist'),
    { recursive: true, force: true },
  );

  const requiredApplicationHostFiles = [
    path.join('node_modules', '@piarium', 'pi-host', 'dist', 'host-bootstrap.js'),
    path.join('node_modules', '@piarium', 'runtime-broker', 'dist', 'index.js'),
    path.join('node_modules', '@piarium', 'extension-host', 'dist', 'index.js'),
    path.join('node_modules', '@piarium', 'extension-builtins', 'dist', 'builtin-packages', 'recovery', 'piarium-builtin-fingerprint.txt'),
    path.join('node_modules', '@piarium', 'extension-builtins', 'dist', 'builtin-packages', 'recovery', 'piarium.extension.json'),
    path.join('node_modules', '@piarium', 'extension-builtins', 'dist', 'builtin-packages', 'recovery', 'host.cjs'),
    path.join('node_modules', '@piarium', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'piarium-builtin-fingerprint.txt'),
    path.join('node_modules', '@piarium', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'piarium.extension.json'),
    path.join('node_modules', '@piarium', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'host.cjs'),
    path.join('node_modules', '@piarium', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'runtime', 'typescript-language-server.mjs'),
    path.join('node_modules', '@piarium', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'runtime', 'typescript', 'package.json'),
    path.join('node_modules', '@piarium', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'runtime', 'typescript', 'lib', 'tsserver.js'),
    // Semantic retrieval is a production Host dependency. Keep the runtime
    // and the complete default MiniLM pack in the unpacked app so the external
    // Host can resolve both dynamic transformers imports and ONNX weights.
    path.join('node_modules', '@huggingface', 'transformers', 'package.json'),
    path.join('node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs'),
    path.join('node_modules', '@piarium', 'web', 'server', 'lib', 'knowledge', 'semantic', 'runtime', 'all-minilm-l6-v2', 'recipe.json'),
    path.join('node_modules', '@piarium', 'web', 'server', 'lib', 'knowledge', 'semantic', 'runtime', 'all-minilm-l6-v2', '.source-revision.json'),
    path.join('node_modules', '@piarium', 'web', 'server', 'lib', 'knowledge', 'semantic', 'runtime', 'all-minilm-l6-v2', 'tokenizer.json'),
    path.join('node_modules', '@piarium', 'web', 'server', 'lib', 'knowledge', 'semantic', 'runtime', 'all-minilm-l6-v2', 'tokenizer_config.json'),
    path.join('node_modules', '@piarium', 'web', 'server', 'lib', 'knowledge', 'semantic', 'runtime', 'all-minilm-l6-v2', 'config.json'),
    path.join('node_modules', '@piarium', 'web', 'server', 'lib', 'knowledge', 'semantic', 'runtime', 'all-minilm-l6-v2', 'special_tokens_map.json'),
    path.join('node_modules', '@piarium', 'web', 'server', 'lib', 'knowledge', 'semantic', 'runtime', 'all-minilm-l6-v2', 'onnx', 'model_quantized.onnx'),
  ];
  for (const relativePath of requiredApplicationHostFiles) {
    const packagedPath = path.join(resourcesPath, 'app.asar.unpacked', relativePath);
    let complete = false;
    try {
      const details = fs.statSync(packagedPath);
      complete = details.isFile() && details.size > 0;
    } catch {
      // Report the same actionable path below for missing and unreadable files.
    }
    if (!complete) {
      throw new Error(`Missing unpacked application-host runtime file at ${packagedPath}`);
    }
  }
  const semanticRecipePath = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@piarium',
    'web',
    'server',
    'lib',
    'knowledge',
    'semantic',
    'runtime',
    'all-minilm-l6-v2',
    'recipe.json',
  );
  let semanticRecipe;
  try {
    semanticRecipe = JSON.parse(fs.readFileSync(semanticRecipePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read packaged semantic model recipe at ${semanticRecipePath}: ${error.message}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(semanticRecipe.modelRevision || '')) {
    throw new Error(
      `Packaged semantic model recipe is not pinned to a full commit revision: ${semanticRecipe.modelRevision}`,
    );
  }
  const semanticMarkerPath = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@piarium',
    'web',
    'server',
    'lib',
    'knowledge',
    'semantic',
    'runtime',
    'all-minilm-l6-v2',
    '.source-revision.json',
  );
  let semanticMarker;
  try {
    semanticMarker = JSON.parse(fs.readFileSync(semanticMarkerPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read packaged semantic model source marker at ${semanticMarkerPath}: ${error.message}`);
  }
  const markerFiles = Array.isArray(semanticMarker.files) ? [...semanticMarker.files].sort() : [];
  if (
    semanticMarker.schemaVersion !== 1
    || semanticMarker.revision !== semanticRecipe.modelRevision
    || JSON.stringify(markerFiles) !== JSON.stringify([...SEMANTIC_MODEL_FILES].sort())
  ) {
    throw new Error(`Packaged semantic model source marker does not match recipe at ${semanticMarkerPath}`);
  }

  const packagedHostEntry = path.join(
    unpackedNodeModulesPath,
    '@piarium',
    'pi-host',
    'dist',
    'host-bootstrap.js',
  );
  const packagedBrokerEntry = path.join(
    unpackedNodeModulesPath,
    '@piarium',
    'runtime-broker',
    'dist',
    'index.js',
  );
  const piPackageRoot = path.resolve(
    __dirname,
    '..',
    '..',
    'pi-host',
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
  );
  const packagingNode = process.env.PIARIUM_PACKAGING_NODE || process.execPath;
  execFileSync(packagingNode, [
    path.join(__dirname, 'verify-packaged-pi-host.mjs'),
    packagedBrokerEntry,
    packagedHostEntry,
    piPackageRoot,
  ], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    stdio: 'inherit',
    windowsHide: true,
  });

  if (context.electronPlatformName !== 'darwin') return;

  const sourceAssetsPath = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');

  if (!fs.existsSync(sourceAssetsPath)) {
    throw new Error(`Missing compiled app icon asset catalog at ${sourceAssetsPath}`);
  }

  fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));
};
