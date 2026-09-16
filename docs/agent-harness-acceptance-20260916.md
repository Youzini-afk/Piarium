# D-284–D-286 验收记录

Status: accepted after implementation corrections; evidence and unobserved environments recorded below

Last updated: 2026-09-16

## 结论

D-284 的请求级上下文预算与后台固定摘要、D-285 的任务线程与定向协作、D-286 的
`inherit` / `continue` / `fresh` 输入续接已经进入公开生产链。本轮不是以原执行报告或测试数量验收；审查先用并发、失败、
身份和固定视图反例重新打开交付，再修复真实状态转换，最后沿公开 Pi / Host / Rust consumer 复验。

阶段 R 的权威边界没有改变：Rust 仍是 WorkingState、Recovery、文件与物化的单一生产权威；TypeScript Host 负责产品编排，
Pi 负责模型请求、会话历史与 provider。没有恢复 TS writer、keeper、第二历史库或旧 backend fallback。

## 收口后的生产行为

### 上下文与原文

- 每个实际模型请求都经过 Pi request boundary；工具回合内的继续请求也在发送前核对真实输入、输出预留和模型窗口。
- 后台摘要固定分支、模型、压缩边界和 `firstKeptEntryId`。前台继续追加；只有请求需要空间时才提交候选。截断、取消、
  空摘要、工具调用或无进展摘要均不改历史。
- `session_compact` 后从 Pi 实际保留区间提取 observation receipt、材料修订和 Git 观察。仍有完整原文依据的 cursor 保留，
  失去任一前置原文的增量 cursor 重建。候选 ready 不重置观察。
- Zone 2 只投递变化的计划/笔记/知识/线程事实，且只为最终响应中完整出现的材料生成 receipt；预算折叠不冒充已送达。
  shell、diagnostics、thread view 都在响应投递确认后推进 cursor。
- `inherit` 从 Pi 当前提交上下文捕获已保留摘要、原文、合法工具配对、图片和需要的完整输出正文；未完成工具调用、父句柄权限和
  派发后的新消息不会进入子输入。`fresh` 创建新 Run 与新会话，但同一 Thread 的旧 Run 可经 `history({run})` 授权分页回读；
  父线程和兄弟线程历史仍不可见。

### Thread、消息与执行

- Run admission 与 Run 发布在同一 catalog mutation 中完成；dispatch、dequeue、lost resume、continue/fresh、转换和 review
  共用同根执行名额。只有真实 dependency wait 让出模型执行名额，重新进入下一模型请求前必须原子重新准入。
- `inform` 使用 Pi 持久、非唤醒的 custom-message 输入；`request` 使用带 native receipt 的执行入口。Host 从 session binding
  推导发送者，`requestId` 绑定双方、正文、类型、`replyTo` 和 continue/fresh；并发重试不会重复投递或起 Run。
- 回复只在实际送达后解析原请求；无关兄弟、普通 inform ID 和失败投递不能解除等待。held 输入在被 Pi Run 接受后才确认。
- UI 为 Ask/Fresh/Note 生成稳定 `requestId`，网络失败后的同正文重试沿同一消息操作继续。`send` 工具返回
  `messageId`、delivery 和 `runId`，区分接受、送达、排队与执行。
- 每个 Run 冻结实际 model、tools、permissions、scope、worktree、prompt fragment 和 input origin；spawn、dequeue、
  lost resume、restore、continue/fresh 均消费该 Run 的冻结配置，不从长期 Thread 字段临时重建执行权限。
- 历史 R1 report/result 在 R2 运行和失败后仍按 Run / result revision 可读；默认 Thread 指针只描述当前执行。

### 物化 baseline 更新

- 虚拟线程沿一次 `writeRevision` CAS 三方 rebase；冲突返回调用方处理，不做固定次数重试。
- 已物化线程创建 staging branch，以明确 branch/path/revision 读取三方正文，通过 Rust durable Integration 条件写目录，
  提交前重新 capture 整个执行目录，再 CAS 子 branch。父子干净修改合并，分歧保留 child bytes 并显式报告。
- temporary object owner 转交给 owning recovery writer grant；owning/execution workspace 分开时不会因 JS 字段顺序或错误 grant
  产生 `recovery owner is not valid`。
- Registry 持久化 pending handoff。bind、spawn、continue、settle、partial publish、restore、reclaim 和 lost resume 在完成或
  对账前不得越过它；启动恢复先扫描并恢复 handoff。删除 Thread 会释放 staging branch，失败或外部漂移保留现场与 receipt。
- 旧 published result 仍绑定原 baseline/root，不因当前 child branch rebase 改写。

## 决定性验证

- Host 状态机与 native 路径：materialized baseline 4、baseline rebase 6、storage adapter 6、thread runtime 79；本轮组合的
  observation/context、admission、message identity、wait re-admission、fixed delivery 等 9 个文件共 115 项，修正一处错误断言后
  相关文件复验通过。
- 真 Pi + faux provider：`inherit` 捕获并实际进入 child provider 输入；fresh Run 调用 `history(run)` 读回旧 Run 原始工具正文；
  request-level compaction、历史分页、Thread 真实会话和 native WorkingState 集成共 44 项通过。faux 证明调用链，不证明模型质量。
- Protocol 定向 15 项、UI 行为/i18n 7 项通过。protocol、pi-host、Application Host tests 和 UI TypeScript 检查通过。
- `git diff --check` 通过。没有用全仓重复测试替代上述反例。

## 未外推的环境事实

- 尚未据此宣称真实付费 provider 的摘要质量、缓存收益或多 provider 排队延迟。
- 本轮没有重新跑完整 Electron packaged 点击链、macOS/Linux 真机或物理断电；Rust 中断、Host 启动对账和 Windows release
  native 子进程是当前故障证据。
- 两个未跟踪的本地 kernel 构建产物不是本次交付文件。
