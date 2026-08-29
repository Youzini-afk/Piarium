import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(directory, '..');
const typescriptOutputRoot = join(packageDirectory, 'dist', 'builtin-packages', 'typescript-language');
const recoveryOutputRoot = join(packageDirectory, 'dist', 'builtin-packages', 'recovery');
const require = createRequire(import.meta.url);
const packageRoot = (name) => dirname(require.resolve(`${name}/package.json`));
const typescriptLanguageServerRoot = packageRoot('typescript-language-server');
const typescriptRoot = packageRoot('typescript');
const typescriptLanguageServerPackage = JSON.parse(await readFile(
  join(typescriptLanguageServerRoot, 'package.json'),
  'utf8',
));
const typescriptPackage = JSON.parse(await readFile(join(typescriptRoot, 'package.json'), 'utf8'));

const packageFingerprint = async (root, fingerprintFile) => {
  const files = [];
  const visit = async (directory, prefix = '') => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const logicalPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path, logicalPath);
      else if (entry.isFile() && logicalPath !== fingerprintFile) files.push({ logicalPath, path });
    }
  };
  await visit(root);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.logicalPath);
    hash.update('\0');
    hash.update(await readFile(file.path));
    hash.update('\0');
  }
  return `sha256-${hash.digest('hex')}`;
};

const writePackageFingerprint = async (root, fingerprintFile) => {
  await writeFile(
    join(root, fingerprintFile),
    `${await packageFingerprint(root, fingerprintFile)}\n`,
    'utf8',
  );
};

await rm(typescriptOutputRoot, { force: true, recursive: true });
await mkdir(join(typescriptOutputRoot, 'runtime'), { recursive: true });
await build({
  absWorkingDir: packageDirectory,
  bundle: true,
  entryPoints: [join(packageDirectory, 'src', 'host', 'typescript-language-extension.ts')],
  format: 'cjs',
  outfile: join(typescriptOutputRoot, 'host.cjs'),
  platform: 'node',
  sourcemap: false,
  target: ['node22'],
});
await cp(
  join(typescriptLanguageServerRoot, 'lib', 'cli.mjs'),
  join(typescriptOutputRoot, 'runtime', 'typescript-language-server.mjs'),
);
await cp(join(typescriptRoot, 'lib'), join(typescriptOutputRoot, 'runtime', 'typescript', 'lib'), { recursive: true });
await writeFile(join(typescriptOutputRoot, 'runtime', 'typescript', 'package.json'), `${JSON.stringify({
  name: 'typescript',
  private: true,
  version: typescriptPackage.version,
}, null, 2)}\n`);
await cp(join(typescriptLanguageServerRoot, 'LICENSE'), join(typescriptOutputRoot, 'LICENSE.typescript-language-server'));
await cp(join(typescriptRoot, 'LICENSE.txt'), join(typescriptOutputRoot, 'LICENSE.typescript'));
await cp(join(typescriptRoot, 'ThirdPartyNoticeText.txt'), join(typescriptOutputRoot, 'THIRD_PARTY_NOTICES.typescript'));
await writeFile(join(typescriptOutputRoot, 'package.json'), `${JSON.stringify({
  name: 'piarium-builtin-typescript-language',
  private: true,
  type: 'module',
  version: typescriptLanguageServerPackage.version,
}, null, 2)}\n`, 'utf8');

const {
  PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION,
  PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION,
} = await import('../dist/index.js');
const { PIARIUM_BUILTIN_ARTIFACT_FINGERPRINT_FILE } = await import('../dist/host.js');
const expectedVersion = `${typescriptLanguageServerPackage.version}+typescript.${typescriptPackage.version}.piarium.1`;
if (PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION.manifest.version !== expectedVersion) {
  throw new Error(`TypeScript language extension version must be ${expectedVersion}`);
}
await writeFile(
  join(typescriptOutputRoot, 'piarium.extension.json'),
  `${JSON.stringify(PIARIUM_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION.manifest, null, 2)}\n`,
  'utf8',
);

// Fail the build if the copied server accidentally stops being a self-contained ESM entrypoint.
const serverSource = await readFile(join(typescriptOutputRoot, 'runtime', 'typescript-language-server.mjs'), 'utf8');
if (!serverSource.startsWith('#!/usr/bin/env node') || !serverSource.includes("from 'node:")) {
  throw new Error('typescript-language-server runtime asset is no longer the expected self-contained Node entrypoint');
}
await writePackageFingerprint(typescriptOutputRoot, PIARIUM_BUILTIN_ARTIFACT_FINGERPRINT_FILE);

await rm(recoveryOutputRoot, { force: true, recursive: true });
await mkdir(recoveryOutputRoot, { recursive: true });
await build({
  absWorkingDir: packageDirectory,
  bundle: true,
  entryPoints: [join(packageDirectory, 'src', 'host', 'recovery-extension.ts')],
  format: 'cjs',
  outfile: join(recoveryOutputRoot, 'host.cjs'),
  platform: 'node',
  sourcemap: false,
  target: ['node22'],
});
await writeFile(join(recoveryOutputRoot, 'package.json'), `${JSON.stringify({
  name: 'piarium-builtin-recovery',
  private: true,
  type: 'module',
  version: PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION.manifest.version,
}, null, 2)}\n`, 'utf8');
await writeFile(
  join(recoveryOutputRoot, 'piarium.extension.json'),
  `${JSON.stringify(PIARIUM_BUILTIN_WORKSPACE_RECOVERY_EXTENSION.manifest, null, 2)}\n`,
  'utf8',
);
await writePackageFingerprint(recoveryOutputRoot, PIARIUM_BUILTIN_ARTIFACT_FINGERPRINT_FILE);
