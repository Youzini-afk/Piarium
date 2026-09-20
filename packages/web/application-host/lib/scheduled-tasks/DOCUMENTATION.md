# Scheduled Tasks module

Server-owned Pi scheduled task runtime, Markdown loops, and HTTP routes.

## Ownership

- GUI-created task definitions and all runtime state live in the Piarium project config owned by `projects/project-config.js`.
- A loop definition lives in its `.agents/loops/*.md` file. Its JSON row is only the scheduler projection and runtime-state record.
- Pi sessions, model selection, thinking, goals, commands, and prompts are executed through `pi-executor.js`; this module has no OpenCode runtime owner or compatibility route.

## Markdown loops

Piarium discovers `~/.agents/loops/*.md` and project `.agents/loops/*.md` from the selected directory upward to its Git worktree root. The nearest project definition wins, then farther project ancestors, then the user definition.

```markdown
---
name: daily-digest
schedule: "0 9 * * *"
enabled: true
model: openai-codex/gpt-5.3-codex
thinking: high
agent: reviewer
timezone: Asia/Shanghai
run_as_goal: true
goal_token_budget: 25000
---
Summarize repository changes since yesterday.
```

`name`, `schedule`, `model`, and the body are required. `enabled` defaults to `false`: merely pulling repository content must not start unattended model runs. `thinking`, `agent`, `run_as_goal`, and `goal_token_budget` map to Pi concepts. OpenCode permission and variant fields are not accepted or synthesized.

Loop identity is the canonical file path, not its name. A same-named GUI task remains a separate JSON-owned task. Renaming a loop changes the existing loop task in place. A malformed file keeps the last good projection and exposes its parse error; removing the file removes only that projection. Higher-precedence malformed files continue to shadow lower definitions, preventing duplicate execution during an edit or merge conflict.

The list route reconciles disk files before returning tasks, and the runtime watches every discovered `.agents/loops` directory (project ancestors plus the user scope) — a Markdown edit, creation, or deletion triggers a debounced resync without anyone opening the task list. The loop editor and enabled toggle use content revisions, so an agent or editor changing the file concurrently produces a conflict instead of being overwritten. Unknown frontmatter keys are preserved by enabled toggles. Runtime state is never written into Markdown.

## Routes

- `GET|PUT|DELETE /api/projects/:projectId/scheduled-tasks`
- `GET|PUT|PATCH|DELETE /api/projects/:projectId/scheduled-tasks/:taskId/loop-file`
- `POST /api/projects/:projectId/scheduled-tasks/:taskId/run`
- `GET /api/piarium/scheduled-tasks/status`
- `GET /api/piarium/events`

## Completion tracking and follow-ups (D-307)

`pi-executor.ts` no longer treats `agent.prompt` acceptance as success. A session-settle tracker
(`session-settle.ts`) is registered before dispatch and observes `agent_start`, `agent_end`,
`agent_settled`, `session.closed`, and `worker.exit`; the run reports success only after the real
session settles, and goal runs additionally inspect the final goal status — `complete` succeeds,
`blocked`/`budgetLimited` fail, `paused` with reason `waiting` is an intentional follow-up wait, and
any other terminal or lost state fails. Failures retain `sessionID` for traceability without writing
`lastSessionId`.

Native follow-ups are implemented under [Stage W / D-307](../../../../../docs/agent-follow-up-design.md):
the `follow_up` tool, the durable follow-up service, and session-level waiting UI reuse the existing
Thread/Run lifecycle, kernel records, and broker admission. Calendar/Markdown tasks remain distinct
from session continuation — a loop always creates new work on its own schedule.
