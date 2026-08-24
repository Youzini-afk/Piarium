import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('the Windows directory page uses the selected path as the final install root', () => {
  const nsis = packageJson.build?.nsis;
  assert.equal(nsis?.oneClick, false);
  assert.equal(nsis?.allowToChangeInstallationDirectory, true);
  assert.equal(nsis?.include, undefined);
});
