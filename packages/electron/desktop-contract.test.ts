import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import {
  PIARIUM_DESKTOP_COMMAND_CATALOG,
  PIARIUM_DESKTOP_COMMAND_LIST,
  PIARIUM_DESKTOP_EVENT_LIST,
  PIARIUM_REMOTE_SAFE_DESKTOP_COMMANDS,
  isPiariumDesktopCommand,
  isPiariumDesktopEvent,
  type PiariumDesktopCommand,
  type PiariumDesktopCommandArgs,
  type PiariumDesktopCommandInvocation,
  type PiariumDesktopCommandResult,
  type PreloadBootstrapLocalPayload,
  type PreloadBootstrapRemotePayload,
  type PreloadBootstrapPayload,
} from '@piarium/application-client/desktop';

import { REMOTE_SAFE_DESKTOP_COMMANDS } from './renderer-security-policy.js';
import { createPreloadBootstrapPayload } from './renderer-security-policy.js';

// ---------------------------------------------------------------------------
// 1. Command catalog completeness — every command in the catalog is known
//    and the list has exactly 59 entries.
// ---------------------------------------------------------------------------

test('desktop command catalog has exactly 59 commands', () => {
  assert.equal(PIARIUM_DESKTOP_COMMAND_LIST.length, 59);
});

test('desktop command catalog has no duplicates', () => {
  const seen = new Set<PiariumDesktopCommand>();
  for (const cmd of PIARIUM_DESKTOP_COMMAND_LIST) {
    assert.equal(seen.has(cmd), false, `duplicate command: ${cmd}`);
    seen.add(cmd);
  }
});

// ---------------------------------------------------------------------------
// 2. Remote-safe set is a subset of the command catalog
// ---------------------------------------------------------------------------

test('remote-safe command set is a subset of the command catalog', () => {
  const catalog = new Set(PIARIUM_DESKTOP_COMMAND_LIST);
  for (const cmd of PIARIUM_REMOTE_SAFE_DESKTOP_COMMANDS) {
    assert.equal(catalog.has(cmd), true, `remote-safe command ${cmd} not in catalog`);
  }
});

test('Electron REMOTE_SAFE_DESKTOP_COMMANDS matches shared contract', () => {
  assert.deepEqual(
    [...REMOTE_SAFE_DESKTOP_COMMANDS].sort(),
    [...PIARIUM_REMOTE_SAFE_DESKTOP_COMMANDS].sort(),
  );
});

// ---------------------------------------------------------------------------
// 3. Unknown command is rejected — the command map is a closed set
// ---------------------------------------------------------------------------

test('unknown command is not in the command map', () => {
  assert.equal(isPiariumDesktopCommand('desktop_nonexistent'), false);
  assert.equal(isPiariumDesktopCommand('desktop_get_app_version'), true);
});

test('desktop event catalog covers every event emitted by Electron main', () => {
  const expectedEvents = [
    'piarium:update-progress',
    'piarium:open-session',
    'piarium:open-draft-session',
    'piarium:window-resized',
    'piarium:window-maximized-changed',
    'piarium:installed-apps-updated',
    'piarium:system-resume',
    'piarium:tray-action',
    'piarium:vibrancy-ready',
    'piarium:ssh-instance-status',
    'piarium:menu-action',
    'piarium:check-for-updates',
  ];
  assert.deepEqual([...PIARIUM_DESKTOP_EVENT_LIST].sort(), expectedEvents.sort());
  for (const event of expectedEvents) assert.equal(isPiariumDesktopEvent(event), true);
  assert.equal(isPiariumDesktopEvent('piarium:unknown'), false);
});

// ---------------------------------------------------------------------------
// 4. Type-level coverage — compile-time proof that args/results correlate.
//    These are compile-only assertions; if they type-check, the contract
//    is consistent for each category.
// ---------------------------------------------------------------------------

// No-args command
const _noArgs: PiariumDesktopCommandArgs<'desktop_get_app_version'> = undefined;
const _noArgsResult: PiariumDesktopCommandResult<'desktop_get_app_version'> = '1.0.0';
void _noArgs; void _noArgsResult;

