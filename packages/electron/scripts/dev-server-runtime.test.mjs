import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const webPackagePath = new URL('../../web/package.json', import.meta.url);

test('runs the long-lived development API on Node and propagates crashes', async () => {
  const pkg = JSON.parse(await readFile(webPackagePath, 'utf8'));
  const direct = String(pkg.scripts?.['dev:server'] || '');
  const watched = String(pkg.scripts?.['dev:server:watch'] || '');

  assert.match(direct, /(?:^|&&\s*)node server\/index\.js(?:\s|$)/);
  assert.doesNotMatch(direct, /bun server\/index\.js/);
  assert.match(watched, /nodemon\s+--exitcrash\b/);
  assert.match(watched, /--exec\s+"node server\/index\.js"/);
  assert.doesNotMatch(watched, /bun server\/index\.js/);
});
