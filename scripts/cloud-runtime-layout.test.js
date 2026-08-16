import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLOUD_RUNTIME_PACKAGE_DIRS,
  CLOUD_RUNTIME_SCHEMA_VERSION,
  verifyCloudRuntimeLayout,
  verifyCloudRuntimeIdentity,
} from './build-cloud-runtime.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const temporaryDirectories = [];

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piarium-cloud-runtime-'));
  temporaryDirectories.push(root);
  writeJson(path.join(root, 'package.json'), {
    name: 'piarium-cloud-runtime',
    license: 'AGPL-3.0-only',
    workspaces: ['packages/*'],
  });
  writeJson(path.join(root, 'cloud-runtime.json'), {
    schemaVersion: CLOUD_RUNTIME_SCHEMA_VERSION,
  });
  fs.writeFileSync(path.join(root, 'bun.lock'), '{}\n');
  fs.writeFileSync(path.join(root, 'LICENSE'), 'GNU AFFERO GENERAL PUBLIC LICENSE\n');
  fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), '# Third-party notices\n');

  const manifests = {
    'extension-contract': { name: '@piarium/extension-contract', dependencies: {} },
    'extension-builtins': {
      name: '@piarium/extension-builtins',
      dependencies: { '@piarium/extension-contract': '0.1.0' },
    },
    'extension-host': {
      name: '@piarium/extension-host',
      dependencies: {
        '@piarium/extension-builtins': '0.1.0',
        '@piarium/extension-contract': '0.1.0',
      },
    },
    protocol: { name: '@piarium/protocol', dependencies: {} },
    'pi-host': { name: '@piarium/pi-host', dependencies: { '@piarium/protocol': '0.1.0' } },
    'runtime-broker': {
      name: '@piarium/runtime-broker',
      dependencies: {
        '@piarium/pi-host': '0.1.0',
        '@piarium/protocol': '0.1.0',
      },
    },
    web: {
      name: '@piarium/web',
      dependencies: {
        '@piarium/extension-contract': 'workspace:*',
        '@piarium/extension-host': 'workspace:*',
        '@piarium/protocol': 'workspace:*',
        '@piarium/runtime-broker': 'workspace:*',
      },
    },
  };

  for (const directory of CLOUD_RUNTIME_PACKAGE_DIRS) {
    const packageRoot = path.join(root, 'packages', directory);
    writeJson(path.join(packageRoot, 'package.json'), manifests[directory]);
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    if (directory === 'web') {
      fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(packageRoot, 'server'), { recursive: true });
    }
  }
  return root;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Piarium cloud runtime layout', () => {
  it('keeps a committed production lock for reproducible image and SSH installs', () => {
    const lockPath = path.join(repoRoot, 'scripts', 'cloud-runtime.bun.lock');
    expect(fs.existsSync(lockPath)).toBe(true);
    const lockText = fs.readFileSync(lockPath, 'utf8');
    expect(lockText).toContain('"name": "piarium-cloud-runtime"');
    expect(lockText).toContain('"packages/extension-builtins"');
    expect(lockText).toContain('"packages/extension-contract"');
    expect(lockText).toContain('"packages/extension-host"');
    expect(lockText).toContain('"packages/runtime-broker"');
    expect(lockText).toContain('"packages/pi-host"');
    expect(lockText).toContain('"packages/protocol"');
    expect(lockText).toContain('"packages/web"');

    const builderSource = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'build-cloud-runtime.mjs'),
      'utf8',
    );
    expect(builderSource).toContain("'cloud-runtime.bun.lock'");
    expect(builderSource).toContain("['--frozen-lockfile']");
    expect(builderSource).toContain("case '--update-lock'");
    expect(builderSource).toContain('pruneNonRuntimeFiles');
  });

  it('builds every compiled browser dependency before the Web bundle', () => {
    const builderSource = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'build-cloud-runtime.mjs'),
      'utf8',
    );
    const buildFunction = builderSource.slice(builderSource.indexOf('const buildSourcePackages'));
    const extensionHostBuild = buildFunction.indexOf("'packages/extension-host'");
    const brokerBuild = buildFunction.indexOf("'packages/runtime-broker'");
    const clientBuild = buildFunction.indexOf("'packages/runtime-client'");
    const webBuild = buildFunction.indexOf("'packages/web'");

    expect(extensionHostBuild).toBeGreaterThanOrEqual(0);
    expect(brokerBuild).toBeGreaterThan(extensionHostBuild);
    expect(clientBuild).toBeGreaterThan(brokerBuild);
    expect(webBuild).toBeGreaterThan(clientBuild);
  });

  it('reinstalls Pi SDK packages into the staged cloud pi-host production graph', () => {
    const hostManifest = readJson(path.join(repoRoot, 'packages', 'pi-host', 'package.json'));
    expect(hostManifest.dependencies?.['@earendil-works/pi-coding-agent']).toBeUndefined();
    expect(hostManifest.devDependencies?.['@earendil-works/pi-coding-agent']).toBe('0.84.1');
    const builderSource = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'build-cloud-runtime.mjs'),
      'utf8',
    );
    expect(builderSource).toContain('readPiSdkRuntimeDependencies');
    expect(builderSource).toContain("directory === 'pi-host'");
  });

  it('contains the complete private Pi runtime dependency closure', () => {
    const packageNames = new Set(CLOUD_RUNTIME_PACKAGE_DIRS.map((directory) => (
      readJson(path.join(repoRoot, 'packages', directory, 'package.json')).name
    )));

    expect(CLOUD_RUNTIME_PACKAGE_DIRS).toEqual([
      'extension-contract',
      'extension-builtins',
      'extension-host',
      'protocol',
      'pi-host',
      'runtime-broker',
      'web',
    ]);
    for (const directory of CLOUD_RUNTIME_PACKAGE_DIRS) {
      const manifest = readJson(path.join(repoRoot, 'packages', directory, 'package.json'));
      for (const dependencyName of Object.keys(manifest.dependencies || {})) {
        if (dependencyName.startsWith('@piarium/')) {
          expect(packageNames.has(dependencyName), `${manifest.name} -> ${dependencyName}`).toBe(true);
        }
      }
    }
  });

  it('accepts the canonical application-host runtime tree', () => {
    const fixture = createFixture();
    expect(verifyCloudRuntimeLayout(fixture)).toMatchObject({
      schemaVersion: CLOUD_RUNTIME_SCHEMA_VERSION,
    });
  });

  it('rejects workspace dependencies that are not shipped in the runtime', () => {
    const fixture = createFixture();
    const webManifestPath = path.join(fixture, 'packages', 'web', 'package.json');
    const webManifest = readJson(webManifestPath);
    webManifest.dependencies['@piarium/missing-runtime'] = 'workspace:*';
    writeJson(webManifestPath, webManifest);

    expect(() => verifyCloudRuntimeLayout(fixture)).toThrow(
      'depends on missing workspace @piarium/missing-runtime',
    );
  });

  it('requires compiled package outputs and a production lockfile', () => {
    const fixture = createFixture();
    fs.rmSync(path.join(fixture, 'packages', 'pi-host', 'dist'), { recursive: true, force: true });
    expect(() => verifyCloudRuntimeLayout(fixture)).toThrow(
      'Missing runtime package entry: packages/pi-host/dist',
    );

    const secondFixture = createFixture();
    fs.rmSync(path.join(secondFixture, 'bun.lock'));
    expect(() => verifyCloudRuntimeLayout(secondFixture)).toThrow(
      'Cloud runtime bun.lock is missing',
    );
  });

  it('requires the AGPL metadata and legal notices in deployable artifacts', () => {
    const missingLicense = createFixture();
    fs.rmSync(path.join(missingLicense, 'LICENSE'));
    expect(() => verifyCloudRuntimeLayout(missingLicense)).toThrow(
      'Cloud runtime legal file is missing: LICENSE',
    );

    const wrongSpdx = createFixture();
    const manifestPath = path.join(wrongSpdx, 'package.json');
    const manifest = readJson(manifestPath);
    manifest.license = 'MIT';
    writeJson(manifestPath, manifest);
    expect(() => verifyCloudRuntimeLayout(wrongSpdx)).toThrow(
      'Unexpected cloud runtime license: MIT',
    );
  });

  it('rejects retired update services and commands from the staged production artifact', () => {
    const fixture = createFixture();
    const serverEntry = path.join(fixture, 'packages', 'web', 'server', 'package-manager.js');
    fs.writeFileSync(serverEntry, "export const updateUrl = 'https://api.openchamber.dev/v1/update/check';\n");

    expect(() => verifyCloudRuntimeIdentity(fixture)).toThrow(
      'Cloud runtime contains retired update identity',
    );
    expect(() => verifyCloudRuntimeLayout(fixture)).toThrow(
      'Cloud runtime contains retired update identity',
    );
  });
});
