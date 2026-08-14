#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const canonicalLockPath = path.join(repoRoot, 'scripts', 'cloud-runtime.bun.lock');

export const CLOUD_RUNTIME_SCHEMA_VERSION = 1;
export const CLOUD_RUNTIME_PACKAGE_DIRS = Object.freeze([
  'extension-contract',
  'extension-host',
  'protocol',
  'pi-host',
  'runtime-broker',
  'web',
]);

export const CLOUD_RUNTIME_FORBIDDEN_UPDATE_IDENTITIES = Object.freeze([
  'api.openchamber.dev/v1/update/check',
  'github.com/openchamber/openchamber/releases',
  'api.github.com/repos/openchamber/openchamber/releases',
  'openchamber-update-check',
  'openchamber update',
  'openchamber mini chat',
  'openchamber.pwaname',
  'openchamber.pwaorientation',
  'openchamber.mobilekeyboardmode',
  'openchamber.pwarecentsessions',
  'opencodebinary',
  'opencode_binary',
  'configure openai in opencode',
]);

const cloudIdentityTextExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.ts',
  '.tsx',
]);

const packageFiles = Object.freeze({
  'extension-contract': {
    required: ['package.json', 'dist'],
    optional: [],
  },
  'extension-host': {
    required: ['package.json', 'dist'],
    optional: [],
  },
  protocol: {
    required: ['package.json', 'dist'],
    optional: [],
  },
  'pi-host': {
    required: ['package.json', 'dist'],
    optional: [],
  },
  'runtime-broker': {
    required: ['package.json', 'dist'],
    optional: [],
  },
  web: {
    required: ['package.json', 'bin', 'server', 'dist'],
    optional: ['public', 'README.md'],
  },
});

const readJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'));

