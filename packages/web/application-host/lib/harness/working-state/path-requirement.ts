/**
 * Tools that need a real directory: shell or LSP file binding.
 * Text edit/write/apply_patch stay on the WorkingState view until one of
 * these first runs (D-212 / D-213).
 */
const MATERIALIZED_DIRECTORY_TOOLS = new Set([
  "bash",
  "symbols",
  "definition",
  "references",
  "hover",
]);

export function runNeedsMaterializedDirectory(tools: readonly string[]): boolean {
  return tools.some((tool) => MATERIALIZED_DIRECTORY_TOOLS.has(tool));
}