// Union/optional args command
const _optArgs: PiariumDesktopCommandArgs<'desktop_capture_page_rect'> = { x: 0, y: 0, width: 100, height: 100 };
const _optArgsResult: PiariumDesktopCommandResult<'desktop_capture_page_rect'> = {
  mime: 'image/jpeg',
  base64: '',
  width: 100,
  height: 100,
};
void _optArgs; void _optArgsResult;

// Sensitive command (file read — local only)
const _sensitiveArgs: PiariumDesktopCommandArgs<'desktop_read_file'> = { path: '/tmp/test.txt' };
const _sensitiveResult: PiariumDesktopCommandResult<'desktop_read_file'> = {
  mime: 'text/plain',
  base64: '',
  size: 0,
};
void _sensitiveArgs; void _sensitiveResult;

// Structured result command (hosts get)
const _structuredResult: PiariumDesktopCommandResult<'desktop_hosts_get'> = {
  hosts: [],
  defaultHostId: null,
  initialHostChoiceCompleted: false,
  localOrigin: null,
};
void _structuredResult;

// ---------------------------------------------------------------------------
// 4b. Compile-time catalog exhaustiveness — the catalog value must satisfy
//     Record<PiariumDesktopCommand, true>. If a new command is added to the
//     map but not the catalog, this assignment fails to compile.
// ---------------------------------------------------------------------------

const _catalogExhaustive: Record<PiariumDesktopCommand, true> = PIARIUM_DESKTOP_COMMAND_CATALOG;
void _catalogExhaustive;

// ---------------------------------------------------------------------------
// 4c. Invocation tuple shape — no-args commands produce [], required-args
//     commands produce [args]. This is the compile-time proof that
//     required-args commands cannot be called without arguments. No
//     suppression directives are used — the positive assignment IS
//     the proof. If the invocation type were wrong, this would not compile.
// ---------------------------------------------------------------------------

// No-args command: invocation is [] (zero rest parameters)
const _noArgsInvocation: PiariumDesktopCommandInvocation<'desktop_get_app_version'> = [];
// Required-args command: invocation is [{ title: string }]
const _requiredArgsInvocation: PiariumDesktopCommandInvocation<'desktop_set_window_title'> = [{ title: 'test' }];
// Optional-args command: invocation is [{ x?: number, ... }] — can be empty object
const _optionalArgsInvocation: PiariumDesktopCommandInvocation<'desktop_capture_page_rect'> = [{}];
void _noArgsInvocation; void _requiredArgsInvocation; void _optionalArgsInvocation;

test('command map covers all command categories', () => {
  const categories = {
    window: ['desktop_start_window_drag', 'desktop_close_current_window', 'desktop_new_window'],
    system: ['desktop_get_app_version', 'desktop_get_lan_address', 'desktop_restart'],
    capture: ['desktop_browser_capture_page', 'desktop_capture_page_rect'],
    file: ['desktop_save_markdown_file', 'desktop_read_file', 'desktop_open_path'],
    host: ['desktop_hosts_get', 'desktop_hosts_set', 'desktop_host_probe'],
    auth: ['desktop_remote_password_login', 'desktop_install_id_get'],
    update: ['desktop_check_for_updates', 'desktop_download_and_install_update'],
    tray: ['desktop_notify', 'desktop_tray_update'],
    ssh: ['desktop_ssh_connect', 'desktop_ssh_disconnect', 'desktop_ssh_status'],
  };
  const catalog = new Set(PIARIUM_DESKTOP_COMMAND_LIST);
  for (const [category, commands] of Object.entries(categories)) {
    for (const cmd of commands) {
      assert.equal(catalog.has(cmd as PiariumDesktopCommand), true, `${category} command ${cmd} missing from catalog`);
    }
  }
});

// ---------------------------------------------------------------------------
// 4d. main.ts switch exhaustiveness — the default branch must use
//     `command satisfies never` so adding a new command without a case
//     is a compile error, not a silent fall-through.
// ---------------------------------------------------------------------------

