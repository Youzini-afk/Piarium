/**
 * Execution presets — re-exported from @piarium/protocol.
 *
 * Design: agent-harness.md §9.2.2 / D-285
 * Plan: agent-harness-plan.md §3.18A
 *
 * The catalog itself lives in the protocol package because pi-host needs it
 * too: the `dispatch` tool builds its team prompt from the resolved presets
 * and rejects presets whose slot is unconfigured, which has to happen on the
 * worker side where the frozen session settings live.
 */

export {
  type PresetId,
  type PresetWorktree,
  type ExecutionPreset,
  type ResolvedPreset,
  EXECUTION_PRESETS,
  isPresetId,
  resolvePresets,
  buildTeamPrompt,
} from "@piarium/protocol";
