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

The list route reconciles disk files before returning tasks. The loop editor and enabled toggle use content revisions, so an agent or editor changing the file concurrently produces a conflict instead of being overwritten. Unknown frontmatter keys are preserved by enabled toggles. Runtime state is never written into Markdown.

## Routes

- `GET|PUT|DELETE /api/projects/:projectId/scheduled-tasks`
- `GET|PUT|PATCH|DELETE /api/projects/:projectId/scheduled-tasks/:taskId/loop-file`
- `POST /api/projects/:projectId/scheduled-tasks/:taskId/run`
- `GET /api/piarium/scheduled-tasks/status`
- `GET /api/piarium/events`
