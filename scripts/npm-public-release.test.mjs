import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  NPM_PUBLIC_PACKAGES,
  existingArtifactDecision,
  npmVersionFromTag,
  prepareNpmPublicVersion,
  registryPackageVersion,
  verifyNpmPublicRelease,
} from './npm-public-release-lib.mjs';

const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'piarium-npm-release-test-'));
  for (const definition of NPM_PUBLIC_PACKAGES) {
    const directory = path.join(root, definition.directory);
    await mkdir(directory, { recursive: true });
    const dependencies = {};
    if (definition.name === '@piarium/extension-surface') dependencies['@piarium/extension-contract'] = '0.1.0';
    if (definition.name === '@piarium/extension-sdk') {
      dependencies['@piarium/extension-contract'] = '0.1.0';
      dependencies['@piarium/extension-surface'] = '0.1.0';
    }
    if (definition.name === '@piarium/extension-react') dependencies['@piarium/extension-sdk'] = '0.1.0';
    if (definition.name === '@piarium/extension-cli') {
      dependencies['@piarium/extension-contract'] = '0.1.0';
      dependencies['@piarium/extension-sdk'] = '0.1.0';
      dependencies['@piarium/extension-surface'] = '0.1.0';
    }
    await writeFile(path.join(directory, 'package.json'), `${JSON.stringify({
      name: definition.name,
      version: '0.1.0',
      publishConfig: { access: 'public' },
      repository: {
        type: 'git',
        url: 'https://github.com/Youzini-afk/Piarium.git',
        directory: definition.directory,
      },
      dependencies,
    }, null, 2)}\n`);
  }
  await mkdir(path.join(root, 'packages/extension-cli/src'), { recursive: true });
  await writeFile(path.join(root, 'packages/extension-cli/src/templates.ts'), [
    'const dependencies = {',
    '  "@piarium/extension-contract": "0.1.0",',
    '  "@piarium/extension-sdk": "0.1.0",',
    '  "@piarium/extension-cli": "0.1.0",',
    '};',
    '',
  ].join('\n'));
  return root;
};

test('npm release tags carry one coordinated SemVer', () => {
  assert.equal(npmVersionFromTag('npm-v1.2.3'), '1.2.3');
  assert.equal(npmVersionFromTag('npm-v1.2.3-beta.1'), '1.2.3-beta.1');
  assert.throws(() => npmVersionFromTag('v1.2.3'), /npm-v/);
  assert.throws(() => npmVersionFromTag('npm-v01.2.3'), /Invalid/);
});

test('prepare updates every public package and its exact internal dependencies', async () => {
  const root = await fixture();
  try {
    await prepareNpmPublicVersion(root, '0.2.0');
    await verifyNpmPublicRelease(root, 'npm-v0.2.0');
    const cli = JSON.parse(await readFile(path.join(root, 'packages/extension-cli/package.json'), 'utf8'));
    assert.equal(cli.version, '0.2.0');
    assert.equal(cli.dependencies['@piarium/extension-contract'], '0.2.0');
    assert.equal(cli.dependencies['@piarium/extension-sdk'], '0.2.0');
    assert.equal(cli.dependencies['@piarium/extension-surface'], '0.2.0');
    const template = await readFile(path.join(root, 'packages/extension-cli/src/templates.ts'), 'utf8');
    assert.match(template, /"@piarium\/extension-contract": "0\.2\.0"/);
    assert.match(template, /"@piarium\/extension-sdk": "0\.2\.0"/);
    assert.match(template, /"@piarium\/extension-cli": "0\.2\.0"/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('verification rejects workspace ranges and mismatched package versions', async () => {
  const root = await fixture();
  try {
    const sdkPath = path.join(root, 'packages/extension-sdk/package.json');
    const sdk = JSON.parse(await readFile(sdkPath, 'utf8'));
    sdk.dependencies['@piarium/extension-contract'] = 'workspace:*';
    sdk.version = '0.2.0';
    await writeFile(sdkPath, `${JSON.stringify(sdk, null, 2)}\n`);
    await assert.rejects(
      verifyNpmPublicRelease(root, 'npm-v0.1.0'),
      /workspace:\*.*expected 0\.1\.0|expected 0\.1\.0.*workspace:\*/s,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('registry lookup distinguishes absence, failure, and immutable integrity', async () => {
  const missing = await registryPackageVersion('@piarium/example', '1.0.0', async () => ({ status: 404 }));
  assert.equal(missing, undefined);
  await assert.rejects(
    registryPackageVersion('@piarium/example', '1.0.0', async () => ({ ok: false, status: 503 })),
    /HTTP 503/,
  );
  const metadata = await registryPackageVersion('@piarium/example', '1.0.0', async () => ({
    ok: true,
    status: 200,
    json: async () => ({ dist: { integrity: 'sha512-same' } }),
  }));
  const artifact = { integrity: 'sha512-same', name: '@piarium/example', version: '1.0.0' };
  assert.equal(existingArtifactDecision(undefined, artifact), 'publish');
  assert.equal(existingArtifactDecision(metadata, artifact), 'skip');
  assert.throws(
    () => existingArtifactDecision({ dist: { integrity: 'sha512-other' } }, artifact),
    /different integrity/,
  );
});
