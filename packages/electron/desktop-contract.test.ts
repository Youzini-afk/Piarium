import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  VARIN_DESKTOP_COMMAND_CATALOG,
  VARIN_DESKTOP_COMMAND_LIST,
  VARIN_DESKTOP_EVENT_LIST,
  VARIN_REMOTE_SAFE_DESKTOP_COMMANDS,
  isVarinDesktopCommand,
  isVarinDesktopEvent,
  type VarinDesktopCommand,
  type VarinDesktopCommandArgs,
  type VarinDesktopCommandInvocation,
  type VarinDesktopCommandResult,
  type PreloadBootstrapLocalPayload,
  type PreloadBootstrapRemotePayload,
  type PreloadBootstrapPayload,
} from '@varin/application-client/desktop';

import { REMOTE_SAFE_DESKTOP_COMMANDS } from './renderer-security-policy.js';
import { createPreloadBootstrapPayload } from './renderer-security-policy.js';

// ---------------------------------------------------------------------------
// 1. Command catalog completeness — every command in the catalog is known
// ---------------------------------------------------------------------------

test('desktop command catalog has no duplicates', () => {
  const seen = new Set<VarinDesktopCommand>();
  for (const cmd of VARIN_DESKTOP_COMMAND_LIST) {
    assert.equal(seen.has(cmd), false, `duplicate command: ${cmd}`);
    seen.add(cmd);
  }
});

// ---------------------------------------------------------------------------
// 2. Remote-safe set is a subset of the command catalog
// ---------------------------------------------------------------------------

test('remote-safe command set is a subset of the command catalog', () => {
  const catalog = new Set(VARIN_DESKTOP_COMMAND_LIST);
  for (const cmd of VARIN_REMOTE_SAFE_DESKTOP_COMMANDS) {
    assert.equal(catalog.has(cmd), true, `remote-safe command ${cmd} not in catalog`);
  }
});

test('Electron REMOTE_SAFE_DESKTOP_COMMANDS matches shared contract', () => {
  assert.deepEqual(
    [...REMOTE_SAFE_DESKTOP_COMMANDS].sort(),
    [...VARIN_REMOTE_SAFE_DESKTOP_COMMANDS].sort(),
  );
});

// ---------------------------------------------------------------------------
// 3. Unknown command is rejected — the command map is a closed set
// ---------------------------------------------------------------------------

test('unknown command is not in the command map', () => {
  assert.equal(isVarinDesktopCommand('desktop_nonexistent'), false);
  assert.equal(isVarinDesktopCommand('desktop_get_app_version'), true);
});

test('desktop event catalog has no duplicates and rejects unknown events', () => {
  const seen = new Set<string>();
  for (const event of VARIN_DESKTOP_EVENT_LIST) {
    assert.equal(seen.has(event), false, `duplicate event: ${event}`);
    assert.equal(isVarinDesktopEvent(event), true, `catalog event rejected by guard: ${event}`);
    seen.add(event);
  }
  assert.equal(isVarinDesktopEvent('varin:unknown'), false);
});

// ---------------------------------------------------------------------------
// 4. Type-level coverage — compile-time proof that args/results correlate.
//    These are compile-only assertions; if they type-check, the contract
//    is consistent for each category.
// ---------------------------------------------------------------------------

// No-args command
const _noArgs: VarinDesktopCommandArgs<'desktop_get_app_version'> = undefined;
const _noArgsResult: VarinDesktopCommandResult<'desktop_get_app_version'> = '1.0.0';
void _noArgs; void _noArgsResult;

// Union/optional args command
const _optArgs: VarinDesktopCommandArgs<'desktop_capture_page_rect'> = { x: 0, y: 0, width: 100, height: 100 };
const _optArgsResult: VarinDesktopCommandResult<'desktop_capture_page_rect'> = {
  mime: 'image/jpeg',
  base64: '',
  width: 100,
  height: 100,
};
void _optArgs; void _optArgsResult;

// Sensitive command (file read — local only)
const _sensitiveArgs: VarinDesktopCommandArgs<'desktop_read_file'> = { path: '/tmp/test.txt' };
const _sensitiveResult: VarinDesktopCommandResult<'desktop_read_file'> = {
  mime: 'text/plain',
  base64: '',
  size: 0,
};
void _sensitiveArgs; void _sensitiveResult;

// Structured result command (hosts get)
const _structuredResult: VarinDesktopCommandResult<'desktop_hosts_get'> = {
  hosts: [],
  defaultHostId: null,
  initialHostChoiceCompleted: false,
  localOrigin: null,
};
void _structuredResult;

// ---------------------------------------------------------------------------
// 4b. Compile-time catalog exhaustiveness — the catalog value must satisfy
//     Record<VarinDesktopCommand, true>. If a new command is added to the
//     map but not the catalog, this assignment fails to compile.
// ---------------------------------------------------------------------------

const _catalogExhaustive: Record<VarinDesktopCommand, true> = VARIN_DESKTOP_COMMAND_CATALOG;
void _catalogExhaustive;

// ---------------------------------------------------------------------------
// 4c. Invocation tuple shape — no-args commands produce [], required-args
//     commands produce [args]. This is the compile-time proof that
//     required-args commands cannot be called without arguments. No
//     suppression directives are used — the positive assignment IS
//     the proof. If the invocation type were wrong, this would not compile.
// ---------------------------------------------------------------------------

// No-args command: invocation is [] (zero rest parameters)
const _noArgsInvocation: VarinDesktopCommandInvocation<'desktop_get_app_version'> = [];
// Required-args command: invocation is [{ title: string }]
const _requiredArgsInvocation: VarinDesktopCommandInvocation<'desktop_set_window_title'> = [{ title: 'test' }];
// Optional-args command: invocation is [{ x?: number, ... }] — can be empty object
const _optionalArgsInvocation: VarinDesktopCommandInvocation<'desktop_capture_page_rect'> = [{}];
void _noArgsInvocation; void _requiredArgsInvocation; void _optionalArgsInvocation;

// ---------------------------------------------------------------------------
// 5. Bootstrap payload — local carries credentials, remote does not
// ---------------------------------------------------------------------------

test('local bootstrap payload carries credentials, remote does not', () => {
  const common = {
    uiProtocol: 'varin-ui',
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

  const local = createPreloadBootstrapPayload({ ...common, senderUrl: 'varin-ui://app/index.html' });
  if (!local.localPage) assert.fail('local bootstrap must be the credential-bearing branch');
  // Local payload must have credential fields
  assert.equal(local.clientToken, 'secret-token');
  assert.equal(local.homeDirectory, 'C:\\Users\\Example');
  assert.equal(local.relayHostId, 'relay-host');
});

test('bootstrap payload discriminated union narrows correctly', () => {
  const common = {
    uiProtocol: 'varin-ui',
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

  const local = createPreloadBootstrapPayload({ ...common, senderUrl: 'varin-ui://app/index.html' });
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
