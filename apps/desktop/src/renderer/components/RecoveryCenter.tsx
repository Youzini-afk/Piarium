import type {
  RecoveryListResult,
  RecoveryMode,
  RecoveryPoint,
  RecoveryPreview,
} from "@piarium/protocol";
import { useMemo, useState } from "react";
import type { RecoveryDefaultMode } from "../../shared/desktop-api.js";
import type { TimelineItem } from "../lib/timeline.js";

interface RecoveryCenterProps {
  data: RecoveryListResult;
  defaultMode: RecoveryDefaultMode;
  highlightedEntryId?: string | undefined;
  loading: boolean;
  onApply(): void;
  onCheckpoint(name: string): Promise<boolean>;
  onClose(): void;
  onHistory(direction: "redo" | "undo"): void;
  onPreview(
    targetKind: "checkpoint" | "turn",
    targetId: string,
    point: RecoveryPoint,
    mode: RecoveryMode,
  ): void;
  onResetPreview(): void;
  preview?: RecoveryPreview | undefined;
  timeline: TimelineItem[];
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  }).format(date);
}

const MODE_LABELS: Record<RecoveryMode, string> = {
  both: "消息 + 文件",
  conversation: "仅消息",
  files: "仅文件",
};

const CHANGE_LABELS = {
  added: "新增",
  deleted: "删除",
  modified: "修改",
  "type-changed": "类型",
} as const;

