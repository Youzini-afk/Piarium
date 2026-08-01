import type { TimelineItem, TimelineToolCall } from "../lib/timeline.js";
import type { LiveTool } from "../state/use-piarium.js";

interface TimelineProps {
  liveAssistant?: TimelineItem | undefined;
  liveTools: LiveTool[];
  onFork(entryId: string): void;
  onNavigate(entryId: string): void;
  timeline: TimelineItem[];
}

function formatTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function jsonPreview(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? "";
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

function ToolCallCard({ tool }: { tool: TimelineToolCall }) {
  return (
    <details className="tool-card">
      <summary>
        <span className="tool-status pending" />
        <span className="tool-name">{tool.name}</span>
        <span className="tool-id">{tool.id.slice(0, 10)}</span>
        <span className="tool-expand">⌄</span>
      </summary>
      <pre>{jsonPreview(tool.arguments)}</pre>
    </details>
  );
}

function TimelineCard({
  item,
  onFork,
  onNavigate,
  streaming = false,
}: {
  item: TimelineItem;
  onFork(entryId: string): void;
  onNavigate(entryId: string): void;
  streaming?: boolean;
}) {
  if (item.kind === "meta") {
    return <div className="timeline-meta">{item.text}</div>;
  }
  if (item.kind === "summary") {
    return (
      <details className="summary-card">
        <summary>上下文摘要 · {formatTime(item.timestamp)}</summary>
        <p>{item.text}</p>
      </details>
    );
  }
  if (item.kind === "tool") {
    return (
      <details className={`tool-result-card${item.error ? " error" : ""}`}>
        <summary>
          <span className={`tool-status ${item.error ? "error" : "success"}`} />
          <span>{item.toolName || "tool"}</span>
          <small>{item.error ? "失败" : "完成"}</small>
        </summary>
        {item.text ? <pre>{item.text}</pre> : null}
      </details>
    );
  }
  if (item.kind === "custom") {
    return (
      <details className="custom-entry-card">
        <summary>
          <span>扩展事件</span>
          <code>{item.customType || item.role || "custom"}</code>
        </summary>
        {item.text ? <pre>{item.text}</pre> : <p>扩展记录了一个结构化会话条目。</p>}
      </details>
    );
  }
  const assistant = item.kind === "assistant";
  return (
    <article className={`message-row ${assistant ? "assistant" : "user"}`}>
      <div className="message-avatar">{assistant ? "π" : "你"}</div>
      <div className="message-body">
        <div className="message-heading">
          <strong>{assistant ? "Pi" : "你"}</strong>
          <time>{streaming ? "正在回复" : formatTime(item.timestamp)}</time>
          {!streaming ? (
            <span className="message-actions">
              <button onClick={() => onNavigate(item.id)} title="切换到此节点" type="button">
                ↩
              </button>
              <button onClick={() => onFork(item.id)} title="从此前分叉" type="button">
                ⑂
              </button>
            </span>
          ) : null}
        </div>
        {item.thinking ? (
          <details className="thinking-block">
            <summary>思考过程</summary>
            <div>{item.thinking}</div>
          </details>
        ) : null}
        {item.text ? <div className="message-text">{item.text}</div> : null}
        {item.images > 0 ? <div className="image-count">{item.images} 张图片</div> : null}
        {item.toolCalls.map((tool) => (
          <ToolCallCard key={tool.id} tool={tool} />
        ))}
        {item.error ? <div className="message-error">{item.error}</div> : null}
        {streaming ? <span className="stream-caret" /> : null}
      </div>
    </article>
  );
}

export function Timeline(props: TimelineProps) {
  return (
    <div className="timeline">
      {props.timeline.length === 0 && !props.liveAssistant ? (
        <div className="timeline-welcome">
          <div className="welcome-orbit">
            <span>π</span>
          </div>
          <h2>从这里开始</h2>
          <p>Pi 可以读取和修改当前项目、运行工具，并通过扩展组织更长的工作流。</p>
          <div className="starter-grid">
            <span>分析这个项目的结构</span>
            <span>查找并修复一个问题</span>
            <span>为当前改动补测试</span>
          </div>
        </div>
      ) : null}
      {props.timeline.map((item) => (
        <TimelineCard
          item={item}
          key={item.id}
          onFork={props.onFork}
          onNavigate={props.onNavigate}
        />
      ))}
      {props.liveAssistant ? (
        <TimelineCard
          item={props.liveAssistant}
          onFork={props.onFork}
          onNavigate={props.onNavigate}
          streaming
        />
      ) : null}
      {props.liveTools.map((tool) => (
        <details
          className={`tool-result-card live ${tool.status}`}
          key={tool.id}
          open={tool.status === "running"}
        >
          <summary>
            <span className={`tool-status ${tool.status}`} />
            <span>{tool.name}</span>
            <small>
              {tool.status === "running" ? "运行中" : tool.status === "error" ? "失败" : "完成"}
            </small>
          </summary>
          {tool.result === undefined ? null : <pre>{jsonPreview(tool.result)}</pre>}
        </details>
      ))}
    </div>
  );
}
