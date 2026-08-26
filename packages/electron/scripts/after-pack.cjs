const fs = require('node:fs');
const path = require('node:path');

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
    path.join('node_modules', '@piarium', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'piarium.extension.json'),
    path.join('node_modules', '@piarium', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'host.cjs'),
    path.join('node_modules', '@piarium', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'runtime', 'typescript-language-server.mjs'),
    path.join('node_modules', '@piarium', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'runtime', 'typescript', 'package.json'),
    path.join('node_modules', '@piarium', 'extension-builtins', 'dist', 'builtin-packages', 'typescript-language', 'runtime', 'typescript', 'lib', 'tsserver.js'),
  ];
  for (const relativePath of requiredApplicationHostFiles) {
    const packagedPath = path.join(resourcesPath, 'app.asar.unpacked', relativePath);
    if (!fs.existsSync(packagedPath)) {
      throw new Error(`Missing unpacked application-host runtime file at ${packagedPath}`);
    }
  }

  if (context.electronPlatformName !== 'darwin') return;

  const sourceAssetsPath = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');

  if (!fs.existsSync(sourceAssetsPath)) {
    throw new Error(`Missing compiled app icon asset catalog at ${sourceAssetsPath}`);
  }

  fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));
};
