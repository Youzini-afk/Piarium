# OpenChamber-to-Pi migration contract

## Authoritative source and workspace boundary

Piarium adopts the maintainer's OpenChamber fork, not a pristine upstream checkout:

- repository: `https://github.com/Youzini-afk/openchamber`;
- reviewed clean source commit: `f551150e57de87858383dd62f45462189adf4125`;
- that commit includes the maintainer's custom history and the reviewed upstream merge;
- copied OpenChamber material remains subject to its MIT license and copyright notice.

Every OpenChamber source worktree is read-only for this project. Imports are produced from the
specified commit tree; all copies, deletions, rewrites, branches, commits, and pushes happen only in
`D:\project\opencr\Piarium`. Tracked `.env`, tool-specific agent directories, stale CI/release
identity, and OpenChamber/OpenCode branding are not blindly copied into release artifacts.

## Non-regression contract

The following fork capabilities are product requirements, not incidental patches:

- custom provider configuration, model discovery, API-key and OAuth flows;
- remote/cloud connection, pairing, relay, notifications, tray behavior, and client permissions;
- workspace files, Git, terminal containment, external-access auditing, and allowed directories;
- session queues, delayed child-session materialization, parent/subagent visibility, archive restore,
  revert/fork/timeline, and workspace checkpoints;
- Magic Context, orchestration/OpenAgent surfaces, voice settings, and extension management;
- Electron, web/PWA, mobile, and VS Code surfaces where the fork supports them.

An upstream or Pi implementation may replace a fork implementation only after focused review shows
equivalent user behavior, persistence, security boundaries, platform support, and tests. Partial
equivalence is supplemented; a materially divergent implementation is not adopted.

## Direct Pi-native refactor

OpenChamber currently exposes platform capabilities through `RuntimeAPIs`, while its conversation
sync, server lifecycle, session features, provider pages, scheduled tasks, and control service use
OpenCode SDK/HTTP types directly. Piarium does not preserve those contracts as a second permanent
layer. Inside the copied Piarium tree it will:

1. define one canonical set of Piarium-owned Pi domain types;
2. rewrite session/message/event synchronization and UI stores to consume those types;
3. rewrite provider/model/auth, agent, command, tool, permission, question, scheduling, and control
   flows against the existing Pi host protocol;
4. retain the fork's platform and product services while changing their engine data source;
5. delete OpenCode lifecycle/proxy/watcher/configuration/downloaded CLI and dead SDK-dependent code;
6. remove `@opencode-ai/sdk` after the last real consumer is migrated.

There is one runtime boundary between trusted application services and isolated Pi workers. There
is no OpenCode-shaped compatibility server layered on top of another Pi adapter.

Recovery integrates at OpenChamber's shared `revertToMessage` action so message menus, timeline,
slash commands, and reverted-message dock stay coherent. The default policy is conversation only,
conversation + files, or always ask; detailed recovery management lives in the right sidebar and
settings.
