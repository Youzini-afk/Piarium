import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const stageIndex = args.indexOf('--stage');
const stage = stageIndex >= 0 && args[stageIndex + 1]
  ? path.resolve(process.cwd(), args[stageIndex + 1])
  : null;
const targetIndex = args.indexOf('--target');
const target = targetIndex >= 0 ? args[targetIndex + 1] : (process.env.PIARIUM_TARGET_TRIPLE || undefined);
const platformIndex = args.indexOf('--platform');
const platform = platformIndex >= 0 ? args[platformIndex + 1] : (process.env.PIARIUM_TARGET_PLATFORM || process.platform);
const archIndex = args.indexOf('--arch');
const arch = archIndex >= 0 ? args[archIndex + 1] : (process.env.PIARIUM_TARGET_ARCH || process.arch);
const identityIndex = args.indexOf('--build-identity');
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const buildIdentity = identityIndex >= 0 ? args[identityIndex + 1] : (process.env.PIARIUM_KERNEL_BUILD_IDENTITY || packageVersion);
if (!buildIdentity?.trim()) throw new Error('kernel build identity is required');
const defaultTargetTriple = (platformName, architecture) => {
  if (platformName === 'win32' && architecture === 'x64') return 'x86_64-pc-windows-msvc';
  if (platformName === 'win32' && architecture === 'arm64') return 'aarch64-pc-windows-msvc';
  if (platformName === 'linux' && architecture === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platformName === 'linux' && architecture === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (platformName === 'darwin' && architecture === 'x64') return 'x86_64-apple-darwin';
  if (platformName === 'darwin' && architecture === 'arm64') return 'aarch64-apple-darwin';
  return `${platformName}-${architecture}`;
};
const targetTriple = target ?? defaultTargetTriple(platform, arch);
const cargoArgs = ['build', '--manifest-path', path.join(root, 'kernel', 'Cargo.toml'), '--release', '--bin', 'piarium-kernel', '--locked'];
if (target) cargoArgs.push('--target', target);
const windowsQuote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const locateVsDevCmd = () => {
  if (process.platform !== 'win32' || process.env.INCLUDE) return null;
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
    .filter(Boolean)
    .flatMap((base) => [
      path.join(base, 'Microsoft Visual Studio', '2022', 'BuildTools', 'Common7', 'Tools', 'VsDevCmd.bat'),
      path.join(base, 'Microsoft Visual Studio', '2022', 'Community', 'Common7', 'Tools', 'VsDevCmd.bat'),
      path.join(base, 'Microsoft Visual Studio', '2022', 'Professional', 'Common7', 'Tools', 'VsDevCmd.bat'),
      path.join(base, 'Microsoft Visual Studio', '2022', 'Enterprise', 'Common7', 'Tools', 'VsDevCmd.bat'),
    ]);
  return roots.find((candidate) => fs.existsSync(candidate)) ?? null;
};
const vsDevCmd = locateVsDevCmd();
const useWindowsEnvironment = process.platform === 'win32' && vsDevCmd;
const command = useWindowsEnvironment ? 'cmd.exe' : (process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const commandArgs = useWindowsEnvironment
  ? ['/d', '/s', '/c', `set "PIARIUM_KERNEL_BUILD_IDENTITY=${buildIdentity.replaceAll('"', '')}" && set "PIARIUM_KERNEL_TARGET=${targetTriple.replaceAll('"', '')}" && set "PIARIUM_KERNEL_ARCH=${arch.replaceAll('"', '')}" && call ${windowsQuote(vsDevCmd)} -arch=x64 -host_arch=x64 && cargo.exe ${cargoArgs.map(windowsQuote).join(' ')}`]
  : cargoArgs;
const result = useWindowsEnvironment
  ? spawnSync(commandArgs[3], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, PIARIUM_KERNEL_BUILD_IDENTITY: buildIdentity, PIARIUM_KERNEL_TARGET: targetTriple, PIARIUM_KERNEL_ARCH: arch },
    shell: true,
  })
  : spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, PIARIUM_KERNEL_BUILD_IDENTITY: buildIdentity, PIARIUM_KERNEL_TARGET: targetTriple, PIARIUM_KERNEL_ARCH: arch },
  });
if (result.status !== 0) process.exit(result.status ?? 1);
if (!stage) {
  console.log('Built Piarium kernel without staging.');
  process.exit(0);
}
const executable = process.platform === 'win32' ? 'piarium-kernel.exe' : 'piarium-kernel';
const source = path.join(root, 'kernel', 'target', ...(target ? [target] : []), 'release', executable);
if (!fs.existsSync(source)) throw new Error(`Rust kernel build did not produce ${source}`);
fs.mkdirSync(stage, { recursive: true });
const destination = path.join(stage, executable);
fs.copyFileSync(source, destination);
if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
const digest = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({
  schema: 2,
  executable,
  targetTriple,
  platform,
  arch,
  buildIdentity,
  protocolVersion: 1,
  kernelVersion: '0.1.0',
  sha256: digest,
}, null, 2) + '\n');
console.log(`Staged ${executable} (${digest}) at ${path.relative(root, stage)}`);
