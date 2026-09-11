/**
 * Tools that need a real directory: shell, text mutation, or LSP file binding.
 * Isolated Runs without these stay on the WorkingState view (D-212).
 */
const MATERIALIZED_DIRECTORY_TOOLS = new Set([
  "bash",
  "edit",
  "write",
  "apply_patch",
  "symbols",
  "definition",
  "references",
  "hover",
]);

export function runNeedsMaterializedDirectory(tools: readonly string[]): boolean {
  return tools.some((tool) => MATERIALIZED_DIRECTORY_TOOLS.has(tool));
}
