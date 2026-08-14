import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, '..', 'extension-host', 'broker', 'broker-child.mjs');
const target = resolve(root, 'dist', 'broker-child.mjs');

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
