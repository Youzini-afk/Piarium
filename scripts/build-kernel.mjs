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
const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
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
  ? ['/d', '/s', '/c', `call ${windowsQuote(vsDevCmd)} -arch=x64 -host_arch=x64 && cargo.exe ${cargoArgs.map(windowsQuote).join(' ')}`]
  : cargoArgs;
const result = useWindowsEnvironment
  ? spawnSync(commandArgs[3], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    shell: true,
  })
  : spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
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
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ schema: 1, executable, target: target ?? `${process.platform}-${process.arch}`, sha256: digest }, null, 2) + '\n');
console.log(`Staged ${executable} (${digest}) at ${path.relative(root, stage)}`);
