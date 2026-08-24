import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const installerInclude = await readFile(new URL('../resources/installer.nsh', import.meta.url), 'utf8');

test('the Windows directory page resolves one Piarium child under the selected parent', () => {
  const nsis = packageJson.build?.nsis;
  assert.equal(nsis?.oneClick, false);
  assert.equal(nsis?.allowToChangeInstallationDirectory, false);
  assert.equal(nsis?.include, 'resources/installer.nsh');
  assert.match(installerInclude, /\$\{GetFileName\} "\$INSTDIR" \$1/);
  assert.match(installerInclude, /StrCmp "\$1" "\$\{PIARIUM_INSTALL_DIR_NAME\}"/);
  assert.doesNotMatch(installerInclude, /StrCpy \$1 "\$INSTDIR" 12 -12/);
});
