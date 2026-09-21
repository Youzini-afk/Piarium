import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPiariumDesktopCommand,
  isPiariumDesktopEvent,
} from '../src/desktop.js';

test('desktop command guard accepts known commands and rejects unknown commands', () => {
  assert.equal(isPiariumDesktopCommand('desktop_get_app_version'), true);
  assert.equal(isPiariumDesktopCommand('desktop_nonexistent'), false);
});

test('desktop event guard accepts known events and rejects unknown events', () => {
  assert.equal(isPiariumDesktopEvent('piarium:open-session'), true);
  assert.equal(isPiariumDesktopEvent('piarium:unknown'), false);
});
