import type { JsonValue, SessionSnapshot } from "@piarium/protocol";
import { useMemo, useState } from "react";
import type { InspectorData } from "../state/use-piarium.js";

interface InspectorProps {
  data: InspectorData;
  loading: boolean;
  onClose(): void;
  onError(error: unknown): void;
  onRefresh(): Promise<void> | void;
  session: SessionSnapshot;
}

type InspectorTab = "commands" | "models" | "packages" | "providers" | "settings";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function Inspector(props: InspectorProps) {
  const [tab, setTab] = useState<InspectorTab>("providers");
  const [filter, setFilter] = useState("");
  const [packageSource, setPackageSource] = useState("");
  const [action, setAction] = useState<string>();
  const globalSettings = record(record(props.data.settings)?.global) ?? {};
  const models = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const source = query
      ? props.data.models.filter((model) =>
          `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query),
        )
      : props.data.models;
    return source.slice(0, 120);
  }, [filter, props.data.models]);

  const run = async (name: string, operation: () => Promise<unknown>) => {
    if (action) return;
    setAction(name);
    try {
      await operation();
      await props.onRefresh();
    } catch (error) {
      props.onError(error);
    } finally {
      setAction(undefined);
    }
  };

  return (
    <aside className="inspector">
      <div className="inspector-header">
        <div>
          <small>SESSION CONTROL</small>
          <strong>Pi 配置</strong>
        </div>
        <button className="icon-button" onClick={props.onClose} type="button">
          ×
        </button>
      </div>
      <div className="inspector-tabs">
        {(["providers", "models", "packages", "settings", "commands"] as const).map((value) => (
          <button
            className={tab === value ? "active" : ""}
            key={value}
            onClick={() => setTab(value)}
            type="button"
          >
            {
              {
                commands: "命令",
                models: "模型",
                packages: "扩展",
                providers: "Provider",
                settings: "设置",
              }[value]
            }
          </button>
        ))}
      </div>
      <div className="inspector-content">
        {props.loading ? <div className="panel-loading">正在读取 Pi 配置…</div> : null}

        {tab === "providers" ? (
          <div className="panel-stack">
            <div className="panel-note">凭据由 Pi AuthStorage 管理，不会写入渲染器存储。</div>
            {props.data.providers.map((provider) => (
              <section className="setting-card" key={provider.id}>
                <div className="setting-card-heading">
                  <div>
                    <strong>{provider.name}</strong>
                    <small>{provider.id}</small>
                  </div>
                  <span className={`status-badge ${provider.configured ? "success" : "muted"}`}>
                    {provider.configured ? "已配置" : "未配置"}
                  </span>
                </div>
                <div className="button-row">
                  {provider.configured ? (
                    <button
                      className="button small ghost"
                      disabled={Boolean(action)}
                      onClick={() =>
                        void run(`logout:${provider.id}`, () =>
                          window.piarium.logoutProvider(props.session.sessionId, provider.id),
                        )
                      }
                      type="button"
                    >
                      退出
                    </button>
                  ) : (
                    provider.authTypes.map((type) => (
                      <button
                        className="button small"
                        disabled={Boolean(action)}
                        key={type}
                        onClick={() =>
                          void run(`login:${provider.id}`, () =>
                            window.piarium.loginProvider(
                              props.session.sessionId,
                              provider.id,
                              type,
                            ),
                          )
                        }
                        type="button"
                      >
                        {type === "oauth" ? "OAuth 登录" : "设置 API Key"}
                      </button>
                    ))
                  )}
                </div>
              </section>
            ))}
          </div>
        ) : null}

        {tab === "models" ? (
          <div className="panel-stack">
            <input
              className="panel-search"
              onChange={(event) => setFilter(event.target.value)}
              placeholder="筛选 provider / model"
              value={filter}
            />
            <div className="model-list">
              {models.map((model) => {
                const selected =
                  props.session.model?.provider === model.provider &&
                  props.session.model?.id === model.id;
                return (
                  <button
                    className={`model-row${selected ? " selected" : ""}`}
                    disabled={Boolean(action)}
                    key={`${model.provider}:${model.id}`}
                    onClick={() =>
                      void run(`model:${model.id}`, () =>
                        window.piarium.selectModel(
                          props.session.sessionId,
                          model.provider,
                          model.id,
                        ),
                      )
                    }
                    type="button"
                  >
                    <span>
                      <strong>{model.name}</strong>
                      <small>
                        {model.provider}/{model.id}
                      </small>
                    </span>
                    <span>
                      {selected
                        ? "✓"
                        : model.contextWindow
                          ? `${Math.round(model.contextWindow / 1_000)}k`
                          : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {tab === "packages" ? (
          <div className="panel-stack">
            <form
              className="package-install"
              onSubmit={(event) => {
                event.preventDefault();
                const source = packageSource.trim();
                if (!source) return;
                void run("package-install", async () => {
                  await window.piarium.installPackage(props.session.sessionId, source);
                  setPackageSource("");
                });
              }}
            >
              <input
                onChange={(event) => setPackageSource(event.target.value)}
                placeholder="npm:pi-subagents 或本地路径"
                value={packageSource}
              />
              <button
                className="button small"
                disabled={!packageSource.trim() || Boolean(action)}
                type="submit"
              >
                安装
              </button>
            </form>
            {props.data.packages.map((pkg) => (
              <section className="setting-card" key={pkg.source}>
                <div className="setting-card-heading">
                  <div>
                    <strong>{pkg.name}</strong>
                    <small>{pkg.source}</small>
                  </div>
                </div>
                <div className="button-row">
                  <button
                    className="button small ghost"
                    disabled={Boolean(action)}
                    onClick={() =>
                      void run(`update:${pkg.source}`, () =>
                        window.piarium.updatePackages(props.session.sessionId, pkg.source),
                      )
                    }
                    type="button"
                  >
                    更新
                  </button>
                  <button
                    className="button small danger"
                    disabled={Boolean(action)}
                    onClick={() =>
                      void run(`remove:${pkg.source}`, () =>
                        window.piarium.removePackage(props.session.sessionId, pkg.source),
                      )
                    }
                    type="button"
                  >
                    移除
                  </button>
                </div>
              </section>
            ))}
          </div>
        ) : null}

        {tab === "settings" ? (
          <div className="panel-stack">
            <label className="field-label">
              <span>默认思考级别</span>
              <select
                onChange={(event) =>
                  void run("thinking", () =>
                    window.piarium.updateSettings(props.session.sessionId, {
                      defaultThinkingLevel: event.target.value,
                    }),
                  )
                }
                value={String(globalSettings.defaultThinkingLevel ?? "medium")}
              >
                {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label">
              <span>Steering 队列</span>
              <select
                onChange={(event) =>
                  void run("steering", () =>
                    window.piarium.updateSettings(props.session.sessionId, {
                      steeringMode: event.target.value,
                    }),
                  )
                }
                value={String(globalSettings.steeringMode ?? "all")}
              >
                <option value="all">全部一起投递</option>
                <option value="one-at-a-time">逐条投递</option>
              </select>
            </label>
            <label className="field-label">
              <span>Follow-up 队列</span>
              <select
                onChange={(event) =>
                  void run("follow-up", () =>
                    window.piarium.updateSettings(props.session.sessionId, {
                      followUpMode: event.target.value,
                    }),
                  )
                }
                value={String(globalSettings.followUpMode ?? "one-at-a-time")}
              >
                <option value="all">全部一起投递</option>
                <option value="one-at-a-time">逐条投递</option>
              </select>
            </label>
            {[
              { key: "compactionEnabled", label: "自动压缩上下文" },
              { key: "retryEnabled", label: "请求失败时自动重试" },
            ].map((setting) => (
              <label className="toggle-row" key={setting.key}>
                <span>{setting.label}</span>
                <input
                  checked={globalSettings[setting.key] !== false}
                  onChange={(event) =>
                    void run(setting.key, () =>
                      window.piarium.updateSettings(props.session.sessionId, {
                        [setting.key]: event.target.checked,
                      } as JsonValue),
                    )
                  }
                  type="checkbox"
                />
              </label>
            ))}
            <details className="raw-settings">
              <summary>查看合并后的原始设置</summary>
              <pre>{JSON.stringify(props.data.settings, null, 2)}</pre>
            </details>
          </div>
        ) : null}

        {tab === "commands" ? (
          <div className="command-list">
            {props.data.commands.map((command) => (
              <button
                disabled={Boolean(action)}
                key={`${command.source}:${command.name}`}
                onClick={() =>
                  void run(`command:${command.name}`, () =>
                    window.piarium.executeCommand(props.session.sessionId, `/${command.name}`),
                  )
                }
                type="button"
              >
                <code>/{command.name}</code>
                <span>{command.description || command.source || "Pi command"}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
