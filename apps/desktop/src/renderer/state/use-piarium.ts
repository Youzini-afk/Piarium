import type {
  ExtensionUiRequest,
  JsonValue,
  ModelDescriptor,
  PackageDescriptor,
  ProviderDescriptor,
  RecoveryApplyResult,
  RecoveryListResult,
  RecoveryMode,
  RecoveryPoint,
  RecoveryPreview,
  SessionSnapshot,
  SessionSummary,
} from "@piarium/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppPreferences,
  DesktopAppInfo,
  DesktopEvent,
  ProjectDescriptor,
  RecoveryDefaultMode,
} from "../../shared/desktop-api.js";
import { normalizeLiveAssistant, normalizeTimeline, type TimelineItem } from "../lib/timeline.js";

export interface ToastMessage {
  id: number;
  message: string;
  tone: "error" | "info" | "success" | "warning";
}

export interface LiveTool {
  id: string;
  isError?: boolean;
  name: string;
  result?: JsonValue;
  status: "error" | "running" | "success";
}

export interface InspectorData {
  commands: Array<{ description?: string; name: string; source?: string }>;
  models: ModelDescriptor[];
  packages: PackageDescriptor[];
  providers: ProviderDescriptor[];
  settings: JsonValue;
}

const EMPTY_INSPECTOR: InspectorData = {
  commands: [],
  models: [],
  packages: [],
  providers: [],
  settings: null,
};

const EMPTY_RECOVERY: RecoveryListResult = {
  available: true,
  canRedo: false,
  canUndo: false,
  checkpoints: [],
  turns: [],
};

const DEFAULT_PREFERENCES: AppPreferences = { recoveryDefault: "ask" };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toJson(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return null;
  }
}

function recoveryWasCancelled(error: unknown): boolean {
  return /Recovery cancelled/i.test(error instanceof Error ? error.message : String(error));
}

function eventSessionId(event: DesktopEvent): string | undefined {
  if (event.kind === "worker.exit") return event.sessionId;
  const data = record(event.envelope.data);
  return typeof data?.sessionId === "string" ? data.sessionId : event.sessionId;
}

