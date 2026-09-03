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

（尚无条目。）
