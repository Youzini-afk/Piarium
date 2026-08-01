import { useEffect, useRef, useState } from "react";
import { Composer } from "./components/Composer.js";
import { ExtensionDialog } from "./components/ExtensionDialog.js";
import { Inspector } from "./components/Inspector.js";
import { RecoveryCenter } from "./components/RecoveryCenter.js";
import { Sidebar } from "./components/Sidebar.js";
import { Timeline } from "./components/Timeline.js";
import { usePiarium } from "./state/use-piarium.js";

export function App() {
  const state = usePiarium();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryEntryId, setRecoveryEntryId] = useState<string>();
  const timelineScroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = timelineScroll.current;
    if (element) element.scrollTo({ behavior: "smooth", top: element.scrollHeight });
  });

  const openInspector = () => {
    setRecoveryOpen(false);
    setInspectorOpen(true);
    void state.refreshInspector();
  };

  const openRecovery = (entryId?: string) => {
    setInspectorOpen(false);
    setRecoveryEntryId(entryId);
    setRecoveryOpen(true);
    state.setRecoveryPreview(undefined);
    void state.refreshRecovery();
  };

  const recoverFromMessage = (entryId: string) => {
    void state.quickRecover(entryId).then((result) => {
      if (result === "ask") openRecovery(entryId);
    });
  };

  if (state.loading) {
    return (
      <main className="splash-screen">
        <div className="splash-orbit">
          <span>π</span>
        </div>
        <strong>Piarium</strong>
        <small>正在连接 Pi runtime…</small>
      </main>
    );
  }

  return (
    <div className={`app-shell${inspectorOpen || recoveryOpen ? " inspector-open" : ""}`}>
      <Sidebar
        activeSession={state.activeSession}
        busyAction={state.busyAction}
        onChooseProject={() => void state.chooseProject()}
        onCreateSession={() => void state.createSession()}
        onOpenProject={(path) => void state.openRecentProject(path)}
        onOpenSession={(session) => void state.openSession(session)}
        project={state.project}
        recentProjects={state.recentProjects}
        sessions={state.sessions}
      />

      <main className="workspace" data-session-id={state.activeSession?.sessionId}>
        <header className="workspace-header">
          <div className="workspace-heading">
            <strong>
              {state.activeSession
                ? state.sessions.find((session) => session.id === state.activeSession?.sessionId)
                    ?.name || `会话 ${state.activeSession.sessionId.slice(0, 8)}`
                : (state.project?.name ?? "欢迎使用 Piarium")}
            </strong>
            <small>{state.activeSession?.cwd ?? state.project?.path ?? "选择一个项目以开始"}</small>
          </div>
          <div className="workspace-header-actions">
            {state.offline ? <span className="header-status error">Worker 离线</span> : null}
            {state.activeSession ? (
              <>
                <span className={`header-status ${state.activeSession.busy ? "busy" : "ready"}`}>
                  <span />
                  {state.activeSession.busy ? "Pi 工作中" : "就绪"}
                </span>
                <button className="header-button" onClick={openInspector} type="button">
                  调节
                </button>
                <button className="header-button" onClick={() => openRecovery()} type="button">
                  恢复
                </button>
              </>
            ) : null}
          </div>
        </header>

        {!state.project ? (
          <section className="onboarding">
            <div className="onboarding-copy">
              <span className="eyebrow">PI-NATIVE DESKTOP WORKSPACE</span>
              <h1>
                把 Pi 的全部能力，
                <br />
                放进一个安静的工作台。
              </h1>
              <p>
                会话、模型、扩展、Subagents、MCP、Web Access 与可恢复的工作区历史，都围绕 Pi
                原生能力组织。
              </p>
              <button
                className="button primary large"
                onClick={() => void state.chooseProject()}
                type="button"
              >
                打开本地项目
              </button>
            </div>
            <div className="runtime-card">
              <div className="runtime-card-header">
                <span className="pulse" />
                <strong>Runtime diagnostics</strong>
              </div>
              {state.appInfo?.runtimes.map((runtime) => (
                <div className="runtime-row" key={runtime.id}>
                  <span
                    className={`runtime-state ${runtime.available && runtime.compatible ? "ok" : "warn"}`}
                  />
                  <div>
                    <strong>{runtime.source}</strong>
                    <small>{runtime.version ?? runtime.issue ?? "Unavailable"}</small>
                  </div>
                  <code>{runtime.id}</code>
                </div>
              ))}
              <footer>
                Electron {state.appInfo?.electronVersion} · Node {state.appInfo?.nodeVersion} ·{" "}
                {state.appInfo?.platform}/{state.appInfo?.arch}
              </footer>
            </div>
          </section>
        ) : !state.activeSession ? (
          <section className="project-home">
            <div className="project-glyph">⌁</div>
            <span className="eyebrow">PROJECT READY</span>
            <h1>{state.project.name}</h1>
            <p>
              {state.sessions.length > 0
                ? "从左侧恢复一个会话，或创建新的工作分支。"
                : "项目已连接。创建第一个 Pi 会话开始工作。"}
            </p>
            <button
              className="button primary large"
              disabled={Boolean(state.busyAction)}
              onClick={() => void state.createSession()}
              type="button"
            >
              ＋ 新建会话
            </button>
          </section>
        ) : (
          <>
            <div className="timeline-scroll" ref={timelineScroll}>
              <Timeline
                liveAssistant={state.liveAssistant}
                liveTools={state.liveTools}
                onFork={(entryId) => void state.fork(entryId)}
                onNavigate={(entryId) => void state.navigate(entryId)}
                onRecover={recoverFromMessage}
                timeline={state.timeline}
              />
            </div>
            {Object.keys(state.extensionWidgets).length > 0 ? (
              <div className="extension-widgets">
                {Object.entries(state.extensionWidgets).map(([key, lines]) => (
                  <div key={key}>
                    <strong>{key}</strong>
                    <span>{lines.join(" · ")}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <Composer
              busy={state.activeSession.busy}
              draft={state.draft}
              model={
                state.activeSession.model
                  ? `${state.activeSession.model.provider}/${state.activeSession.model.name}`
                  : undefined
              }
              offline={state.offline}
              onAbort={() => void state.abort()}
              onChange={state.setDraft}
              onSend={() => void state.send()}
              queueCount={state.queue.followUp.length + state.queue.steering.length}
              workingMessage={state.workingMessage}
            />
          </>
        )}
      </main>

      {inspectorOpen && state.activeSession ? (
        <Inspector
          data={state.inspector}
          loading={state.inspectorLoading}
          onClose={() => setInspectorOpen(false)}
          onError={state.reportError}
          onRecoveryDefault={(mode) => void state.setRecoveryDefault(mode)}
          onRefresh={state.refreshInspector}
          session={state.activeSession}
          recoveryDefault={state.preferences.recoveryDefault}
        />
      ) : null}

      {recoveryOpen && state.activeSession ? (
        <RecoveryCenter
          data={state.recovery}
          defaultMode={state.preferences.recoveryDefault}
          highlightedEntryId={recoveryEntryId}
          loading={state.recoveryLoading}
          onApply={() => void state.applyRecovery()}
          onCheckpoint={state.createRecoveryCheckpoint}
          onClose={() => {
            setRecoveryOpen(false);
            setRecoveryEntryId(undefined);
            state.setRecoveryPreview(undefined);
          }}
          onHistory={(direction) => void state.moveRecoveryHistory(direction)}
          onPreview={(targetKind, targetId, point, mode) =>
            void state.previewRecovery(targetKind, targetId, point, mode)
          }
          onResetPreview={() => state.setRecoveryPreview(undefined)}
          preview={state.recoveryPreview}
          timeline={state.timeline}
        />
      ) : null}

      <ExtensionDialog
        onRespond={(value, cancelled) => void state.respondToExtension(value, cancelled)}
        request={state.extensionRequest}
      />
      <div className="toast-stack" aria-live="polite">
        {state.toasts.map((toast) => (
          <div className={`toast ${toast.tone}`} key={toast.id}>
            {toast.message}
          </div>
        ))}
      </div>
      {Object.keys(state.extensionStatuses).length > 0 ? (
        <div className="extension-statusbar">
          {Object.entries(state.extensionStatuses).map(([key, text]) => (
            <span key={key}>
              <strong>{key}</strong>
              {text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
