const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const iconName = 'AppIcon';
const iconsDir = path.join(__dirname, '..', 'resources', 'icons');
const sourceIconPath = path.join(iconsDir, `${iconName}.icon`);
const outputAssetsPath = path.join(iconsDir, 'Assets.car');

const resolveActool = () => {
  try {
    return execFileSync('xcrun', ['--find', 'actool'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    const xcodeActool = '/Applications/Xcode.app/Contents/Developer/usr/bin/actool';
    if (fs.existsSync(xcodeActool)) return xcodeActool;
    throw new Error('Unable to find actool. Install Xcode or set DEVELOPER_DIR to a full Xcode installation.');
  }
};

if (!fs.existsSync(sourceIconPath)) {
  throw new Error(`Missing Icon Composer source at ${sourceIconPath}`);
}

const actoolPath = resolveActool();
const retryableActoolFailure = /IBPlatformToolFailureException|AssetCatalogAgent|tool closed the connection|model configuration used to open the store is incompatible/i;

for (let attempt = 1; attempt <= 3; attempt += 1) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piarium-app-icon-'));
  try {
    const result = spawnSync(actoolPath, [
      sourceIconPath,
      '--compile', tmpDir,
      '--app-icon', iconName,
      '--platform', 'macosx',
      '--target-device', 'mac',
      '--minimum-deployment-target', '13.0',
      '--output-partial-info-plist', path.join(tmpDir, 'partial.plist'),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;

    if (result.status !== 0) {
      const output = `${result.stdout || ''}\n${result.stderr || ''}`;
      if (attempt < 3 && retryableActoolFailure.test(output)) {
        console.warn(`[electron] actool infrastructure failed on attempt ${attempt}; retrying with a fresh output directory.`);
        continue;
      }
      throw new Error(`actool failed with exit code ${result.status ?? 'unknown'}`);
    }

    const generatedAssetsPath = path.join(tmpDir, 'Assets.car');
    if (!fs.existsSync(generatedAssetsPath)) {
      throw new Error(`actool did not generate Assets.car at ${generatedAssetsPath}`);
    }

    fs.copyFileSync(generatedAssetsPath, outputAssetsPath);
    console.log(`Generated ${outputAssetsPath}`);
    break;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
