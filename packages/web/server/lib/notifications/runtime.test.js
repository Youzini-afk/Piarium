import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTriggerRuntime } from './runtime.js';

const createRuntime = (overrides = {}) => {
  const sendPushToAllUiSessions = vi.fn(async () => {});
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(true), { status: 200 }));
  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: vi.fn(async () => ({ nativeNotificationsEnabled: false })),
    prepareNotificationLastMessage: vi.fn(async ({ message }) => message),
    buildTemplateVariables: vi.fn(async () => ({})),
    extractLastMessageText: vi.fn(() => ''),
    fetchLastAssistantMessageText: vi.fn(async () => ''),
    resolveNotificationTemplate: vi.fn((template) => template),
    shouldApplyResolvedTemplateMessage: vi.fn(() => false),
    emitDesktopNotification: vi.fn(() => false),
    broadcastUiNotification: vi.fn(),
    sendPushToAllUiSessions,
    sendMobilePushToAllDevices: vi.fn(async () => {}),
    buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
    fetchImpl,
    ...overrides,
  });
  return { runtime, fetchImpl, sendPushToAllUiSessions };
};

const permissionAsked = (overrides = {}) => ({
  type: 'permission.asked',
  properties: {
    id: 'perm_1',
    sessionID: 'ses_1',
    directory: '/repo',
    permission: 'bash',
    ...overrides,
  },
});

describe('notification permission auto-accept', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('replies to OpenCode when the session has auto-accept enabled', async () => {
    const { runtime, fetchImpl, sendPushToAllUiSessions } = createRuntime();
    await runtime.setAutoAcceptSession('ses_1', true);
    fetchImpl.mockClear();

    await runtime.maybeSendPushForTrigger(permissionAsked());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://opencode.test/permission/perm_1/reply?directory=%2Frepo');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(JSON.parse(init.body)).toEqual({ reply: 'once' });
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('replies to OpenCode when the server-wide auto-accept setting is enabled', async () => {
    const readSettingsFromDisk = vi.fn(async () => ({
      nativeNotificationsEnabled: false,
      serverPermissionAutoAcceptEnabled: true,
    }));
    const { runtime, fetchImpl, sendPushToAllUiSessions } = createRuntime({ readSettingsFromDisk });

    await runtime.maybeSendPushForTrigger(permissionAsked());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://opencode.test/permission/perm_1/reply?directory=%2Frepo');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ reply: 'once' });
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('inherits auto-accept from a parent session before sending notifications', async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url) === 'http://opencode.test/session/child_ses?directory=%2Frepo') {
        return new Response(JSON.stringify({ id: 'child_ses', parentID: 'parent_ses' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, init }), { status: 200 });
    });
    const { runtime, sendPushToAllUiSessions } = createRuntime({ fetchImpl });
    await runtime.setAutoAcceptSession('parent_ses', true);
    fetchImpl.mockClear();

    await runtime.maybeSendPushForTrigger(permissionAsked({
      id: 'perm_child',
      sessionID: 'child_ses',
      directory: '/repo',
    }));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://opencode.test/session/child_ses?directory=%2Frepo');
    expect(fetchImpl.mock.calls[1][0]).toBe('http://opencode.test/permission/perm_child/reply?directory=%2Frepo');
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('joins the authoritative persisted responder instead of racing it', async () => {
    const handlePermissionAutoAccept = vi.fn(async () => true);
    const { runtime, fetchImpl, sendPushToAllUiSessions } = createRuntime();
    runtime.setHandlePermissionAutoAccept(handlePermissionAutoAccept);

    await runtime.maybeSendPushForTrigger(permissionAsked());

    expect(handlePermissionAutoAccept).toHaveBeenCalledWith({
      sessionId: 'ses_1',
      requestId: 'perm_1',
      directory: '/repo',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sendPushToAllUiSessions).not.toHaveBeenCalled();
  });

  it('scans pending permissions when auto-accept is mirrored to the server', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url) === 'http://opencode.test/permission?directory=%2Frepo') {
        return new Response(JSON.stringify([
          { id: 'perm_pending', sessionID: 'ses_1' },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify(true), { status: 200 });
    });
    const { runtime } = createRuntime({ fetchImpl });

    await runtime.setAutoAcceptSession('ses_1', true, { directories: ['/repo'] });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://opencode.test/permission?directory=%2Frepo');
    expect(fetchImpl.mock.calls[1][0]).toBe('http://opencode.test/permission/perm_pending/reply?directory=%2Frepo');
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ reply: 'once' });
  });

  it('scans pending permissions when server-wide auto-accept is enabled', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url) === 'http://opencode.test/permission?directory=%2Frepo') {
        return new Response(JSON.stringify([
          { id: 'perm_pending', sessionID: 'ses_1' },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify(true), { status: 200 });
    });
    const { runtime } = createRuntime({
      fetchImpl,
      readSettingsFromDisk: vi.fn(async () => ({ serverPermissionAutoAcceptEnabled: true })),
    });

    await runtime.autoReplyPendingPermissionsForServerSetting(['/repo']);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://opencode.test/permission?directory=%2Frepo');
    expect(fetchImpl.mock.calls[1][0]).toBe('http://opencode.test/permission/perm_pending/reply?directory=%2Frepo');
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ reply: 'once' });
  });

  it('falls back to the notification path when server-side auto-accept fails', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
    const { runtime, sendPushToAllUiSessions } = createRuntime({ fetchImpl });
    await runtime.setAutoAcceptSession('ses_1', true);
    fetchImpl.mockClear();

    await runtime.maybeSendPushForTrigger(permissionAsked());
    await new Promise((resolve) => setTimeout(resolve, 650));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
  });
});
