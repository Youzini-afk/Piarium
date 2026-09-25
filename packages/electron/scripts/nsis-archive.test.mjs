import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
builderRequire('app-builder-lib');
const library = createRequire(builderRequire.resolve('app-builder-lib'));
const { NsisTarget } = library('./targets/nsis/NsisTarget');
const { createBlockmap } = library('./targets/differentialUpdateInfoBuilder');
const { getPath7za } = library('./toolsets/7zip');
const { getMakeNsisPath } = library('./toolsets/windows');
const exec = promisify(execFile);
const configuration = require('../package.json').build;
const resources = fileURLToPath(new URL('../resources/', import.meta.url));
const extractorInclude = path.join(resources, 'installer-extract.nsh');
const builderRoot = path.dirname(builderRequire.resolve('app-builder-lib/package.json'));
const nsisPath = (value) => value.replaceAll('/', '\\').replace(/\$/g, () => '$$');

async function buildArchive(root) {
  const source = path.join(root, 'app');
  const deepPath = 'resources/app.asar.unpacked/node_modules/@varin/extension-builtins/dist/builtin-packages/language-servers/runtime/dist/typeshed-fallback/stubs/oauthlib/oauthlib/oauth2/rfc6749/grant_types/resource_owner_password_credentials.pyi';
  await mkdir(path.dirname(path.join(source, deepPath)), { recursive: true });
  await writeFile(path.join(source, deepPath), 'runtime type library');
  await writeFile(path.join(source, '中文 file.txt'), 'Unicode filename and contents');
  const events = [];
  const packager = {
    config: { nsis: configuration.nsis },
    compression: 'normal',
    appInfo: { sanitizedName: 'varin-archive-test', version: '1.0.0' },
    info: { metadata: {}, emitArtifactBuildCompleted: async (event) => events.push(event) },
  };
  const target = new NsisTarget(packager, root, 'nsis', { refCount: 0 });
  const result = await target.buildAppPackage(source, 1);
  return { target, result, packager, events, deepPath };
}

test('the installer retains 7z compression and differential blockmaps', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-nsis-archive-'));
  try {
    const { target, result, packager, events } = await buildArchive(root);
    assert.equal(target.isBuildDifferentialAware, true);
    assert.equal(path.extname(result.path), '.7z');
    assert.equal((await readFile(result.path)).subarray(0, 6).toString('hex'), '377abcaf271c');
    const unpacked = path.join(root, 'unpacked');
    await exec(await getPath7za(), ['x', '-y', `-o${unpacked}`, result.path], { windowsHide: true });
    assert.equal(await readFile(path.join(unpacked, '中文 file.txt'), 'utf8'), 'Unicode filename and contents');
    await createBlockmap(result.path, target, packager, null);
    assert.equal(events.length, 1);
    const map = JSON.parse(gunzipSync(await readFile(`${result.path}.blockmap`)));
    assert.equal(map.files.reduce((sum, file) => sum + file.sizes.reduce((a, b) => a + b, 0), 0), result.size);
    assert(events[0].updateInfo.sha512);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the actual NSIS extraction hook preserves long Unicode paths and rejects corrupt payloads', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-nsis-extract-'));
  try {
    const { result, deepPath } = await buildArchive(root);
    const tools = await require('./prepare-installer-tool.cjs').prepare(path.join(root, 'project'));
    const compiler = await getMakeNsisPath();
    const destination = path.join(root, '安装目录 with spaces', 'nested-parent', 'Varin');
    assert(path.join(destination, deepPath).length > 260);
    const run = async (archive, name) => {
      const script = path.join(root, `${name}.nsi`);
      const program = path.join(root, `${name}.exe`);
      await writeFile(script, '\uFEFF' + [
        'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent', 'SetCompress off',
        'Name "Varin extraction regression"', `OutFile "${nsisPath(program)}"`,
        '!include "LogicLib.nsh"', 'LangString decompressionFailed 1033 "Payload extraction failed"',
        `!define VARIN_INSTALLER_7ZA "${nsisPath(path.join(tools, '7za.exe'))}"`,
        `!include "${nsisPath(extractorInclude)}"`,
        `!include "${nsisPath(path.join(builderRoot, 'templates/nsis/include/extractAppPackage.nsh'))}"`,
        'Section', `SetOutPath "${nsisPath(destination)}"`,
        `!insertmacro extractUsing7za "${nsisPath(archive)}"`, 'SetErrorLevel 0', 'SectionEnd', '',
      ].join('\n'));
      await exec(compiler.path, ['/V2', script], { env: { ...process.env, ...compiler.env }, windowsHide: true });
      return exec(program, [], { windowsHide: true, timeout: 30_000 });
    };
    await run(result.path, 'valid');
    assert.equal(await readFile(path.join(destination, deepPath), 'utf8'), 'runtime type library');
    assert.equal(await readFile(path.join(destination, '中文 file.txt'), 'utf8'), 'Unicode filename and contents');
    const invalid = path.join(root, 'corrupt.7z');
    await writeFile(invalid, 'not a 7z archive');
    await assert.rejects(run(invalid, 'invalid'), (error) => error.code === 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
