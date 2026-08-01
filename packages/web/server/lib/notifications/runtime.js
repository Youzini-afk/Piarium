export const createNotificationTriggerRuntime = (deps) => {
  const {
    readSettingsFromDisk,
    prepareNotificationLastMessage,
    buildTemplateVariables,
    extractLastMessageText,
    fetchLastAssistantMessageText,
    resolveNotificationTemplate,
    shouldApplyResolvedTemplateMessage,
    emitDesktopNotification,
    broadcastUiNotification,
    sendPushToAllUiSessions,
    sendMobilePushToAllDevices,
    sendApnsToAllUiSessions,
    isAnyInteractiveClientVisible,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    fetchImpl = fetch,
  } = deps;
  let getIsSessionAutoAccepting = deps.getIsSessionAutoAccepting;
  let handlePermissionAutoAccept = deps.handlePermissionAutoAccept;
  const setGetIsSessionAutoAccepting = (resolver) => {
    getIsSessionAutoAccepting = typeof resolver === 'function' ? resolver : undefined;
  };
  const setHandlePermissionAutoAccept = (handler) => {
    handlePermissionAutoAccept = typeof handler === 'function' ? handler : undefined;
  };

  // App-icon badge for native push: the set of DISTINCT collapse-ids (the push
  // `tag`, e.g. `ready-<sessionId>` / `permission-<requestKey>`) we've sent since
  // the app was last foregrounded. The badge is the absolute APNs `aps.badge`.
  //
  // We key by `tag`, not sessionId, because the tag IS the banner identity: iOS
  // uses it as `apns-collapse-id`, so same-tag pushes REPLACE one banner while
  // different tags are distinct banners. One session can raise several banners
  // (ready + question + permission are different tags), so counting sessionIds
  // both over- and under-counts the lock-screen stack; counting tags mirrors it.
  //
  // We deliberately do NOT derive this from the live attention snapshot
  // (needsAttention/isViewed): that machinery is for in-app indicators on
  // connected clients — a backgrounded client stays "viewing", and needsAttention
  // is set by a separate session.status event that races the push trigger. The
  // set is cleared when a UI client reports visible (`clearPendingPushBadge`),
  // the same moment the device zeroes its icon badge on becomeActive.
  const pendingPushTags = new Set();
  const clearPendingPushBadge = () => {
    pendingPushTags.clear();
  };
  const trackPushAndCountBadge = (tag) => {
    if (typeof tag === 'string' && tag.length > 0) {
      pendingPushTags.add(tag);
    }
    return pendingPushTags.size;
  };

  // Generic notification for native push (per the mobile design): a fixed, scenario-based
  // title + the session name as the body. No model/project/message content crosses the relay.
  const APNS_TITLE_BY_TYPE = {
    ready: 'Agent response is ready',
    error: 'Agent hit an error',
    question: 'Agent needs your input',
    permission: 'Agent needs permission',
    goal_complete: 'Goal complete',
    goal_blocked: 'Goal blocked',
    goal_budget: 'Goal reached its token budget',
  };

  const toApnsGenericPayload = (payload) => {
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
    const sessionName = typeof data.sessionName === 'string' && data.sessionName.trim().length > 0
      ? data.sessionName.trim()
      : 'Session';
    return {
      title: APNS_TITLE_BY_TYPE[data.type] || 'Agent update',
      body: sessionName,
      badge: trackPushAndCountBadge(typeof payload?.tag === 'string' ? payload.tag : undefined),
      tag: payload?.tag,
      // sessionId is forwarded so a tapped push can deep-link; it is an opaque id, not content.
      data: typeof data.sessionId === 'string' ? { sessionId: data.sessionId } : undefined,
    };
  };

  // Fan a notification out to every delivery channel: browser web-push (full templated
  // payload) and native iOS APNs (generic model-based text). Both share the dedup tag and
  // `requireNoSse` focus gate; a failure in one channel must not block the other.
  const fanoutPush = (payload, options) => {
    // Presence-aware routing: if any interactive (non-mobile) client — desktop/web/vscode — is
    // currently visible, it already shows the in-app notification, so skip the native push to the
    // phone. Gated on the desktop's visibility (reliable), never the phone's own. When we skip we
    // also skip toApnsGenericPayload, so the badge isn't incremented for an undelivered push.
    const interactiveVisible = isAnyInteractiveClientVisible?.() === true;
    return Promise.all([
      Promise.resolve(sendPushToAllUiSessions?.(payload, options)).catch((error) => {
        console.warn('[Push] web-push fanout failed:', error?.message ?? error);
      }),
      interactiveVisible
        ? Promise.resolve()
        : Promise.resolve(sendApnsToAllUiSessions?.(toApnsGenericPayload(payload), options)).catch((error) => {
            console.warn('[APNs] fanout failed:', error?.message ?? error);
          }),
    ]);
  };

  let getIsWindowFocused = typeof deps.getIsWindowFocused === 'function'
    ? deps.getIsWindowFocused
    : null;

  const setGetIsWindowFocused = (cb) => {
    getIsWindowFocused = typeof cb === 'function' ? cb : null;
  };

  const PUSH_READY_COOLDOWN_MS = 5000;
  const PUSH_QUESTION_DEBOUNCE_MS = 500;
  const PUSH_PERMISSION_DEBOUNCE_MS = 500;
  const AUTO_ACCEPT_REPLY_TIMEOUT_MS = 5000;
  const pushQuestionDebounceTimers = new Map();
  const pushPermissionDebounceTimers = new Map();
  const notifiedPermissionRequests = new Set();
  const autoAcceptedPermissionRequests = new Set();
  const lastReadyNotificationAt = new Map();
  const lastErrorNotificationAt = new Map();

  const sessionParentIdCache = new Map();
  const SESSION_PARENT_CACHE_TTL_MS = 60 * 1000;

  // Sessions where the client has enabled Permission Auto-Accept. Mirrored
  // from the client-side permissionStore via POST /api/notifications/auto-accept
  // so the server can keep permissions moving even after all browser windows
  // close, while also suppressing stale permission notifications.
  const autoAcceptingSessions = new Set();
  const setAutoAcceptSession = async (sessionId, enabled, options = {}) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (enabled) {
      autoAcceptingSessions.add(sessionId);
      await autoReplyPendingPermissions(sessionId, options.directories);
    } else {
      autoAcceptingSessions.delete(sessionId);
    }
  };

  const buildSessionDeepLinkUrl = (sessionId) => {
    if (!sessionId || typeof sessionId !== 'string') {
      return '/';
    }
    return `/?session=${encodeURIComponent(sessionId)}`;
  };

  const sendMobileNotification = (payload) => {
    if (typeof sendMobilePushToAllDevices !== 'function') {
      return;
    }
    void sendMobilePushToAllDevices(payload).catch((error) => {
      console.warn('[Notification] Mobile push failed:', error?.message || error);
    });
  };

  const getSessionParentCacheKey = (sessionId, directory) => `${directory || ''}\0${sessionId}`;

  const getCachedSessionParentId = (sessionId, directory) => {
    const cacheKey = getSessionParentCacheKey(sessionId, directory);
    const entry = sessionParentIdCache.get(cacheKey);
    if (!entry) return undefined;
    if (Date.now() - entry.at > SESSION_PARENT_CACHE_TTL_MS) {
      sessionParentIdCache.delete(cacheKey);
      return undefined;
    }
    return entry.parentID;
  };

  const setCachedSessionParentId = (sessionId, directory, parentID) => {
    sessionParentIdCache.set(getSessionParentCacheKey(sessionId, directory), { parentID: parentID ?? null, at: Date.now() });
  };

  const getParentIdFromPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return undefined;
    if (payload.type !== 'session.created' && payload.type !== 'session.updated') return undefined;
    const parentID = payload.properties?.info?.parentID ?? null;
    return typeof parentID === 'string' && parentID.length > 0 ? parentID : null;
  };

  const maybeCacheSessionParentFromPayload = (payload) => {
    const sessionId = extractSessionIdFromPayload(payload);
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const directory = extractDirectoryFromPayload(payload);
    const parentID = getParentIdFromPayload(payload);
    if (parentID === undefined) return;
    setCachedSessionParentId(sessionId, directory, parentID);
  };

  const fetchSessionParentId = async (sessionId, directory) => {
    if (!sessionId) return undefined;

    const cached = getCachedSessionParentId(sessionId, directory);
    if (cached !== undefined) return cached;

    try {
      const base = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}`, '');
      const url = directory ? `${base}?directory=${encodeURIComponent(directory)}` : base;
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) {
        return undefined;
      }
      const session = await response.json().catch(() => null);
      if (!session || typeof session !== 'object') {
        return undefined;
      }

      const parentID = typeof session.parentID === 'string' && session.parentID.length > 0
        ? session.parentID
        : null;
      setCachedSessionParentId(sessionId, directory, parentID);
      return parentID;
    } catch {
      return undefined;
    }
  };

  // Mirrors client-side autoRespondsPermission: a session auto-accepts if it
  // OR any ancestor is flagged. Walks the parent chain via fetchSessionParentId.
  const isSessionAutoAccepting = async (sessionId, directory) => {
    if (!sessionId || autoAcceptingSessions.size === 0) return false;
    let current = sessionId;
    const seen = new Set();
    while (current && !seen.has(current)) {
      if (autoAcceptingSessions.has(current)) return true;
      seen.add(current);
      const parent = await fetchSessionParentId(current, directory);
      if (!parent) return false;
      current = parent;
    }
    return false;
  };

  const isServerPermissionAutoAcceptEnabled = async () => {
    try {
      const settings = await readSettingsFromDisk();
      return settings?.serverPermissionAutoAcceptEnabled === true;
    } catch (error) {
      console.warn('[Notification] Failed to read server permission auto-accept setting:', error?.message || error);
      return false;
    }
  };

  const isPersistedSessionAutoAccepting = async (sessionId, directory) => {
    if (typeof getIsSessionAutoAccepting === 'function') {
      return getIsSessionAutoAccepting(sessionId, directory);
    }
    return isSessionAutoAccepting(sessionId, directory);
  };

  const extractPermissionRequestId = (payload) => {
    if (!payload || typeof payload !== 'object') return null;
    const props = payload.properties;
    const requestId = props?.id ?? props?.requestID ?? props?.requestId;
    return typeof requestId === 'string' && requestId.length > 0 ? requestId : null;
  };

  const buildOpenCodeRequestUrl = (path, directory) => {
    const url = new URL(buildOpenCodeUrl(path, ''));
    const trimmedDirectory = typeof directory === 'string' ? directory.trim() : '';
    if (trimmedDirectory) {
      url.searchParams.set('directory', trimmedDirectory);
    }
    return url.toString();
  };

  const normalizeDirectoryList = (directories) => {
    if (!Array.isArray(directories)) {
      return [];
    }

    const seen = new Set();
    const result = [];
    for (const directory of directories) {
      if (typeof directory !== 'string') continue;
      const trimmed = directory.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      result.push(trimmed);
    }
    return result;
  };

  const listPendingPermissions = async (directory) => {
    const response = await fetchImpl(buildOpenCodeRequestUrl('/permission', directory), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      signal: AbortSignal.timeout(AUTO_ACCEPT_REPLY_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`permission.list failed (${response.status})`);
    }

    const data = await response.json().catch(() => null);
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.data)
          ? data.data
          : [];

    return list.filter((permission) => permission && typeof permission === 'object');
  };

  const autoReplyToPermission = async ({ sessionId, requestId, directory }) => {
    if (!requestId) return false;

    const requestKey = sessionId ? `${sessionId}:${requestId}` : requestId;
    if (autoAcceptedPermissionRequests.has(requestKey)) {
      return true;
    }

    autoAcceptedPermissionRequests.add(requestKey);
    try {
      const response = await fetchImpl(buildOpenCodeRequestUrl(`/permission/${encodeURIComponent(requestId)}/reply`, directory), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        body: JSON.stringify({ reply: 'once' }),
        signal: AbortSignal.timeout(AUTO_ACCEPT_REPLY_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`permission.reply failed (${response.status})`);
      }

      return true;
    } catch (error) {
      autoAcceptedPermissionRequests.delete(requestKey);
      console.warn('[Notification] Permission auto-accept failed:', error?.message || error);
      return false;
    }
  };

  const suppressPermissionNotificationForAutoAccept = async ({ sessionId, requestId, directory }) => {
    if (await isServerPermissionAutoAcceptEnabled()) {
      return autoReplyToPermission({ sessionId, requestId, directory });
    }

    // In the integrated server, join the authoritative runtime's in-flight
    // reply. It deduplicates this call with its event subscriber and returns
    // false after retries fail, allowing the notification fallback to run.
    if (typeof handlePermissionAutoAccept === 'function') {
      try {
        return await handlePermissionAutoAccept({ sessionId, requestId, directory }) === true;
      } catch (error) {
        console.warn('[Notification] Persisted permission auto-accept failed:', error?.message || error);
        return false;
      }
    }

    // Compatibility path for embedders that still mirror policies directly
    // into this runtime instead of installing the persisted handler.
    if (!await isPersistedSessionAutoAccepting(sessionId, directory)) return false;
    return autoReplyToPermission({ sessionId, requestId, directory });
  };

  const autoReplyPendingPermissions = async (rootSessionId, directories = []) => {
    if (!rootSessionId || !autoAcceptingSessions.has(rootSessionId)) return;

    const targets = normalizeDirectoryList(directories);
    const scanDirectories = targets.length > 0 ? targets : [undefined];
    await Promise.all(scanDirectories.map(async (directory) => {
      let pending = [];
      try {
        pending = await listPendingPermissions(directory);
      } catch (error) {
        console.warn('[Notification] Permission auto-accept pending scan failed:', error?.message || error);
        return;
      }

      await Promise.all(pending.map(async (permission) => {
        const sessionId = typeof permission.sessionID === 'string' && permission.sessionID.length > 0
          ? permission.sessionID
          : rootSessionId;
        const requestId = permission.id ?? permission.requestID ?? permission.requestId;
        if (typeof requestId !== 'string' || requestId.length === 0) return;
        if (!await isSessionAutoAccepting(sessionId, directory)) return;
        await autoReplyToPermission({ sessionId, requestId, directory });
      }));
    }));
  };

  const autoReplyPendingPermissionsForServerSetting = async (directories = []) => {
    if (!await isServerPermissionAutoAcceptEnabled()) return;

    const targets = normalizeDirectoryList(directories);
    const scanDirectories = targets.length > 0 ? targets : [undefined];
    await Promise.all(scanDirectories.map(async (directory) => {
      let pending = [];
      try {
        pending = await listPendingPermissions(directory);
      } catch (error) {
        console.warn('[Notification] Server permission auto-accept pending scan failed:', error?.message || error);
        return;
      }

      await Promise.all(pending.map(async (permission) => {
        const sessionId = typeof permission.sessionID === 'string' && permission.sessionID.length > 0
          ? permission.sessionID
          : typeof permission.sessionId === 'string' && permission.sessionId.length > 0
            ? permission.sessionId
            : undefined;
        const requestId = permission.id ?? permission.requestID ?? permission.requestId;
        if (typeof requestId !== 'string' || requestId.length === 0) return;
        await autoReplyToPermission({ sessionId, requestId, directory });
      }));
    }));
  };

  const extractSessionIdFromPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return null;
    const props = payload.properties;
    const info = props?.info;
    const sessionId =
      info?.sessionID ??
      info?.sessionId ??
      props?.sessionID ??
      props?.sessionId ??
      props?.session ??
      null;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  };

  const extractDirectoryFromPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return undefined;
    const props = payload.properties;
    const directory = props?.directory ?? props?.info?.directory;
    if (typeof directory !== 'string') return undefined;
    const trimmed = directory.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const formatMode = (raw) => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    const normalized = value.length > 0 ? value : 'agent';
    return normalized
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
      .join(' ');
  };

  const formatModelId = (raw) => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      return 'Assistant';
    }

    const tokens = value.split(/[-_]+/).filter(Boolean);
    const result = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const current = tokens[i];
      const next = tokens[i + 1];
      if (/^\d+$/.test(current) && next && /^\d+$/.test(next)) {
        result.push(`${current}.${next}`);
        i += 1;
        continue;
      }
      result.push(current);
    }

    return result
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  };

  // A session with an ACTIVE goal suppresses per-turn ready notifications;
  // the session-goal runtime sends its own notification when the goal
  // settles. Fetch failures fall through to normal notification behavior.
  const hasActiveSessionGoal = async (sessionId, directory) => {
    if (!sessionId) return false;
    try {
      const base = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}`, '');
      const url = directory ? `${base}?directory=${encodeURIComponent(directory)}` : base;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return false;
      const session = await response.json().catch(() => null);
      const goal = session?.metadata?.openchamber?.goal;
      return Boolean(goal && typeof goal === 'object' && goal.status === 'active');
    } catch {
      return false;
    }
  };

  const maybeSendPushForTrigger = async (payload) => {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    maybeCacheSessionParentFromPayload(payload);

    const sessionId = extractSessionIdFromPayload(payload);
    const notificationDirectory = extractDirectoryFromPayload(payload);
    if ((payload.type === 'session.idle' || payload.type === 'session.error') && sessionId) {
      const error = payload.properties?.error;
      const errorText = typeof error?.message === 'string'
        ? error.message
        : typeof error === 'string' ? error : '';
      await maybeSendPushForTrigger({
        ...payload,
        type: 'message.updated',
        properties: {
          ...payload.properties,
          info: {
            sessionID: sessionId,
            role: 'assistant',
            finish: payload.type === 'session.error' ? 'error' : 'stop',
            ...(errorText ? { parts: [{ type: 'text', text: errorText }] } : {}),
          },
        },
      });
      return;
    }

    if (payload.type === 'message.updated') {
      const info = payload.properties?.info;
      if (info?.role === 'assistant' && info?.finish === 'stop' && sessionId) {
        const settings = await readSettingsFromDisk();

        if (settings.notifyOnSubtasks === false) {
          const parentIDFromPayload = getParentIdFromPayload(payload);
          const parentID = parentIDFromPayload
            ? parentIDFromPayload
            : await fetchSessionParentId(sessionId, notificationDirectory);

          if (parentID !== null) {
            return;
          }
        }

        if (settings.notifyOnCompletion === false) {
          return;
        }

        // While a goal drives the session, per-turn "ready" notifications are
        // noise produced by the goal loop itself — the goal's own settle
        // notification (complete/blocked/budget) is the final word instead.
        if (await hasActiveSessionGoal(sessionId, notificationDirectory)) {
          return;
        }

        if (settings.notificationMode !== 'always' && getIsWindowFocused?.()) {
          return;
        }
        const now = Date.now();
        const lastAt = lastReadyNotificationAt.get(sessionId) ?? 0;
        if (now - lastAt < PUSH_READY_COOLDOWN_MS) {
          return;
        }
        lastReadyNotificationAt.set(sessionId, now);

        let title = `${formatMode(info?.mode)} agent is ready`;
        let body = `${formatModelId(info?.modelID)} completed the task`;
        let sessionName = '';

        try {
          const templates = settings.notificationTemplates || {};
          const isSubtask = await fetchSessionParentId(sessionId, notificationDirectory);
          const completionTemplate = isSubtask && settings.notifyOnSubtasks !== false
            ? (templates.subtask || templates.completion || { title: '{agent_name} is ready', message: '{model_name} completed the task' })
            : (templates.completion || { title: '{agent_name} is ready', message: '{model_name} completed the task' });

          const variables = await buildTemplateVariables(payload, sessionId);
          sessionName = typeof variables.session_name === 'string' ? variables.session_name : sessionName;

          const messageId = info?.id;
          let lastMessage = extractLastMessageText(payload);
          if (!lastMessage) {
            lastMessage = await fetchLastAssistantMessageText(sessionId, messageId);
          }

          variables.last_message = await prepareNotificationLastMessage({
            message: lastMessage,
            settings,
          });

          const resolvedTitle = resolveNotificationTemplate(completionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(completionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(completionTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Template resolution failed, using defaults:', error?.message || error);
        }

        if (settings.nativeNotificationsEnabled) {
          const notificationPayload = {
            title,
            body,
            tag: `ready-${sessionId}`,
            kind: 'ready',
            sessionId,
            directory: notificationDirectory,
            requireHidden: settings.notificationMode !== 'always',
          };
          const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
          broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
        }

        await fanoutPush(
          {
            title,
            body,
            tag: `ready-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              sessionName,
              type: 'ready',
            },
          },
          { requireNoSse: true },
        );
        sendMobileNotification({
          title,
          body,
          tag: `ready-${sessionId}`,
          data: {
            url: buildSessionDeepLinkUrl(sessionId),
            sessionId,
            type: 'ready',
          },
        });
      }

      if (info?.role === 'assistant' && info?.finish === 'error' && sessionId) {
        const settings = await readSettingsFromDisk();
        if (settings.notifyOnError === false) return;

        const now = Date.now();
        const lastAt = lastErrorNotificationAt.get(sessionId) ?? 0;
        if (now - lastAt < PUSH_READY_COOLDOWN_MS) return;
        lastErrorNotificationAt.set(sessionId, now);

        if (settings.notificationMode !== 'always' && getIsWindowFocused?.()) {
          return;
        }
        let title = 'Tool error';
        let body = 'An error occurred';
        let sessionName = '';

        try {
          const variables = await buildTemplateVariables(payload, sessionId);
          sessionName = typeof variables.session_name === 'string' ? variables.session_name : sessionName;
          const errorMessageId = info?.id;
          let lastMessage = extractLastMessageText(payload);
          if (!lastMessage) {
            lastMessage = await fetchLastAssistantMessageText(sessionId, errorMessageId);
          }

          variables.last_message = await prepareNotificationLastMessage({
            message: lastMessage,
            settings,
          });

          const errorTemplate = (settings.notificationTemplates || {}).error || { title: 'Tool error', message: '{last_message}' };
          const resolvedTitle = resolveNotificationTemplate(errorTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(errorTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(errorTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Error template resolution failed, using defaults:', error?.message || error);
        }

        if (settings.nativeNotificationsEnabled) {
          const notificationPayload = {
            title,
            body,
            tag: `error-${sessionId}`,
            kind: 'error',
            sessionId,
            directory: notificationDirectory,
            requireHidden: settings.notificationMode !== 'always',
          };
          const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
          broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
        }

        await fanoutPush(
          {
            title,
            body,
            tag: `error-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              sessionName,
              type: 'error',
            },
          },
          { requireNoSse: true },
        );
        sendMobileNotification({
          title,
          body,
          tag: `error-${sessionId}`,
          data: {
            url: buildSessionDeepLinkUrl(sessionId),
            sessionId,
            type: 'error',
          },
        });
      }

      return;
    }

    if (payload.type === 'question.asked' && sessionId) {
      const existingTimer = pushQuestionDebounceTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(async () => {
        pushQuestionDebounceTimers.delete(sessionId);

        const settings = await readSettingsFromDisk();
        if (settings.notifyOnQuestion === false) {
          return;
        }

        const firstQuestion = payload.properties?.questions?.[0];
        const header = typeof firstQuestion?.header === 'string' ? firstQuestion.header.trim() : '';
        const questionText = typeof firstQuestion?.question === 'string' ? firstQuestion.question.trim() : '';

        let title = /plan\s*mode/i.test(header)
          ? 'Switch to plan mode'
          : /build\s*agent/i.test(header)
            ? 'Switch to build mode'
            : header || 'Input needed';
        let body = questionText || 'Agent is waiting for your response';
        let sessionName = '';

        try {
          const variables = await buildTemplateVariables(payload, sessionId);
          sessionName = typeof variables.session_name === 'string' ? variables.session_name : sessionName;
          variables.last_message = questionText || header || '';

          const templates = settings.notificationTemplates || {};
          const questionTemplate = templates.question || { title: 'Input needed', message: '{last_message}' };

          const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Question template resolution failed, using defaults:', error?.message || error);
        }

        if (settings.nativeNotificationsEnabled) {
          const notificationPayload = {
            kind: 'question',
            title,
            body,
            tag: `question-${sessionId}`,
            sessionId,
            directory: notificationDirectory,
            requireHidden: settings.notificationMode !== 'always',
          };
          const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
          broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
        }

        void fanoutPush(
          {
            title,
            body,
            tag: `question-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              sessionName,
              type: 'question',
            },
          },
          { requireNoSse: true },
        );
        sendMobileNotification({
          title,
          body,
          tag: `question-${sessionId}`,
          data: {
            url: buildSessionDeepLinkUrl(sessionId),
            sessionId,
            type: 'question',
          },
        });
      }, PUSH_QUESTION_DEBOUNCE_MS);

      pushQuestionDebounceTimers.set(sessionId, timer);
      return;
    }

    if (payload.type === 'permission.replied' && sessionId) {
      const requestId = payload.properties?.requestID ?? payload.properties?.requestId ?? payload.properties?.id;
      const requestKey = typeof requestId === 'string' ? `${sessionId}:${requestId}` : null;
      if (requestKey) {
        autoAcceptedPermissionRequests.delete(requestKey);
      }
      const pendingNotification = pushPermissionDebounceTimers.get(sessionId);
      if (!pendingNotification) {
        return;
      }

      // Some runtimes may omit requestID on permission.replied.
      // When request ID is missing, clear session debounce to avoid
      // showing stale permission notifications for auto-approved prompts.
      if (!requestKey || !pendingNotification.requestKey || pendingNotification.requestKey === requestKey) {
        clearTimeout(pendingNotification.timer);
        pushPermissionDebounceTimers.delete(sessionId);
      }
      return;
    }

    if (payload.type === 'permission.asked' && sessionId) {
      const requestId = extractPermissionRequestId(payload);
      const permission = payload.properties?.permission;
      const requestKey = typeof requestId === 'string' ? `${sessionId}:${requestId}` : null;
      if (requestKey && notifiedPermissionRequests.has(requestKey)) {
        return;
      }

      if (await suppressPermissionNotificationForAutoAccept({
        sessionId,
        requestId,
        directory: notificationDirectory,
      })) {
        if (requestKey) notifiedPermissionRequests.add(requestKey);
        return;
      }

      const existingTimer = pushPermissionDebounceTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer.timer);
      }

      const timer = setTimeout(async () => {
        pushPermissionDebounceTimers.delete(sessionId);

        if (await suppressPermissionNotificationForAutoAccept({
          sessionId,
          requestId,
          directory: notificationDirectory,
        })) {
          if (requestKey) notifiedPermissionRequests.add(requestKey);
          return;
        }

        const settings = await readSettingsFromDisk();

        if (settings.notifyOnQuestion === false) {
          return;
        }

        const sessionTitle = payload.properties?.sessionTitle;
        const permissionText = typeof permission === 'string' && permission.length > 0 ? permission : '';
        const fallbackMessage = typeof sessionTitle === 'string' && sessionTitle.trim().length > 0
          ? sessionTitle.trim()
          : permissionText || 'Agent is waiting for your approval';

        let title = 'Permission required';
        let body = fallbackMessage;
        let sessionName = '';

        try {
          const variables = await buildTemplateVariables(payload, sessionId);
          sessionName = typeof variables.session_name === 'string' ? variables.session_name : sessionName;
          variables.last_message = fallbackMessage;

          const templates = settings.notificationTemplates || {};
          const questionTemplate = templates.question || { title: 'Permission required', message: '{last_message}' };

          const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Permission template resolution failed, using defaults:', error?.message || error);
        }

        if (settings.nativeNotificationsEnabled) {
          const notificationPayload = {
            kind: 'permission',
            title,
            body,
            tag: requestKey ? `permission-${requestKey}` : `permission-${sessionId}`,
            sessionId,
            directory: notificationDirectory,
            requireHidden: settings.notificationMode !== 'always',
          };
          const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
          broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
        }

        if (requestKey) {
          notifiedPermissionRequests.add(requestKey);
        }

        void fanoutPush(
          {
            title,
            body,
            tag: `permission-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              sessionName,
              type: 'permission',
            },
          },
          { requireNoSse: true },
        );
        sendMobileNotification({
          title,
          body,
          tag: `permission-${sessionId}`,
          data: {
            url: buildSessionDeepLinkUrl(sessionId),
            sessionId,
            type: 'permission',
          },
        });
      }, PUSH_PERMISSION_DEBOUNCE_MS);

      pushPermissionDebounceTimers.set(sessionId, { timer, requestKey });
    }
  };

  // Goal settle push: same fanout as the trigger paths (web-push with the
  // full text; APNs with the generic per-type title and the session name as
  // body, so the relay never sees content).
  const sendGoalSettlePush = async ({ sessionId, directory, status, title, body }) => {
    let sessionName = '';
    try {
      const base = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}`, '');
      const url = directory ? `${base}?directory=${encodeURIComponent(directory)}` : base;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const session = await response.json().catch(() => null);
        if (typeof session?.title === 'string') sessionName = session.title.trim();
      }
    } catch {
      // Session name is presentation sugar for the mobile push — never block on it.
    }
    const type = status === 'complete' ? 'goal_complete' : (status === 'budgetLimited' ? 'goal_budget' : 'goal_blocked');
    await fanoutPush(
      {
        title,
        body,
        tag: `goal-${sessionId}`,
        data: {
          url: buildSessionDeepLinkUrl(sessionId),
          sessionId,
          sessionName,
          type,
        },
      },
      { requireNoSse: true },
    );
  };

  return {
    maybeSendPushForTrigger,
    setAutoAcceptSession,
    autoReplyPendingPermissionsForServerSetting,
    setGetIsWindowFocused,
    setGetIsSessionAutoAccepting,
    setHandlePermissionAutoAccept,
    clearPendingPushBadge,
    sendGoalSettlePush,
  };
};
