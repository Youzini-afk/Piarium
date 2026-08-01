import type { SessionSnapshot, SessionSummary } from "@piarium/protocol";
import type { ProjectDescriptor } from "../../shared/desktop-api.js";

interface SidebarProps {
  activeSession?: SessionSnapshot | undefined;
  busyAction?: string | undefined;
  onChooseProject(): void;
  onCreateSession(): void;
  onOpenProject(path: string): void;
  onOpenSession(session: SessionSummary): void;
  project?: ProjectDescriptor | undefined;
  recentProjects: ProjectDescriptor[];
  sessions: SessionSummary[];
}

function timeLabel(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("zh-CN", { day: "2-digit", month: "2-digit" }).format(date);
}

export function Sidebar(props: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-titlebar">
        <div className="brand-mark">π</div>
        <div>
          <div className="brand-name">Piarium</div>
          <div className="brand-tagline">Pi agent workspace</div>
        </div>
      </div>

      <button className="project-picker" onClick={props.onChooseProject} type="button">
        <span className="project-icon">⌂</span>
        <span className="project-picker-copy">
          <strong>{props.project?.name ?? "选择项目"}</strong>
          <small>{props.project?.path ?? "打开一个本地工作目录"}</small>
        </span>
        <span className="chevron">⌄</span>
      </button>

      {props.project ? (
        <>
          <div className="sidebar-section-heading">
            <span>会话</span>
            <button
              aria-label="新建会话"
              className="icon-button"
              disabled={Boolean(props.busyAction)}
              onClick={props.onCreateSession}
              title="新建会话"
              type="button"
            >
              ＋
            </button>
          </div>
          <div className="session-list">
            {props.sessions.length === 0 ? (
              <div className="sidebar-empty">还没有会话，点击 ＋ 开始</div>
            ) : (
              props.sessions.map((session) => {
                const active = props.activeSession?.sessionId === session.id;
                return (
                  <button
                    className={`session-row${active ? " active" : ""}`}
                    disabled={Boolean(props.busyAction)}
                    key={session.id}
                    onClick={() => props.onOpenSession(session)}
                    type="button"
                  >
                    <span className="session-branch">⌁</span>
                    <span className="session-copy">
                      <strong>{session.name || `会话 ${session.id.slice(0, 8)}`}</strong>
                      <small>{session.id.slice(0, 12)}</small>
                    </span>
                    <time>{timeLabel(session.updatedAt)}</time>
                  </button>
                );
              })
            )}
          </div>
        </>
      ) : (
        <div className="recent-projects">
          <div className="sidebar-section-heading">
            <span>最近项目</span>
          </div>
          {props.recentProjects.map((recent) => (
            <button
              className="recent-project-row"
              key={recent.path}
              onClick={() => props.onOpenProject(recent.path)}
              type="button"
            >
              <span>▱</span>
              <span>
                <strong>{recent.name}</strong>
                <small>{recent.path}</small>
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="sidebar-footer">
        <span className="status-dot online" />
        <span>本地模式</span>
        <span className="sidebar-footer-spacer" />
        <span>Pi native</span>
      </div>
    </aside>
  );
}
