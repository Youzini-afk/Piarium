import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(scriptDir, '..');
const distDir = path.join(webDir, 'dist');

const walk = async (directory) => {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(absolute));
    else result.push(absolute);
  }
  return result;
};

const normalize = (value) => String(value).replace(/\\/g, '/');
const files = await walk(distDir);
const sourceMaps = new Map();
const allSources = [];

for (const file of files.filter((entry) => entry.endsWith('.js.map'))) {
  const map = JSON.parse(await fs.readFile(file, 'utf8'));
  const sources = Array.isArray(map.sources) ? map.sources.map(normalize) : [];
  sourceMaps.set(normalize(file.slice(0, -4)), sources);
  allSources.push(...sources);
}

const forbiddenSources = allSources.filter((source) => (
  /monaco-editor\/esm\/vs\/index\.js$/.test(source)
  || /monaco-editor\/esm\/vs\/editor\/editor\.main\.js$/.test(source)
  || /monaco-editor\/esm\/vs\/languages\/features\//.test(source)
  || /monaco-editor\/esm\/vs\/language\/(typescript|json|css|html)\//.test(source)
));
if (forbiddenSources.length > 0) {
  throw new Error(`Forbidden Monaco language/root modules reached the bundle:\n${forbiddenSources.join('\n')}`);
}

const requiredSourcePatterns = [
  /monaco-editor\/esm\/vs\/editor\/editor\.api\.js$/,
  /monaco-editor\/esm\/vs\/editor\/contrib\/find\//,
  /monaco-editor\/esm\/vs\/editor\/editor\.worker\.js$/,
  /monaco-editor\/esm\/vs\/languages\/definitions\/typescript\/register\.js$/,
];
for (const pattern of requiredSourcePatterns) {
  if (!allSources.some((source) => pattern.test(source))) {
    throw new Error(`Monaco smoke bundle is missing expected source ${pattern}.`);
  }
}

for (const semanticWorker of ['ts.worker', 'json.worker', 'css.worker', 'html.worker']) {
  if (files.some((file) => path.basename(file).includes(semanticWorker))) {
    throw new Error(`Monaco semantic worker was emitted unexpectedly: ${semanticWorker}`);
  }
}

const entryAssetReferences = (html) => [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)]
  .map((match) => match[1]);

const entrypointAssets = {};
for (const htmlName of ['index.html', 'mobile.html', 'mini-chat.html']) {
  const htmlPath = path.join(distDir, htmlName);
  const html = await fs.readFile(htmlPath, 'utf8');
  const assets = [];
  for (const reference of entryAssetReferences(html)) {
    const absolute = normalize(path.join(distDir, reference.replace(/^\//, '')));
    const sources = reference.endsWith('.js') ? (sourceMaps.get(absolute) ?? []) : [];
    const containsMonaco = sources.some((source) => source.includes('/monaco-editor/'));
    assets.push({
      asset: normalize(path.relative(distDir, absolute)),
      bytes: (await fs.stat(absolute)).size,
      containsMonaco,
    });
    if (containsMonaco) {
      throw new Error(`${htmlName} eagerly references a Monaco chunk: ${reference}`);
    }
  }
  entrypointAssets[htmlName] = assets;
}

const smokeHtml = await fs.readFile(path.join(distDir, 'monaco-smoke.html'), 'utf8');
if (!smokeHtml.includes('assets/') || !files.some((file) => /editor\.worker.*\.js$/.test(path.basename(file)))) {
  throw new Error('Monaco smoke entry or editor worker asset is missing.');
}

const monacoChunks = await Promise.all([...sourceMaps.entries()]
  .filter(([, sources]) => sources.some((source) => source.includes('/monaco-editor/')))
  .map(async ([file, sources]) => ({
    asset: normalize(path.relative(distDir, file)),
    bytes: (await fs.stat(file)).size,
    monacoSourceCount: sources.filter((source) => source.includes('/monaco-editor/')).length,
  })));
const workerAssets = await Promise.all(files
  .filter((file) => /editor\.worker.*\.js$/.test(path.basename(file)))
  .map(async (file) => ({
    asset: normalize(path.relative(distDir, file)),
    bytes: (await fs.stat(file)).size,
  })));

console.log(JSON.stringify({
  entrypointAssets,
  entrypointsWithoutMonaco: Object.keys(entrypointAssets),
  monacoChunks,
  monacoSourceCount: allSources.filter((source) => source.includes('/monaco-editor/')).length,
  semanticWorkers: 0,
  smokeEntry: 'monaco-smoke.html',
  workerAssets,
}, null, 2));
