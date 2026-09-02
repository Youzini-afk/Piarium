# Pi session automation

Goal continuation and post-turn assistance run against Piarium's public Pi
runtime contract. They do not call OpenCode endpoints and do not maintain a
second session model.

## State ownership

`@piarium/pi-host` stores `PiSessionFeatureState` as append-only custom
entries named `piarium.session-features/v1` in the Pi session JSONL. The
entries do not participate in model context. Because each update is a normal
tree entry, Goal and Assist states follow conversation branches and are restored
by Pi navigation.

The renderer receives the state on every `session.snapshot` and mutates it
through `session.features.mutate`. The broker and host both parse this union
into a narrow payload before forwarding it.

## Goal loop

Starting a goal records the objective and the current cumulative Pi token
count as its baseline before the first prompt is dispatched. While the goal
is active, the hidden Pi host extension appends the objective to the effective
system prompt through `before_agent_start`.

After `agent_settled`, the server waits for the quiet window and reads a fresh
snapshot, branch entries, stats, and feature state from the broker. It then:

1. accounts `session.stats.tokens.total - goal.tokenBaseline`;
2. applies hard stops for errors, aborts, token budget, and the continuation
   cap;
3. asks the user's small model to return `continue`, `complete`, or `blocked`;
4. requires three consecutive blocked verdicts and stops after two
   consecutive audit failures;
5. persists progress before dispatching the next `agent.prompt`.

Goal-ID guards in the host reject a delayed audit after the user has replaced
or cleared the goal. The tail entry is checked again after the model call so a
new user message wins over an automatic continuation. Per-turn completion
notifications are suppressed while the goal is active; a settled goal sends
one final completion or attention notification.

## Recap and suggestion

After an ordinary settled turn remains quiet, the small model receives only
the latest user/assistant exchange. The resulting recap and suggested next
message are stored with the assistant entry ID. The renderer shows them only
while that entry is still the latest completed assistant reply, so a new user
message invalidates stale assistance without a clearing write.

## Tests

- `packages/pi-host/test/session-features.test.ts` covers persistence,
  branching, stale writes, and the Goal prompt hook.
- `packages/web/application-host/lib/pi-session-automation/runtime.test.js` covers Goal
  settlement/continuation and Assist writes.
- `packages/runtime-broker/test/runtime-broker.test.ts` exercises the feature
  RPC through real catalog and session workers.