export function usePiarium() {
  const [appInfo, setAppInfo] = useState<DesktopAppInfo>();
  const [recentProjects, setRecentProjects] = useState<ProjectDescriptor[]>([]);
  const [preferences, setPreferences] = useState<AppPreferences>(DEFAULT_PREFERENCES);
  const [project, setProject] = useState<ProjectDescriptor>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<SessionSnapshot>();
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [liveAssistant, setLiveAssistant] = useState<TimelineItem>();
  const [liveTools, setLiveTools] = useState<Record<string, LiveTool>>({});
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string>();
  const [offline, setOffline] = useState(false);
  const [extensionRequest, setExtensionRequest] = useState<ExtensionUiRequest>();
  const [extensionStatuses, setExtensionStatuses] = useState<Record<string, string>>({});
  const [extensionWidgets, setExtensionWidgets] = useState<Record<string, string[]>>({});
  const [workingMessage, setWorkingMessage] = useState<string>();
  const [queue, setQueue] = useState({ followUp: [] as string[], steering: [] as string[] });
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [inspector, setInspector] = useState<InspectorData>(EMPTY_INSPECTOR);
  const [inspectorLoading, setInspectorLoading] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryListResult>(EMPTY_RECOVERY);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryPreview, setRecoveryPreview] = useState<RecoveryPreview>();
  const activeSessionRef = useRef<SessionSnapshot | undefined>(undefined);
  const recoveryRef = useRef<RecoveryListResult>(EMPTY_RECOVERY);
  const entriesTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toastSequence = useRef(0);

  const setActive = useCallback((snapshot: SessionSnapshot | undefined) => {
    activeSessionRef.current = snapshot;
    setActiveSession(snapshot);
  }, []);

  const setRecoveryState = useCallback((value: RecoveryListResult) => {
    recoveryRef.current = value;
    setRecovery(value);
  }, []);

  const updateActive = useCallback(
    (update: (snapshot: SessionSnapshot) => SessionSnapshot) => {
      const current = activeSessionRef.current;
      if (!current) return;
      setActive(update(current));
    },
    [setActive],
  );

  const pushToast = useCallback((message: string, tone: ToastMessage["tone"] = "info") => {
    const id = ++toastSequence.current;
    setToasts((current) => [...current.slice(-3), { id, message, tone }]);
    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 5_000);
  }, []);

  const reportError = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      pushToast(message.replace(/^Error invoking remote method '[^']+':\s*/, ""), "error");
    },
    [pushToast],
  );

  const loadEntries = useCallback(async (sessionId: string) => {
    const entries = await window.piarium.getEntries(sessionId, true);
    if (activeSessionRef.current?.sessionId === sessionId) {
      setTimeline(normalizeTimeline(entries));
    }
  }, []);

  const scheduleEntries = useCallback(
    (sessionId: string) => {
      if (entriesTimer.current) clearTimeout(entriesTimer.current);
      entriesTimer.current = setTimeout(() => void loadEntries(sessionId).catch(reportError), 80);
    },
    [loadEntries, reportError],
  );

  const refreshSessions = useCallback(async (cwd: string) => {
    const listed = await window.piarium.listSessions(cwd);
    setSessions(listed);
    return listed;
  }, []);

  const refreshRecovery = useCallback(async () => {
    const snapshot = activeSessionRef.current;
    if (!snapshot) return undefined;
    setRecoveryLoading(true);
    try {
      const value = await window.piarium.getRecovery(snapshot.sessionId);
      if (activeSessionRef.current?.sessionId === snapshot.sessionId) setRecoveryState(value);
      return value;
    } catch (error) {
      reportError(error);
      return undefined;
    } finally {
      setRecoveryLoading(false);
    }
  }, [reportError, setRecoveryState]);

  const activateProject = useCallback(
    async (nextProject: ProjectDescriptor) => {
      setProject(nextProject);
      setActive(undefined);
      setTimeline([]);
      setLiveAssistant(undefined);
      setLiveTools({});
      setRecoveryState(EMPTY_RECOVERY);
      setRecoveryPreview(undefined);
      setOffline(false);
      await refreshSessions(nextProject.path);
    },
    [refreshSessions, setActive, setRecoveryState],
  );

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      window.piarium.getAppInfo(),
      window.piarium.getRecentProjects(),
      window.piarium.getPreferences(),
    ])
      .then(async ([info, recents, storedPreferences]) => {
        if (!mounted) return;
        setAppInfo(info);
        setRecentProjects(recents);
        setPreferences(storedPreferences);
        const first = recents[0];
        if (first) await activateProject(first);
      })
      .catch(reportError)
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [activateProject, reportError]);

  useEffect(() => {
    const unsubscribe = window.piarium.onEvent((desktopEvent) => {
      if (desktopEvent.kind === "worker.exit") {
        const activeSessionId = activeSessionRef.current?.sessionId;
        if (activeSessionId && desktopEvent.sessionId === activeSessionId) {
          setOffline(true);
          updateActive((current) => ({ ...current, busy: false }));
          pushToast("Pi worker 已退出，可重新打开会话恢复", "warning");
        }
        return;
      }
      const { envelope } = desktopEvent;
      const sessionId = eventSessionId(desktopEvent);
      if (envelope.event === "host.error") {
        pushToast(envelope.data.message, "error");
        return;
      }
      if (envelope.event === "host.log") {
        if (envelope.data.level === "error") pushToast(envelope.data.message, "error");
        return;
      }
      if (envelope.event === "session.snapshot") {
        if (
          envelope.data.sessionId === activeSessionRef.current?.sessionId ||
          desktopEvent.workerId === undefined
        ) {
          setActive(envelope.data);
        }
        return;
      }
      if (envelope.event === "session.closed") return;
      if (envelope.event === "extension.ui.dismiss") {
        setExtensionRequest((current) =>
          current?.id === envelope.data.requestId ? undefined : current,
        );
        return;
      }
      if (envelope.event === "extension.ui.request") {
        const request = envelope.data;
        const payload = record(request.payload);
        switch (request.method) {
          case "notify": {
            const tone =
              payload?.type === "error"
                ? "error"
                : payload?.type === "warning"
                  ? "warning"
                  : "info";
            pushToast(String(payload?.message ?? "Extension notification"), tone);
            return;
          }
          case "setEditorText":
            if (request.sessionId === activeSessionRef.current?.sessionId) {
              setDraft(String(payload?.text ?? ""));
            }
            return;
          case "setTitle":
            document.title = `${String(payload?.title ?? "Piarium")} · Piarium`;
            return;
          case "setStatus": {
            const key = String(payload?.key ?? "extension");
            const text = payload?.text;
            setExtensionStatuses((current) => {
              const next = { ...current };
              if (typeof text === "string" && text) next[key] = text;
              else delete next[key];
              return next;
            });
            return;
          }
          case "setWidget": {
            const key = String(payload?.key ?? "extension");
            const lines = Array.isArray(payload?.lines)
              ? payload.lines.filter((line): line is string => typeof line === "string")
              : [];
            setExtensionWidgets((current) => {
              const next = { ...current };
              if (lines.length > 0) next[key] = lines;
              else delete next[key];
              return next;
            });
            return;
          }
          case "setWorkingMessage": {
            setWorkingMessage(typeof payload?.message === "string" ? payload.message : undefined);
            return;
          }
          case "setWorkingVisible":
          case "setWorkingIndicator":
          case "setHiddenThinkingLabel":
            return;
          default:
            if (request.id) setExtensionRequest(request);
        }
        return;
      }
      if (envelope.event === "package.progress") {
        setWorkingMessage(envelope.data.message);
        return;
      }
      if (envelope.event === "recovery.changed") {
        if (envelope.data.sessionId === activeSessionRef.current?.sessionId) {
          void refreshRecovery();
        }
        return;
      }
      if (envelope.event === "recovery.status") {
        if (envelope.data.sessionId === activeSessionRef.current?.sessionId) {
          const { sessionId: _sessionId, ...status } = envelope.data;
          setRecoveryState({ ...recoveryRef.current, ...status });
        }
        return;
      }
      if (envelope.event !== "agent.event" || !sessionId) return;
      if (sessionId !== activeSessionRef.current?.sessionId) return;
      const agentEvent = record(envelope.data.event);
      if (!agentEvent || typeof agentEvent.type !== "string") return;
      const type = agentEvent.type;
      switch (type) {
        case "agent_start":
          updateActive((current) => ({ ...current, busy: true }));
          setOffline(false);
          break;
        case "message_update":
          setLiveAssistant(normalizeLiveAssistant(agentEvent));
          break;
        case "message_end":
          setLiveAssistant(undefined);
          scheduleEntries(sessionId);
          break;
        case "entry_appended":
          scheduleEntries(sessionId);
          break;
        case "tool_execution_start": {
          const id = String(agentEvent.toolCallId ?? "tool");
          setLiveTools((current) => ({
            ...current,
            [id]: {
              id,
              name: String(agentEvent.toolName ?? "tool"),
              status: "running",
            },
          }));
          break;
        }
        case "tool_execution_end": {
          const id = String(agentEvent.toolCallId ?? "tool");
          const isError = agentEvent.isError === true;
          setLiveTools((current) => ({
            ...current,
            [id]: {
              id,
              isError,
              name: String(agentEvent.toolName ?? current[id]?.name ?? "tool"),
              result: toJson(agentEvent.result),
              status: isError ? "error" : "success",
            },
          }));
          scheduleEntries(sessionId);
          break;
        }
        case "queue_update":
          setQueue({
            followUp: Array.isArray(agentEvent.followUp)
              ? agentEvent.followUp.filter((value): value is string => typeof value === "string")
              : [],
            steering: Array.isArray(agentEvent.steering)
              ? agentEvent.steering.filter((value): value is string => typeof value === "string")
              : [],
          });
          break;
        case "auto_retry_start":
          setWorkingMessage(`自动重试 ${String(agentEvent.attempt ?? "")}`);
          break;
        case "compaction_start":
          setWorkingMessage("正在压缩上下文…");
          break;
        case "agent_settled":
          updateActive((current) => ({ ...current, busy: false }));
          setLiveAssistant(undefined);
          setWorkingMessage(undefined);
          scheduleEntries(sessionId);
          if (activeSessionRef.current) {
            void refreshSessions(activeSessionRef.current.cwd).catch(reportError);
          }
          setTimeout(() => setLiveTools({}), 600);
          break;
      }
    });
    return () => {
      unsubscribe();
      if (entriesTimer.current) clearTimeout(entriesTimer.current);
    };
  }, [
    pushToast,
    refreshRecovery,
    refreshSessions,
    reportError,
    scheduleEntries,
    setActive,
    setRecoveryState,
    updateActive,
  ]);

  const chooseProject = useCallback(async () => {
    try {
      const selected = await window.piarium.chooseProject();
      if (!selected) return;
      setRecentProjects(await window.piarium.getRecentProjects());
      await activateProject(selected);
    } catch (error) {
      reportError(error);
    }
  }, [activateProject, reportError]);

  const openRecentProject = useCallback(
    async (path: string) => {
      try {
        const selected = await window.piarium.openProject(path);
        setRecentProjects(await window.piarium.getRecentProjects());
        await activateProject(selected);
      } catch (error) {
        reportError(error);
      }
    },
    [activateProject, reportError],
  );

  const createSession = useCallback(async () => {
    if (!project || busyAction) return;
    setBusyAction("create-session");
    try {
      const snapshot = await window.piarium.createSession(project.path);
      setActive(snapshot);
      setTimeline([]);
      setOffline(false);
      const listed = await refreshSessions(project.path);
      if (!listed.some((session) => session.id === snapshot.sessionId)) {
        setSessions((current) => [
          {
            cwd: snapshot.cwd,
            id: snapshot.sessionId,
            name: `会话 ${snapshot.sessionId.slice(0, 8)}`,
          },
          ...current.filter((session) => session.id !== snapshot.sessionId),
        ]);
      }
      void refreshRecovery();
    } catch (error) {
      reportError(error);
    } finally {
      setBusyAction(undefined);
    }
  }, [busyAction, project, refreshRecovery, refreshSessions, reportError, setActive]);

  const openSession = useCallback(
    async (session: SessionSummary) => {
      if (busyAction) return;
      setBusyAction(`open:${session.id}`);
      try {
        const snapshot = await window.piarium.openSession({
          cwd: session.cwd,
          ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
          sessionId: session.id,
        });
        setActive(snapshot);
        setLiveAssistant(undefined);
        setLiveTools({});
        setOffline(false);
        await loadEntries(snapshot.sessionId);
        void refreshRecovery();
      } catch (error) {
        reportError(error);
      } finally {
        setBusyAction(undefined);
      }
    },
    [busyAction, loadEntries, refreshRecovery, reportError, setActive],
  );

  const previewRecovery = useCallback(
    async (
      targetKind: "checkpoint" | "turn",
      targetId: string,
      point: RecoveryPoint,
      mode: RecoveryMode,
    ) => {
      const snapshot = activeSessionRef.current;
      if (!snapshot) return;
      setRecoveryLoading(true);
      try {
        setRecoveryPreview(
          await window.piarium.previewRecovery(
            snapshot.sessionId,
            targetKind,
            targetId,
            point,
            mode,
          ),
        );
      } catch (error) {
        reportError(error);
      } finally {
        setRecoveryLoading(false);
      }
    },
    [reportError],
  );

  const consumeRecoveryResult = useCallback(
    async (result: RecoveryApplyResult) => {
      setActive(result.snapshot);
      setOffline(false);
      if (result.editorText !== undefined) setDraft(result.editorText);
      await loadEntries(result.snapshot.sessionId);
      await refreshRecovery();
    },
    [loadEntries, refreshRecovery, setActive],
  );

  const quickRecover = useCallback(
    async (entryId: string): Promise<"applied" | "ask" | "failed"> => {
      if (preferences.recoveryDefault === "ask") return "ask";
      const snapshot = activeSessionRef.current;
      if (!snapshot) return "failed";
      let data = recoveryRef.current;
      let turn = data.turns.find(
        (candidate) => candidate.userEntryId === entryId || candidate.resultLeafId === entryId,
      );
      if (!turn) {
        data = (await refreshRecovery()) ?? data;
        turn = data.turns.find(
          (candidate) => candidate.userEntryId === entryId || candidate.resultLeafId === entryId,
        );
      }
      if (!turn) {
        pushToast("这个消息节点还没有可用的恢复快照", "warning");
        return "failed";
      }
      const mode: RecoveryMode = preferences.recoveryDefault === "both" ? "both" : "conversation";
      setRecoveryLoading(true);
      try {
        const preview = await window.piarium.previewRecovery(
          snapshot.sessionId,
          "turn",
          turn.id,
          "before",
          mode,
        );
        const result = await window.piarium.applyRecovery(snapshot.sessionId, preview.planId);
        if (result.cancelled) return "failed";
        await consumeRecoveryResult(result);
        pushToast(mode === "both" ? "会话与文件已回退" : "会话已回退", "success");
        return "applied";
      } catch (error) {
        if (!recoveryWasCancelled(error)) reportError(error);
        return "failed";
      } finally {
        setRecoveryLoading(false);
      }
    },
    [consumeRecoveryResult, preferences.recoveryDefault, pushToast, refreshRecovery, reportError],
  );

  const applyRecovery = useCallback(async () => {
    const snapshot = activeSessionRef.current;
    if (!snapshot || !recoveryPreview) return;
    setRecoveryLoading(true);
    try {
      const result = await window.piarium.applyRecovery(snapshot.sessionId, recoveryPreview.planId);
      if (!result.cancelled) {
        setRecoveryPreview(undefined);
        await consumeRecoveryResult(result);
        pushToast("恢复已完成，可随时撤销", "success");
      }
    } catch (error) {
      if (!recoveryWasCancelled(error)) reportError(error);
    } finally {
      setRecoveryLoading(false);
    }
  }, [consumeRecoveryResult, pushToast, recoveryPreview, reportError]);

  const moveRecoveryHistory = useCallback(
    async (direction: "redo" | "undo") => {
      const snapshot = activeSessionRef.current;
      if (!snapshot) return;
      setRecoveryLoading(true);
      try {
        const result =
          direction === "undo"
            ? await window.piarium.undoRecovery(snapshot.sessionId)
            : await window.piarium.redoRecovery(snapshot.sessionId);
        await consumeRecoveryResult(result);
        pushToast(direction === "undo" ? "已撤销恢复" : "已重做恢复", "success");
      } catch (error) {
        if (!recoveryWasCancelled(error)) reportError(error);
      } finally {
        setRecoveryLoading(false);
      }
    },
    [consumeRecoveryResult, pushToast, reportError],
  );

  const createRecoveryCheckpoint = useCallback(
    async (name: string) => {
      const snapshot = activeSessionRef.current;
      if (!snapshot) return false;
      setRecoveryLoading(true);
      try {
        await window.piarium.createRecoveryCheckpoint(snapshot.sessionId, name);
        await refreshRecovery();
        pushToast("检查点已创建", "success");
        return true;
      } catch (error) {
        reportError(error);
        return false;
      } finally {
        setRecoveryLoading(false);
      }
    },
    [pushToast, refreshRecovery, reportError],
  );

  const setRecoveryDefault = useCallback(
    async (mode: RecoveryDefaultMode) => {
      try {
        setPreferences(await window.piarium.setRecoveryDefault(mode));
        pushToast("默认回退方式已更新", "success");
      } catch (error) {
        reportError(error);
      }
    },
    [pushToast, reportError],
  );

  const send = useCallback(async () => {
    const snapshot = activeSessionRef.current;
    const text = draft.trim();
    if (!snapshot || !text) return;
    setDraft("");
    try {
      if (snapshot.busy) await window.piarium.followUp(snapshot.sessionId, text);
      else await window.piarium.prompt(snapshot.sessionId, text);
    } catch (error) {
      setDraft(text);
      reportError(error);
    }
  }, [draft, reportError]);

  const abort = useCallback(async () => {
    const snapshot = activeSessionRef.current;
    if (!snapshot) return;
    try {
      await window.piarium.abort(snapshot.sessionId);
    } catch (error) {
      reportError(error);
    }
  }, [reportError]);

  const fork = useCallback(
    async (entryId: string) => {
      const snapshot = activeSessionRef.current;
      if (!snapshot) return;
      try {
        const result = await window.piarium.forkSession(snapshot.sessionId, entryId, "before");
        if (result.cancelled) return;
        setActive(result.snapshot);
        if (result.editorText) setDraft(result.editorText);
        await loadEntries(result.snapshot.sessionId);
        if (project) await refreshSessions(project.path);
      } catch (error) {
        reportError(error);
      }
    },
    [loadEntries, project, refreshSessions, reportError, setActive],
  );

  const navigate = useCallback(
    async (entryId: string) => {
      const snapshot = activeSessionRef.current;
      if (!snapshot) return;
      try {
        const result = await window.piarium.navigateSession(snapshot.sessionId, entryId, false);
        if (result.cancelled) return;
        setActive(result.snapshot);
        if (result.editorText) setDraft(result.editorText);
        await loadEntries(result.snapshot.sessionId);
      } catch (error) {
        reportError(error);
      }
    },
    [loadEntries, reportError, setActive],
  );

  const respondToExtension = useCallback(
    async (value?: JsonValue, cancelled: boolean = false) => {
      const request = extensionRequest;
      if (!request?.id) return;
      setExtensionRequest(undefined);
      try {
        await window.piarium.respondToExtensionUi(request.sessionId, {
          cancelled,
          requestId: request.id,
          ...(value === undefined ? {} : { value }),
        });
      } catch (error) {
        reportError(error);
      }
    },
    [extensionRequest, reportError],
  );

  const refreshInspector = useCallback(async () => {
    const snapshot = activeSessionRef.current;
    if (!snapshot) return;
    setInspectorLoading(true);
    try {
      const [providers, models, packages, settings, commands] = await Promise.all([
        window.piarium.listProviders(snapshot.sessionId),
        window.piarium.listModels(snapshot.sessionId),
        window.piarium.listPackages(snapshot.sessionId),
        window.piarium.getSettings(snapshot.sessionId),
        window.piarium.listCommands(snapshot.sessionId),
      ]);
      if (activeSessionRef.current?.sessionId === snapshot.sessionId) {
        setInspector({ commands, models, packages, providers, settings });
      }
    } catch (error) {
      reportError(error);
    } finally {
      setInspectorLoading(false);
    }
  }, [reportError]);

  return {
    abort,
    applyRecovery,
    activeSession,
    appInfo,
    busyAction,
    chooseProject,
    createSession,
    createRecoveryCheckpoint,
    draft,
    extensionRequest,
    extensionStatuses,
    extensionWidgets,
    fork,
    inspector,
    inspectorLoading,
    liveAssistant,
    liveTools: Object.values(liveTools),
    loading,
    navigate,
    offline,
    openRecentProject,
    openSession,
    previewRecovery,
    preferences,
    quickRecover,
    project,
    queue,
    recovery,
    recoveryLoading,
    recoveryPreview,
    recentProjects,
    refreshInspector,
    refreshRecovery,
    refreshSessions,
    reportError,
    respondToExtension,
    send,
    sessions,
    setDraft,
    setInspector,
    setRecoveryPreview,
    setRecoveryDefault,
    timeline,
    toasts,
    workingMessage,
    moveRecoveryHistory,
  };
}