export function RecoveryCenter(props: RecoveryCenterProps) {
  const [mode, setMode] = useState<RecoveryMode>(
    props.defaultMode === "conversation" ? "conversation" : "both",
  );
  const [point, setPoint] = useState<RecoveryPoint>("before");
  const [checkpointName, setCheckpointName] = useState("");
  const prompts = useMemo(
    () =>
      new Map(
        props.timeline
          .filter((item) => item.kind === "user")
          .map((item) => [item.id, item.text.trim() || "包含图片的消息"]),
      ),
    [props.timeline],
  );

  const submitCheckpoint = async () => {
    if (await props.onCheckpoint(checkpointName)) setCheckpointName("");
  };

  return (
    <aside aria-label="恢复中心" className="inspector recovery-panel">
      <header className="inspector-header recovery-header">
        <div>
          <span className="modal-kicker">TRANSACTIONAL RECOVERY</span>
          <h2>恢复中心</h2>
          <p>消息位置与工作区文件可以分别或一起恢复；执行前始终重新校验预览。</p>
        </div>
        <button className="icon-button" onClick={props.onClose} type="button">
          ×
        </button>
      </header>

      <div className="recovery-panel-scroll">
        {!props.data.available ? (
          <div className="recovery-warning">
            <strong>恢复引擎不可用</strong>
            <span>{props.data.issue ?? "Git 或恢复存储初始化失败。"}</span>
          </div>
        ) : null}

        <div className="recovery-toolbar">
          <fieldset className="recovery-mode">
            <legend>恢复范围</legend>
            {(Object.keys(MODE_LABELS) as RecoveryMode[]).map((value) => (
              <button
                className={mode === value ? "active" : ""}
                key={value}
                onClick={() => {
                  setMode(value);
                  props.onResetPreview();
                }}
                type="button"
              >
                {MODE_LABELS[value]}
              </button>
            ))}
          </fieldset>
          <div className="recovery-history-actions">
            <button
              className="button small ghost"
              disabled={!props.data.canUndo || props.loading}
              onClick={() => props.onHistory("undo")}
              type="button"
            >
              撤销恢复
            </button>
            <button
              className="button small ghost"
              disabled={!props.data.canRedo || props.loading}
              onClick={() => props.onHistory("redo")}
              type="button"
            >
              重做
            </button>
          </div>
        </div>

        <div className="checkpoint-create">
          <input
            maxLength={120}
            onChange={(event) => setCheckpointName(event.target.value)}
            placeholder="命名当前消息与文件状态…"
            value={checkpointName}
          />
          <button
            className="button small"
            disabled={!checkpointName.trim() || props.loading || !props.data.available}
            onClick={() => void submitCheckpoint()}
            type="button"
          >
            创建检查点
          </button>
        </div>

        <div className="recovery-columns">
          <div className="recovery-list">
            <div className="recovery-list-heading">
              <strong>会话轮次</strong>
              <span>{props.data.turns.length}</span>
            </div>
            {props.data.turns.length === 0 ? (
              <div className="recovery-empty">完成一次 Pi 回复后，这里会出现可恢复的轮次。</div>
            ) : null}
            {props.data.turns.map((turn) => {
              const highlighted =
                props.highlightedEntryId === turn.userEntryId ||
                props.highlightedEntryId === turn.resultLeafId;
              return (
                <article
                  className={`recovery-row${highlighted ? " highlighted" : ""}`}
                  key={turn.id}
                >
                  <div>
                    <strong>{prompts.get(turn.userEntryId)?.slice(0, 100) ?? "Pi 会话轮次"}</strong>
                    <small>
                      {formatDate(turn.completedAt)}
                      {turn.hasImages ? " · 含图片" : ""}
                    </small>
                  </div>
                  <div className="recovery-row-actions">
                    <select
                      aria-label="恢复到轮次前或轮次后"
                      onChange={(event) => {
                        setPoint(event.target.value as RecoveryPoint);
                        props.onResetPreview();
                      }}
                      value={point}
                    >
                      <option value="before">轮次前</option>
                      <option value="after">轮次后</option>
                    </select>
                    <button
                      className="button small"
                      disabled={props.loading || !props.data.available}
                      onClick={() => props.onPreview("turn", turn.id, point, mode)}
                      type="button"
                    >
                      预览
                    </button>
                  </div>
                </article>
              );
            })}

            {props.data.checkpoints.length > 0 ? (
              <div className="recovery-list-heading checkpoints">
                <strong>命名检查点</strong>
                <span>{props.data.checkpoints.length}</span>
              </div>
            ) : null}
            {props.data.checkpoints.map((checkpoint) => (
              <article className="recovery-row checkpoint" key={checkpoint.id}>
                <div>
                  <strong>{checkpoint.name}</strong>
                  <small>{formatDate(checkpoint.createdAt)}</small>
                </div>
                <button
                  className="button small"
                  disabled={props.loading || !props.data.available}
                  onClick={() => props.onPreview("checkpoint", checkpoint.id, "after", mode)}
                  type="button"
                >
                  预览
                </button>
              </article>
            ))}
          </div>

          <aside className="recovery-preview">
            {!props.preview ? (
              <div className="recovery-preview-empty">
                <span>⌁</span>
                <strong>先选择一个恢复点</strong>
                <p>预览会列出文件增删改；如果工作区随后变化，旧预览会自动失效。</p>
              </div>
            ) : (
              <>
                <div className="recovery-preview-heading">
                  <div>
                    <span>恢复范围</span>
                    <strong>{MODE_LABELS[props.preview.mode]}</strong>
                  </div>
                  <div>
                    <span>文件变化</span>
                    <strong>{props.preview.totalChanges}</strong>
                  </div>
                </div>
                {props.preview.mode === "conversation" ? (
                  <div className="recovery-preview-note">
                    文件不会改变，只移动 Pi 会话分支位置。
                  </div>
                ) : props.preview.changes.length === 0 ? (
                  <div className="recovery-preview-note">工作区文件已经与此恢复点一致。</div>
                ) : (
                  <div className="recovery-file-list">
                    {props.preview.changes.map((change) => (
                      <div key={`${change.kind}:${change.path}`}>
                        <span className={`change-kind ${change.kind}`}>
                          {CHANGE_LABELS[change.kind]}
                        </span>
                        <code title={change.path}>{change.path}</code>
                      </div>
                    ))}
                    {props.preview.truncated ? (
                      <small>仅显示前 {props.preview.changes.length} 项。</small>
                    ) : null}
                  </div>
                )}
                <div className="recovery-safety-note">
                  `.env`、私钥、凭据、node_modules 与 Git 内部数据默认不进入快照。
                </div>
                <button
                  className="button primary recovery-apply"
                  disabled={props.loading}
                  onClick={props.onApply}
                  type="button"
                >
                  {props.loading ? "正在校验…" : "确认并创建安全快照"}
                </button>
              </>
            )}
          </aside>
        </div>
      </div>

      <footer className="recovery-footer">
        <span>{props.data.gitPath ?? "Git diagnostics pending"}</span>
        <code>{props.data.root ?? ""}</code>
      </footer>
    </aside>
  );
}
