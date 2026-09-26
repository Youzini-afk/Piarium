# 决策分卷：运行时可靠性与多项目工作区

范围：RR 专项（聊天断连追赶、可靠停止、Agent 工作上下文、shell 边界、多项目检索、出站联网、跨层故障注入）的决策。

本卷是 [agent-harness-decisions.md](../agent-harness-decisions.md) 的分卷；条目只追加、不改写，索引状态以总索引为准。

### D-328 · 2026-09-26 · RR1
类型：问题与解法
决定：断连恢复改为"传输层自动重连 + 只读权威重同步"。`PiRuntimeClient` 上报 `onConnectionLost`；UI 连接监督器按退避（500ms 起、15s 封顶、jitter）重建连接，成功后广播 reconnected；store 对每个已打开会话执行 `session.snapshot` + 已加载 scope 的 `session.entries` + `session.stats` 重读。`session.snapshot` 响应携带 `eventWatermark`（HostController 序列在读取时刻的值）、`liveAssistant`（`agent.state.streamingMessage` 投影）和 `pendingToolCallIds`。重同步期间会话事件缓冲，回放时丢弃水位内同 worker 旧事件，水位外与新 worker 事件正常应用。序号缺口触发同一重同步。
原因：`PiRuntimeClient` 是单次连接——关闭后清 listeners/序列状态、下次请求才懒重连，断线期间事件全部丢失。只重连不补读会造成 UI 永远停在断开时刻（E11）。快照水位是 HostController 与 SessionHost 同线程这一事实提供的免费一致性切点：不需要锁、不需要事件回放日志。
考虑过的替代：事件持久化回放（需要 Host 侧事件日志与游标协议，成本高且引入新的持久化面）；全量 session.entries 无水位重读再逐条 reconcile（能工作但无法判断在飞 liveAssistant/tool 状态，仍可能把旧 UI 态当新事实）；沿用 seq 比对但要求 Host 单调重发（重复 entry 会引发 UI 重复项，而去重键本身依赖 entry id，成本接近水位）。
影响：`protocol` 的 `SessionSnapshot` 增 `eventWatermark`/`liveAssistant`/`pendingToolCallIds`（均为可选，旧 host 省略则客户端按无水位回放）；`runtime-client` 增 `onConnectionLost`/`PiRuntimeRequestTimeoutError`/`RuntimeSequenceGap` 导出；`pi-host` `session.snapshot` 铸水位并投影在飞消息/工具调用；`ui` 连接监督器与 store 缓冲/水位逻辑。RR6 需补真实桌面断网纵切。
状态：已实施

### D-329 · 2026-09-26 · RR1
类型：问题与解法
决定：重写 `3044800b` 的停止语义。停止请求生命周期显式为 `requested`（本地已冻结渲染并发出 RPC）→ `accepted`（host 返回 `aborted:true`）→ settled（`agent_settled`/空闲快照/`session.closed`/`worker.exited`/`reset` 任一权威终态清除标记）。`agent.abort` 的 AbortError/`PiRuntimeAmbiguousRequestError`/`PiRuntimeRequestTimeoutError` 归为 `unknown`——只证明应答没到，不证明远端拒绝了停止——此时触发权威重同步并返回 `false`，不展示为成功取消。视觉冻结用 `stoppedAssistant` 快照实现：渲染层读取冻结副本，底层 `liveAssistant` 仍按真实事件更新，迟到的 provider chunk 保留在状态中而不在视图中续流；终态到达后视图回切到权威内容。非传输类错误照常上报 `commitError`。
原因：`3044800b` 把 `manuallyAbortingSessionIds` 当永久过滤器，既把 abort 应答的 AbortError 当成功，又让集合在 `reset()` 后存活到下一 Run（E12）。这掩盖了真实错误（远端拒绝停止/传输失败），且丢失的 stop 回执被计为成功。
考虑过的替代：保留事件屏蔽但改在 settle 后清理（仍丢真实 chunk，且 settled 未到就永远不一致）；乐观地把 AbortError 当成功（计划明确禁止）；冻结渲染但不记 `stopState`（无法区分"正在停"与"停成功/未知"）。
影响：`usePiSessionStore` 停止请求 Map/冻结视图/清算路径；`PiChatView` 以 `stoppedAssistant ?? liveAssistant` 渲染；`agent.abort` 加 10s 超时以产出 typed timeout；reset/closed/exited/agent_start 均清算。真实远端拒绝（`aborted:false`）立即解除冻结。
状态：已实施
