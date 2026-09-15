import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// VS Code ships a CJS extension; its tests need an ESM entry to import the
// shared Host's ESM-only packages. Do not change the extension's package type.
const directory = await mkdtemp(path.join(root, '.native-search-tests-'));
try {
  const outfile = path.join(directory, 'search-runtime.test.mjs');
  await build({
    entryPoints: [path.join(root, 'src/search-runtime.test.ts')],
    outfile, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22',
  });
  execFileSync(process.execPath, ['--test', outfile], { cwd: root, stdio: 'inherit', windowsHide: true, timeout: 60000 });
} finally { await rm(directory, { recursive: true, force: true }); }
