const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
  const betterSqliteDir = path.dirname(require.resolve('better-sqlite3/package.json'));
  const targetArchitecture = process.env.PIARIUM_TARGET_ARCH || process.arch;
  const betterSqlitePrebuildName = `${context.electronPlatformName}-${targetArchitecture}.node`;
  const betterSqliteBinary = path.join(betterSqliteDir, 'prebuilds', betterSqlitePrebuildName);
  if (!fs.existsSync(betterSqliteBinary)) {
    throw new Error(`Missing better-sqlite3 prebuild at ${betterSqliteBinary}`);
  }
  const packagedBetterSqliteBinary = path.join(
    unpackedNodeModulesPath,
    'better-sqlite3',
    'prebuilds',
    betterSqlitePrebuildName,
  );
  fs.mkdirSync(path.dirname(packagedBetterSqliteBinary), { recursive: true });
  fs.copyFileSync(betterSqliteBinary, packagedBetterSqliteBinary);

  const packagedBetterSqliteDir = path.join(unpackedNodeModulesPath, 'better-sqlite3');
  for (const entry of fs.readdirSync(path.join(packagedBetterSqliteDir, 'prebuilds'))) {
    if (entry !== betterSqlitePrebuildName) {
      fs.rmSync(path.join(packagedBetterSqliteDir, 'prebuilds', entry), { recursive: true, force: true });
    }
  }
  for (const buildOnlyPath of ['build', 'deps', 'src', 'binding.gyp']) {
    fs.rmSync(path.join(packagedBetterSqliteDir, buildOnlyPath), { recursive: true, force: true });
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
