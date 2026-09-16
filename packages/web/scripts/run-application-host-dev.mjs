#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const webRoot = path.resolve(import.meta.dirname, '..');
const generationName = `.application-host-dev-${process.pid}`;
const generationDir = path.join(webRoot, generationName);
const buildScript = path.join(import.meta.dirname, 'build-application-host.mjs');

const removeGeneration = () => {
  try {
    fs.rmSync(generationDir, { recursive: true, force: true });
  } catch {
    // A terminating Windows process can briefly retain loaded assets. The next
    // clean/build pass also removes abandoned development generations.
  }
};

removeGeneration();
process.once('exit', removeGeneration);

const build = spawnSync(process.execPath, [buildScript, '--dev-output', generationName], {
  cwd: webRoot,
  env: process.env,
  stdio: 'inherit',
  shell: false,
});

if (build.error) {
  throw build.error;
}
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const entrypoint = path.join(generationDir, 'index.js');
// The Application Host deliberately starts only when its entrypoint is the
// executed module. Point argv at this private generation before importing it.
process.argv[1] = entrypoint;
await import(pathToFileURL(entrypoint).href);