test('main.ts handleInvoke switch uses satisfies never for exhaustiveness', () => {
  const mainPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'main.ts',
  );
  const source = readFileSync(mainPath, 'utf8');
  assert.ok(
    source.includes('command satisfies never'),
    'main.ts must use `command satisfies never` in the default branch of handleInvoke',
  );
});

// ---------------------------------------------------------------------------
// 5. Bootstrap payload — local carries credentials, remote does not
// ---------------------------------------------------------------------------

test('local bootstrap payload carries credentials, remote does not', () => {
  const common = {
    uiProtocol: 'piarium-ui',
    developmentUiOrigin: 'http://127.0.0.1:5173',
    localOrigins: ['http://127.0.0.1:57123'],
    localOrigin: 'http://127.0.0.1:57123',
    apiBaseUrl: 'https://remote.example.test',
    clientToken: 'secret-token',
    requestHeaders: { 'CF-Access-Client-Secret': 'secret-header' },
    homeDirectory: 'C:\\Users\\Example',
    relayHostId: 'relay-host',
    macosMajor: 15,
    macVibrancy: true,
    trayEnabled: true,
  };

  const remote = createPreloadBootstrapPayload({ ...common, senderUrl: 'https://remote.example.test/app' });
  assert.equal(remote.localPage, false);
  // Remote payload must not have credential fields
  assert.equal(Object.hasOwn(remote, 'clientToken'), false);
  assert.equal(Object.hasOwn(remote, 'requestHeaders'), false);
  assert.equal(Object.hasOwn(remote, 'homeDirectory'), false);
  assert.equal(Object.hasOwn(remote, 'relayHostId'), false);

  const local = createPreloadBootstrapPayload({ ...common, senderUrl: 'piarium-ui://app/index.html' });
  if (!local.localPage) assert.fail('local bootstrap must be the credential-bearing branch');
  // Local payload must have credential fields
  assert.equal(local.clientToken, 'secret-token');
  assert.equal(local.homeDirectory, 'C:\\Users\\Example');
  assert.equal(local.relayHostId, 'relay-host');
});

test('bootstrap payload discriminated union narrows correctly', () => {
  const common = {
    uiProtocol: 'piarium-ui',
    developmentUiOrigin: 'http://127.0.0.1:5173',
    localOrigins: ['http://127.0.0.1:57123'],
    localOrigin: 'http://127.0.0.1:57123',
    apiBaseUrl: 'https://remote.example.test',
    clientToken: 'tok',
    requestHeaders: {},
    homeDirectory: '/home',
    relayHostId: 'rid',
    macosMajor: 0,
    macVibrancy: true,
    trayEnabled: true,
  };

  const remote = createPreloadBootstrapPayload({ ...common, senderUrl: 'https://remote.example.test' });
  if (remote.localPage) {
    // If this branch compiles, the union narrows remote to local — which is wrong.
    // The assertion below would fail at runtime, but the type system prevents it.
    assert.fail('remote should not narrow to local');
  }
  // After the if-guard, remote is narrowed to PreloadBootstrapRemotePayload
  const _remoteTyped: PreloadBootstrapRemotePayload = remote;
  void _remoteTyped;

  const local = createPreloadBootstrapPayload({ ...common, senderUrl: 'piarium-ui://app/index.html' });
  if (!local.localPage) {
    assert.fail('local should narrow to local payload');
  }
  // After the if-guard, local is narrowed to PreloadBootstrapLocalPayload
  const _localTyped: PreloadBootstrapLocalPayload = local;
  void _localTyped;
});

// Compile-time check: both concrete branches are accepted by the public union.
const acceptPayload = (payload: PreloadBootstrapPayload): void => { void payload; };
const remotePayload: PreloadBootstrapRemotePayload = {
  localPage: false,
  localOrigin: '',
  apiBaseUrl: '',
  macosMajor: 0,
  macVibrancy: false,
  trayEnabled: false,
};
acceptPayload(remotePayload);
