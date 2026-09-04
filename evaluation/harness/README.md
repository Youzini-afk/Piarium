# Agent Harness Replay Set

This is a small, manual paired replay set for deciding whether behavior-changing
Harness features should become defaults. It intentionally does not call a model
or mutate user settings by itself.

Each case comes from a real Piarium change and pins both the repository state
before the task and the known delivered change. The reference commit is evidence
for reviewers, not an exact-patch oracle: a different implementation can pass if
it meets the acceptance criteria.

Run both variants with the same provider, model, starting commit, prompt, and
machine:

- `native`: memory shadow and delegation are off; use the ordinary Pi path.
- `harness-shadow`: enable the behavior under evaluation, currently memory
  shadow and the Harness team, without compaction takeover.

Record only three aggregate metrics: success, total tokens, and human
interventions. A failed run also receives one diagnostic category. Deterministic
security, crash, recovery, and storage invariants stay in E2E/fault-injection
tests and are not judged from replay scores.

```powershell
node scripts/harness-replay.mjs validate
node scripts/harness-replay.mjs show context-shadow-runtime
node scripts/harness-replay.mjs new-run --case context-shadow-runtime --variant native --model openai/gpt-5 --pair trial-1 --output D:\replays\context-native
node scripts/harness-replay.mjs record --run D:\replays\context-native\run.json --success pass --input-tokens 12000 --output-tokens 8000 --cache-read-tokens 108000 --interventions 1
node scripts/harness-replay.mjs summary --results D:\replays
```

`new-run` only writes a run record and prints the base commit, prompt, and
acceptance criteria. Preparing a checkout and starting a paid model remain
explicit operator actions until Piarium has a per-session Harness profile
override; changing global settings behind the user's back is not an acceptable
automation shortcut.
