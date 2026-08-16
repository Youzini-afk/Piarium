const fs = require('node:fs');
const path = require('node:path');

module.exports = (context) => {
  const resourcesPath = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const betterSqliteDir = path.dirname(require.resolve('better-sqlite3/package.json'));
  const targetArchitecture = process.env.PIARIUM_TARGET_ARCH || process.arch;
  const betterSqlitePrebuildName = `${context.electronPlatformName}-${targetArchitecture}.node`;
  const betterSqliteBinary = path.join(betterSqliteDir, 'prebuilds', betterSqlitePrebuildName);
  if (!fs.existsSync(betterSqliteBinary)) {
    throw new Error(`Missing better-sqlite3 prebuild at ${betterSqliteBinary}`);
  }
  const packagedBetterSqliteBinary = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'prebuilds',
    betterSqlitePrebuildName,
  );
  fs.mkdirSync(path.dirname(packagedBetterSqliteBinary), { recursive: true });
  fs.copyFileSync(betterSqliteBinary, packagedBetterSqliteBinary);

  const requiredPiRuntimeFiles = [
    path.join('node_modules', '@piarium', 'pi-host', 'dist', 'main.js'),
    path.join('node_modules', '@piarium', 'runtime-broker', 'dist', 'index.js'),
  ];
  for (const relativePath of requiredPiRuntimeFiles) {
    const packagedPath = path.join(resourcesPath, 'app.asar.unpacked', relativePath);
    if (!fs.existsSync(packagedPath)) {
      throw new Error(`Missing packaged Pi runtime file at ${packagedPath}`);
    }
  }

  if (context.electronPlatformName !== 'darwin') return;

  const sourceAssetsPath = path.join(__dirname, '..', 'resources', 'icons', 'Assets.car');

  if (!fs.existsSync(sourceAssetsPath)) {
    throw new Error(`Missing compiled app icon asset catalog at ${sourceAssetsPath}`);
  }

  fs.copyFileSync(sourceAssetsPath, path.join(resourcesPath, 'Assets.car'));
};
