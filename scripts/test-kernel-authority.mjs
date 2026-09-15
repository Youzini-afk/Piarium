import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--build')) {
  throw new Error('Usage: node scripts/test-kernel-authority.mjs [--build]');
}
const env = { ...process.env, PIARIUM_REQUIRE_RELEASE_KERNEL: '1' };

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    cwd: root, env, stdio: 'inherit', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) {
    throw new Error(`${command} failed (${result.signal ?? result.status ?? 'unknown exit'})`);
  }
}

if (args.includes('--build')) {
  const toolchain = fs.readFileSync(path.join(root, 'kernel/rust-toolchain.toml'), 'utf8');
  const channel = /^channel\s*=\s*"([^"]+)"/m.exec(toolchain)?.[1];
  if (!channel) throw new Error('kernel/rust-toolchain.toml has no pinned channel');
  env.RUSTUP_TOOLCHAIN = channel;
  run('rustup', ['toolchain', 'install', channel, '--profile', 'minimal', '--component', 'rustfmt']);
  run(process.execPath, ['scripts/build-kernel.mjs']);
}

const binary = path.join(root, 'kernel/target/release', process.platform === 'win32' ? 'piarium-kernel.exe' : 'piarium-kernel');
if (!fs.existsSync(binary)) {
  throw new Error('Native kernel acceptance cannot skip a missing binary. Run bun run kernel:build or pass --build.');
}
run(process.execPath, ['scripts/generate-kernel-protocol.mjs', '--check']);
// These suites use different test runners. Do not count node:test registrations
// as Vitest suites, or call a missing release executable a successful smoke.
run(process.execPath, ['--import', 'tsx', '--test',
  'packages/web/application-host/lib/kernel/kernel-client.test.ts',
]);
run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run',
  'packages/web/application-host/lib/kernel/file-resource-audit.test.ts',
  'packages/web/application-host/lib/kernel/kernel-compute.test.ts',
  'packages/web/application-host/lib/kernel/request-window.test.ts',
  'packages/web/application-host/lib/kernel/kernel-transport.acceptance.test.ts',
  'packages/web/application-host/lib/kernel/kernel-process.test.ts',
  'packages/web/application-host/lib/kernel/process-consumers.test.ts',
  'packages/web/application-host/lib/kernel/storage-adapter.test.ts',
  'packages/web/application-host/lib/recovery/kernel-durable-engine.test.ts',
]);
