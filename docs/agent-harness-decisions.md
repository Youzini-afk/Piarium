# Agent harness 决策日志

Status: append-only log kept by the executing agent during agent-harness-plan.md; delete together with the plan

执行 [agent-harness-plan.md](agent-harness-plan.md) 时的判断记录。**做出判断的当下就追加一条**，不要等工作项结束——上下文
压缩后细节会丢，这个文件是压缩之后重新定位的依据。条目只追加，不改写旧条目；要更正就追加一条新的并引用旧编号。

## 条目格式

```text
### D-<编号> · <日期> · <工作项 id>
类型：偏离 | 实验结果 | 问题与解法 | 默认值调整 | 待问
决定：一句话说清做了什么。
原因：为什么这样，而不是参考形状那样。
考虑过的替代：列出并说明为何不选。
影响：动到的文件 / 契约 / 文档 / 其他工作项；需要回写到 agent-harness.md 或 plan 的位置。
状态：已实施 | 待验收 | 待回答
```

`类型：待问` 的条目对应 plan 0.1 里"停下来问"的三类情况；其余类型不需要等待回答，继续工作。

## 条目

### D-001 · 2026-09-03 · 0.1
类型：实验结果
决定：Pi 版本已对齐在 0.84.3，无需变更；计划中"node_modules 为 0.83.0"的描述是写作时的旧状态。
原因：`packages/pi-host/package.json`、`scripts/cloud-runtime.bun.lock`、`docs/security.md` 三处均为 0.84.3，`node_modules` 中 0.84.3 已安装且可用。
考虑过的替代：无。
影响：0.1 的版本对齐步骤直接通过，进入钩子形状复核。所有钩子形状（`before_agent_start` 可返回 `{ message, systemPrompt }`、`session_before_compact` 含 `preparation/branchEntries/reason` 且可返回 `{ compaction, cancel }`、`session_compact` 含 `compactionEntry`、`tool_result` 可替换 `content/details/isError`、`tool_call` 可返回 `{ block, reason }`、`turn_end` 含 `turnIndex/message/toolResults`、`before_provider_request` 含 `payload`、`ToolDefinition` 含 `promptSnippet/promptGuidelines/executionMode`）在 0.84.3 的 `types.d.ts` 中核实成立。`customTools` 同名覆盖由 `workspace-mutation-journal.ts` 的既有实现验证。`SessionBeforeCompactResult` 和 `ToolResultEventResult` 未从顶层包导出，编译期断言改用 `SessionBeforeCompactEvent` / `ToolResultEvent` 的事件形状验证。
状态：已实施
