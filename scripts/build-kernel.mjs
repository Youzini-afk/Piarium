import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const stageIndex = args.indexOf('--stage');
const stage = stageIndex >= 0 && args[stageIndex + 1]
  ? path.resolve(root, args[stageIndex + 1])
  : null;
const targetIndex = args.indexOf('--target');
const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
const cargoArgs = ['build', '--manifest-path', path.join(root, 'kernel', 'Cargo.toml'), '--release', '--bin', 'piarium-kernel'];
if (target) cargoArgs.push('--target', target);
const result = spawnSync(process.platform === 'win32' ? 'cargo.exe' : 'cargo', cargoArgs, {
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
