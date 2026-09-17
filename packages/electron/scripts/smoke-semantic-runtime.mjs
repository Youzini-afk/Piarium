import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const webRoot = path.resolve(process.argv[2]);
const entry = path.join(webRoot, 'server/lib/knowledge/semantic/minilm.js');
const { createLocalMinilmEmbedder } = await import(pathToFileURL(entry).href);
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piarium-native-semantic-'));
try {
  const embedder = createLocalMinilmEmbedder({ dataDir });
  assert.equal(embedder.status, 'ready', 'The packaged MiniLM model must be available without downloading');
  await embedder.prepare();
  const vectors = await embedder.embed(['Piarium native semantic runtime verification']);
  assert.equal(vectors.length, 1);
  assert.equal(vectors[0].length, embedder.space.dim);
  assert.ok(vectors[0].every(Number.isFinite));
  assert.ok(vectors[0].some((value) => value !== 0));
  console.log(`[electron] MiniLM inference passed on ${process.platform}/${process.arch}: ${vectors[0].length} dimensions`);
} finally {
  await fs.rm(dataDir, { recursive: true, force: true });
}
