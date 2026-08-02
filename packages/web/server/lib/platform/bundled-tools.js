import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const resolveRipgrepPackageJsonCandidates = () => {
  const packageNames = ['@vscode/ripgrep', 'ripgrep'];
  const candidates = [];
  for (const packageName of packageNames) {
    try {
      candidates.push(require.resolve(`${packageName}/package.json`));
    } catch {
      // Try the next bundled package candidate.
    }
  }

  return candidates;
};

const getBinaryNames = (platform = process.platform) => (
  platform === 'win32'
    ? ['rg.exe', 'rg.cmd', 'rg.bat', 'rg.ps1', 'rg']
    : ['rg']
);

const resolveNodeModulesBinDir = (packageRoot) => {
  let current = packageRoot;
  while (current && current !== path.dirname(current)) {
    if (path.basename(current) === 'node_modules') {
      return path.join(current, '.bin');
    }
    current = path.dirname(current);
  }

  return null;
};

const readPackageJson = (packageJsonPath) => {
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return null;
  }
};

const isExecutableFile = (filePath, platform = process.platform) => {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === 'win32') return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const resolveBundledRipgrepBinDir = ({
  packageJsonPath = resolveRipgrepPackageJsonCandidates()[0],
  platform = process.platform,
} = {}) => {
  if (typeof packageJsonPath !== 'string' || packageJsonPath.trim().length === 0) {
    return null;
  }

  const packageRoot = path.dirname(packageJsonPath);
  const packageJson = readPackageJson(packageJsonPath);
  const binaryNames = getBinaryNames(platform);
  const nodeModulesBinDir = packageJson?.bin ? resolveNodeModulesBinDir(packageRoot) : null;
  const packageBinTargets = packageJson?.bin && typeof packageJson.bin === 'object'
    ? Object.values(packageJson.bin)
    : typeof packageJson?.bin === 'string'
      ? [packageJson.bin]
      : [];
  const candidateDirs = [
    nodeModulesBinDir,
    path.join(packageRoot, 'bin'),
    packageRoot,
    ...packageBinTargets
      .map((target) => path.resolve(packageRoot, String(target)))
      .filter((target) => binaryNames.includes(path.basename(target)))
      .map((target) => path.dirname(target)),
  ].filter(Boolean);

  for (const candidateDir of candidateDirs) {
    for (const binaryName of binaryNames) {
      const candidate = path.join(candidateDir, binaryName);
      if (isExecutableFile(candidate, platform)) {
        return candidateDir;
      }
    }
  }

  return null;
};

export const augmentPathWithBundledRipgrep = ({
  env = process.env,
  resolvePackageJson = resolveRipgrepPackageJsonCandidates,
  platform = process.platform,
  delimiter = path.delimiter,
} = {}) => {
  const packageJsonPaths = [resolvePackageJson()].flat().filter(Boolean);
  const binDir = packageJsonPaths
    .map((packageJsonPath) => resolveBundledRipgrepBinDir({ packageJsonPath, platform }))
    .find(Boolean) || null;

  if (!binDir) {
    return { added: false, binDir: null };
  }

  const currentPath = typeof env.PATH === 'string' ? env.PATH : '';
  const parts = currentPath.split(delimiter).filter(Boolean);
  const nextParts = [binDir, ...parts.filter((part) => part !== binDir)];
  const nextPath = nextParts.join(delimiter);
  const added = nextPath !== currentPath;
  env.PATH = nextPath;

  return { added, binDir };
};