const run = (command, args, { cwd = repoRoot, env, json = false, label } = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: json ? 'pipe' : 'inherit',
    shell: false,
  });

  if (json) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  if (result.error) {
    throw new Error(`${label || command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label || [command, ...args].join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout?.trim() || '';
};

const gitOutput = (args) => {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
  });
  return result.status === 0 ? result.stdout.trim() : '';
};

const copyEntry = (source, destination, required) => {
  if (!existsSync(source)) {
    if (required) throw new Error(`Cloud runtime source is missing: ${source}`);
    return;
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
};

const pruneNonRuntimeFiles = (root) => {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && /\.(?:test|spec)\.(?:c|m)?js$/i.test(entry.name)) {
        rmSync(entryPath, { force: true });
      }
    }
  }
};

const createRuntimeRootPackage = (rootPackage) => ({
  name: 'piarium-cloud-runtime',
  version: rootPackage.version,
  private: true,
  type: 'module',
  description: 'Self-contained Piarium cloud runtime workspace.',
  license: rootPackage.license,
  packageManager: rootPackage.packageManager,
  engines: {
    node: '>=22.19.0',
  },
  workspaces: [
    'packages/*',
  ],
  scripts: {
    start: 'node packages/web/bin/cli.js serve --foreground',
  },
  trustedDependencies: [
    'better-sqlite3',
    'node-pty',
  ],
  overrides: rootPackage.overrides,
});

const collectPackageMetadata = (root = repoRoot) => Object.fromEntries(
  CLOUD_RUNTIME_PACKAGE_DIRS.map((directory) => {
    const manifest = readJson(path.join(root, 'packages', directory, 'package.json'));
    return [manifest.name, { directory, version: manifest.version }];
  }),
);

export const verifyCloudRuntimeIdentity = (outputDir) => {
  const stack = [outputDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !cloudIdentityTextExtensions.has(path.extname(entry.name).toLowerCase())) continue;

      const source = readFileSync(entryPath, 'utf8').toLowerCase();
      const retiredIdentity = CLOUD_RUNTIME_FORBIDDEN_UPDATE_IDENTITIES.find((value) => source.includes(value));
      if (retiredIdentity) {
        throw new Error(`Cloud runtime contains retired update identity "${retiredIdentity}" in ${path.relative(outputDir, entryPath)}.`);
      }
    }
  }
};

export const verifyCloudRuntimeLayout = (outputDir, { requireLock = true, requireInstall = false } = {}) => {
  const rootManifestPath = path.join(outputDir, 'package.json');
  const runtimeManifestPath = path.join(outputDir, 'cloud-runtime.json');
  if (!existsSync(rootManifestPath)) throw new Error('Cloud runtime package.json is missing.');
  if (!existsSync(runtimeManifestPath)) throw new Error('Cloud runtime manifest is missing.');
  for (const legalFile of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    if (!existsSync(path.join(outputDir, legalFile))) {
      throw new Error(`Cloud runtime legal file is missing: ${legalFile}.`);
    }
  }
  if (requireLock && !existsSync(path.join(outputDir, 'bun.lock'))) {
    throw new Error('Cloud runtime bun.lock is missing.');
  }

  const rootManifest = readJson(rootManifestPath);
  const runtimeManifest = readJson(runtimeManifestPath);
  if (runtimeManifest.schemaVersion !== CLOUD_RUNTIME_SCHEMA_VERSION) {
    throw new Error(`Unsupported cloud runtime schema: ${runtimeManifest.schemaVersion}`);
  }
  if (rootManifest.name !== 'piarium-cloud-runtime') {
    throw new Error(`Unexpected cloud runtime package name: ${rootManifest.name}`);
  }
  if (rootManifest.license !== 'AGPL-3.0-only') {
    throw new Error(`Unexpected cloud runtime license: ${rootManifest.license || '(missing)'}`);
  }
  if (
    !Array.isArray(rootManifest.workspaces)
    || rootManifest.workspaces.length !== 1
    || rootManifest.workspaces[0] !== 'packages/*'
  ) {
    throw new Error('Cloud runtime must expose one canonical packages/* workspace.');
  }

  const packageNames = new Set();
  for (const directory of CLOUD_RUNTIME_PACKAGE_DIRS) {
    const packageRoot = path.join(outputDir, 'packages', directory);
    const manifestPath = path.join(packageRoot, 'package.json');
    if (!existsSync(manifestPath)) throw new Error(`Missing runtime package manifest: ${directory}`);
    const manifest = readJson(manifestPath);
    packageNames.add(manifest.name);

    for (const entry of packageFiles[directory].required) {
      if (!existsSync(path.join(packageRoot, entry))) {
        throw new Error(`Missing runtime package entry: packages/${directory}/${entry}`);
      }
    }
  }

  for (const directory of CLOUD_RUNTIME_PACKAGE_DIRS) {
    const manifest = readJson(path.join(outputDir, 'packages', directory, 'package.json'));
    for (const [dependencyName, dependencyVersion] of Object.entries(manifest.dependencies || {})) {
      if (dependencyName.startsWith('@piarium/') && !packageNames.has(dependencyName)) {
        throw new Error(`Runtime package ${manifest.name} depends on missing workspace ${dependencyName}.`);
      }
      if (dependencyVersion.startsWith('workspace:') && !packageNames.has(dependencyName)) {
        throw new Error(`Unresolved workspace dependency ${dependencyName} in ${manifest.name}.`);
      }
    }
  }

  if (requireInstall) {
    const brokerLink = path.join(outputDir, 'packages', 'web', 'node_modules', '@piarium', 'runtime-broker');
    if (!existsSync(brokerLink)) throw new Error('Installed cloud runtime cannot resolve @piarium/runtime-broker.');
    const extensionHostLink = path.join(outputDir, 'packages', 'web', 'node_modules', '@piarium', 'extension-host');
    if (!existsSync(extensionHostLink)) throw new Error('Installed cloud runtime cannot resolve @piarium/extension-host.');
  }

  verifyCloudRuntimeIdentity(outputDir);

  return runtimeManifest;
};

export const installCloudRuntimeDependencies = (
  outputDir,
  { cacheDir = null, json = false } = {},
) => {
  const resolvedOutput = path.resolve(outputDir);
  const resolvedCacheDir = path.resolve(cacheDir || path.join(path.dirname(resolvedOutput), '.bun-cloud-cache'));
  mkdirSync(resolvedCacheDir, { recursive: true });

  const installDependencies = () => run(
    'bun',
    [
      'install',
      '--production',
      '--frozen-lockfile',
      '--backend=hardlink',
      `--cache-dir=${resolvedCacheDir}`,
    ],
    {
      cwd: resolvedOutput,
      json,
      label: 'Cloud runtime dependency installation',
    },
  );

  try {
    installDependencies();
  } catch (error) {
    console.error(`Cloud runtime install retry after partial cache/link failure: ${error.message}`);
    installDependencies();
  }

  verifyCloudRuntimeLayout(resolvedOutput, { requireLock: true, requireInstall: true });
  run('node', [
    '--input-type=module',
    '-e',
    "import { createRequire } from 'node:module'; const broker = await import('./packages/web/node_modules/@piarium/runtime-broker/dist/index.js'); const extensions = await import('./packages/web/node_modules/@piarium/extension-host/dist/index.js'); if (typeof extensions.ApplicationExtensionCatalog !== 'function') throw new Error('Piarium extension host is unavailable'); const entry = broker.resolveBundledPiHostEntry(); if (!entry) throw new Error('Pi host entry was not resolved'); const require = createRequire(new URL('./packages/web/package.json', import.meta.url)); const pty = require('node-pty'); if (typeof pty.spawn !== 'function') throw new Error('node-pty is unavailable'); require.resolve('sherpa-onnx-node'); console.log(entry);",
  ], {
    cwd: resolvedOutput,
    json,
    label: 'Cloud runtime Pi host resolution',
  });
};

const buildSourcePackages = ({ json }) => {
  run('bun', ['run', '--cwd', 'packages/extension-host', 'build'], {
    json,
    label: 'Piarium extension host build',
  });
  run('bun', ['run', '--cwd', 'packages/runtime-broker', 'build'], {
    json,
    label: 'Pi runtime build',
  });
  run('bun', ['run', '--cwd', 'packages/runtime-client', 'build'], {
    json,
    label: 'Pi runtime client build',
  });
  run('bun', ['run', '--cwd', 'packages/extension-surface', 'build'], {
    json,
    label: 'Piarium extension Surface build',
  });
  run('bun', ['run', '--cwd', 'packages/web', 'build'], {
    env: { PIARIUM_LOW_MEMORY_BUILD: '1' },
    json,
    label: 'Piarium web build',
  });
};

const stageRuntimeTree = (outputDir) => {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(path.join(outputDir, 'packages'), { recursive: true });

  const rootPackage = readJson(path.join(repoRoot, 'package.json'));
  writeFileSync(
    path.join(outputDir, 'package.json'),
    `${JSON.stringify(createRuntimeRootPackage(rootPackage), null, 2)}\n`,
  );
  copyEntry(path.join(repoRoot, 'LICENSE'), path.join(outputDir, 'LICENSE'), true);
  copyEntry(
    path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'),
    path.join(outputDir, 'THIRD_PARTY_NOTICES.md'),
    true,
  );

  for (const directory of CLOUD_RUNTIME_PACKAGE_DIRS) {
    const sourceRoot = path.join(repoRoot, 'packages', directory);
    const destinationRoot = path.join(outputDir, 'packages', directory);
    for (const entry of packageFiles[directory].required) {
      copyEntry(path.join(sourceRoot, entry), path.join(destinationRoot, entry), true);
    }
    for (const entry of packageFiles[directory].optional) {
      copyEntry(path.join(sourceRoot, entry), path.join(destinationRoot, entry), false);
    }

    const stagedManifestPath = path.join(destinationRoot, 'package.json');
    const stagedManifest = readJson(stagedManifestPath);
    delete stagedManifest.devDependencies;
    stagedManifest.private = true;
    writeFileSync(stagedManifestPath, `${JSON.stringify(stagedManifest, null, 2)}\n`);
  }

  pruneNonRuntimeFiles(path.join(outputDir, 'packages'));

  const sourceRevision = process.env.PIARIUM_SOURCE_REVISION?.trim()
    || gitOutput(['rev-parse', 'HEAD'])
    || null;
  const sourceDirty = process.env.PIARIUM_SOURCE_DIRTY === 'true'
    || Boolean(gitOutput(['status', '--porcelain', '--untracked-files=no']));
  const runtimeManifest = {
    schemaVersion: CLOUD_RUNTIME_SCHEMA_VERSION,
    name: 'Piarium Cloud Runtime',
    version: rootPackage.version,
    sourceRevision,
    sourceDirty,
    packageManager: rootPackage.packageManager,
    nodeEngine: '>=22.19.0',
    packages: collectPackageMetadata(),
    entrypoint: 'packages/web/bin/cli.js',
    healthPath: '/health',
  };
  writeFileSync(
    path.join(outputDir, 'cloud-runtime.json'),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
  );
  return runtimeManifest;
};

const createArchive = (outputDir, archivePath, { json }) => {
  mkdirSync(path.dirname(archivePath), { recursive: true });
  rmSync(archivePath, { force: true });
  run('tar', ['-czf', archivePath, '-C', outputDir, '.'], {
    json,
    label: 'Cloud runtime archive creation',
  });
};

const sha256File = (filePath) => {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
};

export const buildCloudRuntime = ({
  outputDir,
  archivePath = null,
  build = true,
  generateLock = true,
  updateLock = false,
  install = false,
  cacheDir = null,
  json = false,
} = {}) => {
  const resolvedOutput = path.resolve(outputDir || path.join(repoRoot, 'artifacts', 'cloud-runtime'));
  if (build) buildSourcePackages({ json });
  const runtimeManifest = stageRuntimeTree(resolvedOutput);

  if (updateLock && !generateLock) {
    throw new Error('--update-lock cannot be combined with --no-lock.');
  }

  if (generateLock) {
    if (!updateLock) {
      if (!existsSync(canonicalLockPath)) {
        throw new Error(`Canonical cloud runtime lockfile is missing: ${canonicalLockPath}`);
      }
      cpSync(canonicalLockPath, path.join(resolvedOutput, 'bun.lock'), { force: true });
    }
    run('bun', [
      'install',
      '--lockfile-only',
      '--production',
      '--ignore-scripts',
      ...(updateLock ? [] : ['--frozen-lockfile']),
    ], {
      cwd: resolvedOutput,
      json,
      label: updateLock
        ? 'Cloud runtime lockfile generation'
        : 'Cloud runtime lockfile verification',
    });
    if (updateLock) {
      cpSync(path.join(resolvedOutput, 'bun.lock'), canonicalLockPath, { force: true });
    }
  }

  verifyCloudRuntimeLayout(resolvedOutput, { requireLock: generateLock });

  if (install) {
    installCloudRuntimeDependencies(resolvedOutput, { cacheDir, json });
  }

  const resolvedArchive = archivePath ? path.resolve(archivePath) : null;
  if (resolvedArchive) createArchive(resolvedOutput, resolvedArchive, { json });

  return {
    outputDir: resolvedOutput,
    archivePath: resolvedArchive,
    archiveSha256: resolvedArchive ? sha256File(resolvedArchive) : null,
    archiveSize: resolvedArchive ? statSync(resolvedArchive).size : null,
    ...runtimeManifest,
  };
};

const parseArgs = (argv) => {
  const options = {
    outputDir: path.join(repoRoot, 'artifacts', 'cloud-runtime'),
    archivePath: path.join(repoRoot, 'artifacts', 'piarium-cloud-runtime.tgz'),
    build: true,
    generateLock: true,
    updateLock: false,
    install: false,
    cacheDir: null,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('-')) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return next;
    };
    switch (arg) {
      case '--output': options.outputDir = value(); break;
      case '--archive': options.archivePath = value(); break;
      case '--no-archive': options.archivePath = null; break;
      case '--skip-build': options.build = false; break;
      case '--no-lock': options.generateLock = false; break;
      case '--update-lock': options.updateLock = true; break;
      case '--install': options.install = true; break;
      case '--cache-dir': options.cacheDir = value(); break;
      case '--json': options.json = true; break;
      case '--help':
        console.log(`Usage: node scripts/build-cloud-runtime.mjs [options]\n\nOptions:\n  --output <dir>      Runtime tree output (default: artifacts/cloud-runtime)\n  --archive <file>    Create a .tgz archive\n  --no-archive        Do not create an archive\n  --skip-build        Stage existing package build outputs\n  --no-lock           Skip production lockfile generation\n  --update-lock       Regenerate scripts/cloud-runtime.bun.lock\n  --install           Install target-platform production dependencies\n  --cache-dir <dir>   Bun cache used by --install\n  --json              Print the final metadata as JSON only`);
        return null;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
};

const isDirectExecution = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options) {
      const result = buildCloudRuntime(options);
      if (options.json) console.log(JSON.stringify(result));
      else {
        console.log(`Piarium cloud runtime: ${result.outputDir}`);
        if (result.archivePath) console.log(`Archive: ${result.archivePath} (${result.archiveSha256})`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
