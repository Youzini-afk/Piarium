import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PIARIUM_DESKTOP_COMMAND_CATALOG,
  PIARIUM_DESKTOP_COMMAND_LIST,
  PIARIUM_DESKTOP_EVENT_CATALOG,
  PIARIUM_DESKTOP_EVENT_LIST,
  isPiariumDesktopCommand,
  isPiariumDesktopEvent,
} from '../src/desktop.js';

test('desktop command catalog is exhaustive, unique, and usable as a runtime guard', () => {
  assert.equal(PIARIUM_DESKTOP_COMMAND_LIST.length, 58);
  assert.equal(new Set(PIARIUM_DESKTOP_COMMAND_LIST).size, PIARIUM_DESKTOP_COMMAND_LIST.length);
  assert.deepEqual([...PIARIUM_DESKTOP_COMMAND_LIST].sort(), Object.keys(PIARIUM_DESKTOP_COMMAND_CATALOG).sort());
  assert.equal(isPiariumDesktopCommand('desktop_get_app_version'), true);
  assert.equal(isPiariumDesktopCommand('desktop_nonexistent'), false);
});

test('desktop event catalog is unique and usable as a runtime guard', () => {
  assert.equal(new Set(PIARIUM_DESKTOP_EVENT_LIST).size, PIARIUM_DESKTOP_EVENT_LIST.length);
  assert.deepEqual([...PIARIUM_DESKTOP_EVENT_LIST].sort(), Object.keys(PIARIUM_DESKTOP_EVENT_CATALOG).sort());
  assert.equal(isPiariumDesktopEvent('piarium:open-session'), true);
  assert.equal(isPiariumDesktopEvent('piarium:unknown'), false);
});
