#!/usr/bin/env node
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const electronWorkspace = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const MACHO_CPU_TO_ARCH = {
  0x00000007: 'ia32',
  0x01000007: 'x64',
  0x0000000c: 'arm',
  0x0100000c: 'arm64',
};
const ELF_MACHINE_TO_ARCH = { 3: 'ia32', 40: 'arm', 62: 'x64', 183: 'arm64' };
const PE_MACHINE_TO_ARCH = { 0x014c: 'ia32', 0x8664: 'x64', 0xaa64: 'arm64' };

export function platformPath() {
  const platform = process.env.npm_config_platform || process.platform;
  if (platform === 'darwin' || platform === 'mas') return 'Electron.app/Contents/MacOS/Electron';
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return 'electron';
  if (platform === 'win32') return 'electron.exe';
  throw new Error(`Electron builds are not available on platform: ${platform}`);
}

export function expectedArch() {
  const platform = process.env.npm_config_platform || process.platform;
  let arch = process.env.npm_config_arch || process.arch;
  if (platform === 'darwin' && process.platform === 'darwin' && arch === 'x64' && !process.env.npm_config_arch) {
    try {
      if (String(execSync('sysctl -in sysctl.proc_translated', { stdio: ['ignore', 'pipe', 'ignore'] })).trim() === '1') {
        arch = 'arm64';
      }
    } catch {
    }
  }
  return arch;
}

export function detectExecutableArch(executablePath) {
  let fd;
  try {
    fd = fs.openSync(executablePath, 'r');
    const header = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    const data = header.subarray(0, bytesRead);
    if (data.length < 4) return null;

    if (data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46) {
      return data.length >= 20 ? ELF_MACHINE_TO_ARCH[data.readUInt16LE(18)] ?? null : null;
    }
    const magicLE = data.readUInt32LE(0);
    if (magicLE === 0xfeedface || magicLE === 0xfeedfacf) {
      return data.length >= 8 ? MACHO_CPU_TO_ARCH[data.readUInt32LE(4)] ?? null : null;
    }
    const magicBE = data.readUInt32BE(0);
    if (magicBE === 0xcafebabe || magicBE === 0xbebafeca) {
      const count = data.length >= 8 ? data.readUInt32BE(4) : 0;
      for (let index = 0; index < count; index += 1) {
        const offset = 8 + index * 20;
        if (data.length < offset + 4) break;
        const arch = MACHO_CPU_TO_ARCH[data.readUInt32BE(offset)];
        if (arch) return arch;
      }
      return null;
    }
    if (data[0] === 0x4d && data[1] === 0x5a && data.length >= 0x40) {
      const peOffset = data.readUInt32LE(0x3c);
      if (data.length >= peOffset + 6 && data.toString('latin1', peOffset, peOffset + 4) === 'PE\0\0') {
        return PE_MACHINE_TO_ARCH[data.readUInt16LE(peOffset + 4)] ?? null;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const readJson = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

export function resolveElectronPackageDir(baseDir = electronWorkspace) {
  try {
    return path.dirname(require.resolve('electron/package.json', { paths: [baseDir] }));
  } catch {
    for (const candidate of [
      path.resolve(baseDir, 'node_modules/electron'),
      path.resolve(baseDir, '../../node_modules/electron'),
    ]) {
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    }
    return null;
  }
}

export function isComplete(packageDir, targetArch = expectedArch()) {
  const pkg = readJson(path.join(packageDir, 'package.json'));
  if (!pkg?.version) return false;
  try {
    const distVersion = fs.readFileSync(path.join(packageDir, 'dist', 'version'), 'utf8').trim().replace(/^v/, '');
    const executablePath = fs.readFileSync(path.join(packageDir, 'path.txt'), 'utf8').trim();
    if (distVersion !== pkg.version || executablePath !== platformPath()) return false;
    const executable = path.join(packageDir, 'dist', executablePath);
    return fs.existsSync(executable) && detectExecutableArch(executable) === targetArch;
  } catch {
    return false;
  }
}

const installCommands = (env) => {
  if (env.PIARIUM_ELECTRON_INSTALL_COMMANDS) {
    try {
      const commands = JSON.parse(env.PIARIUM_ELECTRON_INSTALL_COMMANDS);
      if (Array.isArray(commands) && commands.every((entry) => Array.isArray(entry) && typeof entry[0] === 'string')) {
        return commands;
      }
    } catch {
    }
  }
  return [['bun', ['install.js']], ['node', ['install.js']]];
};

export function repair(packageDir, options = {}) {
  const env = options.env ?? process.env;
  const runner = options.runner ?? spawnSync;
  const commands = options.commands ?? installCommands(env);
  fs.rmSync(path.join(packageDir, 'dist'), { recursive: true, force: true });
  fs.rmSync(path.join(packageDir, 'path.txt'), { force: true });

  for (const [binary, args] of commands) {
    const childEnv = { ...env };
    delete childEnv.ELECTRON_SKIP_BINARY_DOWNLOAD;
    const result = runner(binary, args, {
      cwd: packageDir,
      env: childEnv,
      stdio: options.stdio ?? 'inherit',
    });
    if (result.error) {
      console.warn(`[electron:ensure] could not run ${binary}: ${result.error.message}`);
      continue;
    }
    if (result.status === 0 && isComplete(packageDir)) {
      console.log(`[electron:ensure] repaired Electron at ${packageDir}`);
      return true;
    }
  }
  return false;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const bestEffort = argv.includes('--best-effort');
  const packageDir = env.PIARIUM_ELECTRON_PKG_DIR
    ? (fs.existsSync(path.join(env.PIARIUM_ELECTRON_PKG_DIR, 'package.json')) ? env.PIARIUM_ELECTRON_PKG_DIR : null)
    : resolveElectronPackageDir();
  if (!packageDir) {
    console.warn('[electron:ensure] could not locate the installed Electron package');
    return bestEffort ? 0 : 1;
  }
  if (isComplete(packageDir)) return 0;
  if (env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    console.warn('[electron:ensure] Electron binary is missing and binary downloads are disabled');
    return bestEffort ? 0 : 1;
  }
  console.warn(`[electron:ensure] Electron install at ${packageDir} is incomplete; repairing it`);
  if (repair(packageDir, { env })) return 0;
  console.error('[electron:ensure] Electron remains incomplete; rerun with network access');
  return bestEffort ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
