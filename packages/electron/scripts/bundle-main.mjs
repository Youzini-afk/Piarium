/**
 * Bundle the TypeScript Electron runtime into deployable ESM files. Small electron-* helper deps are
 * inlined; everything else — including the in-process web server
 * (@piarium/web) and native modules — stays external so it resolves
 * from node_modules at runtime inside the packaged app.
 *
 * Why external matters: packages/web/server pulls in bun-pty, which has
 * a top-level `import { dlopen } from "bun:ffi"`. If we inline it here,
 * Node's ESM loader sees `bun:ffi` at package load time and crashes with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME before any runtime guard can skip it.
 * Leaving @piarium/web external means the conditional
 * `if (isBunRuntime) await import('bun-pty')` stays dynamic and is never
 * reached under Electron.
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outdir = path.join(root, 'dist-bundle');
const updaterE2eBuild = process.env.PIARIUM_UPDATER_E2E_BUILD === '1';

// dist-bundle is generated output. Replace it as one unit so a removed entry
// cannot survive from an older build and later enter a package.
fs.rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [path.join(root, 'main.ts'), path.join(root, 'preload.ts')],
  outdir,
  target: 'node',
  format: 'esm',
  external: [
    'electron',
    '@piarium/web',
    '@piarium/web/*',
    '@piarium/pi-host',
    '@piarium/pi-host/*',
    '@piarium/runtime-broker',
    '@piarium/runtime-broker/*',
    'bun-pty',
    'node-pty',
    'better-sqlite3',
  ],
  minify: false,
  sourcemap: 'none',
  naming: '[name].mjs',
  define: {
    __PIARIUM_UPDATER_E2E_BUILD__: updaterE2eBuild ? 'true' : 'false',
  },
});

if (!result.success) {
  for (const msg of result.logs) console.error(msg);
  process.exit(1);
}

// Verify both entry bundles exist and are accepted by the same Node parser
// used by Electron's main-process runtime.
const expectedEntries = ['main.mjs', 'preload.mjs'];
const nodeExecutable = process.env.PIARIUM_PACKAGING_NODE || 'node';
for (const entry of expectedEntries) {
  const entryPath = path.join(outdir, entry);
  if (!fs.existsSync(entryPath)) {
    console.error(`[electron] bundle output missing: ${entry}`);
    process.exit(1);
  }
  const syntax = spawnSync(nodeExecutable, ['--check', entryPath], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (syntax.status !== 0) {
    console.error(`[electron] bundle output failed Node syntax check: ${entry}`);
    if (syntax.stderr) console.error(syntax.stderr.trim());
    process.exit(1);
  }
}

console.log(`[electron] main.ts + preload.ts bundled -> dist-bundle/*.mjs (updater E2E=${updaterE2eBuild})`);
