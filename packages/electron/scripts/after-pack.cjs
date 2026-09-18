const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  defaultKernelTargetTriple,
  detectKernelBinaryIdentity,
  normalizeKernelArchitecture,
} = require('../../../scripts/kernel-binary-identity.cjs');

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
  for (const optional of ['@huggingface/transformers', 'onnxruntime-node', 'onnxruntime-web']) {
    if (fs.existsSync(path.join(unpackedNodeModulesPath, optional))) {
      throw new Error(`Optional local inference dependency entered the base installer: ${optional}`);
    }
  }
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
  const bundledModelDirectory = path.join(unpackedNodeModulesPath, '@piarium', 'web', 'server', 'lib', 'knowledge', 'semantic', 'runtime');
  if (fs.existsSync(bundledModelDirectory)) throw new Error('Local model weights entered the base installer');

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
  const packagedExecutable = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'MacOS', context.packager.appInfo.productFilename)
    : path.join(context.appOutDir, context.electronPlatformName === 'win32'
      ? `${context.packager.appInfo.productFilename}.exe`
      : context.packager.appInfo.productFilename.toLowerCase());
  execFileSync(packagedExecutable, [
    path.join(__dirname, 'verify-packaged-pi-host.mjs'),
    packagedBrokerEntry,
    packagedHostEntry,
  ], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
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
