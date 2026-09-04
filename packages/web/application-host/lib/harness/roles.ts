/**
 * Role catalog — re-exported from @piarium/protocol.
 *
 * Design: agent-harness.md §9.2.2
 * Plan: agent-harness-plan.md §3.6
 *
 * The catalog itself lives in the protocol package because pi-host needs it
 * too: the `dispatch` tool builds its team prompt from the resolved roles
 * and rejects roles whose slot is unconfigured, which has to happen on the
 * worker side where the frozen session settings live.
 */

export {
  type RoleId,
  type WorktreeMode,
  type RoleDefinition,
  type ResolvedRole,
  ROLE_DEFINITIONS,
  isRoleId,
  resolveRoles,
  buildTeamPrompt,
} from "@piarium/protocol";
