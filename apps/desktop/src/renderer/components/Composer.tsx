import type { KeyboardEvent } from "react";

interface ComposerProps {
  busy: boolean;
  draft: string;
  model?: string | undefined;
  offline: boolean;
  onAbort(): void;
  onChange(value: string): void;
  onSend(): void;
  queueCount: number;
  workingMessage?: string | undefined;
}

export function Composer(props: ComposerProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      props.onSend();
    }
  };
  return (
    <div className="composer-wrap">
      {props.workingMessage ? (
        <div className="working-banner">
          <span />
          {props.workingMessage}
        </div>
      ) : null}
      <div className={`composer${props.offline ? " offline" : ""}`}>
        <textarea
          aria-label="发送消息给 Pi"
          disabled={props.offline}
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            props.offline
              ? "Worker 已离线，请重新打开会话"
              : "给 Pi 发送消息，或输入 / 运行扩展命令…"
          }
          rows={3}
          value={props.draft}
        />
        <div className="composer-toolbar">
          <div className="composer-meta">
            <span className="model-pill">{props.model ?? "选择模型"}</span>
            {props.queueCount > 0 ? (
              <span className="queue-pill">队列 {props.queueCount}</span>
            ) : null}
            <span>Enter 发送 · Shift+Enter 换行</span>
          </div>
          {props.busy ? (
            <button className="send-button stop" onClick={props.onAbort} title="停止" type="button">
              ■
            </button>
          ) : (
            <button
              className="send-button"
              disabled={!props.draft.trim() || props.offline}
              onClick={props.onSend}
              title="发送"
              type="button"
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
