import { replaceObjectReferences, type ChangeRow, type SqliteDatabase } from "./journal-catalog.js";
import { parseRecoveryState, sameState } from "./journal-files.js";

interface BindingRow {
  checkpoint_id: string;
  journaled_resource_ids_json: string;
  status: string;
  workspace_id: string;
}

const objectHash = (state: ReturnType<typeof parseRecoveryState>): string | null => (
  state.kind === "regular-file" ? state.objectHash : null
);

export const assertIntegrationTurnBinding = (
  database: SqliteDatabase,
  workspaceId: string,
  executionId: string,
): void => {
  const binding = database.prepare(`
    SELECT checkpoint_id, journaled_resource_ids_json, status, workspace_id
    FROM turn_bindings WHERE execution_id = ?
  `).get(executionId) as BindingRow | undefined;
  if (!binding || binding.workspace_id !== workspaceId || binding.status === "incomplete") {
    throw new Error(`Parent turn recovery binding is unavailable: ${executionId}`);
  }
};

export const bindIntegrationOperationToTurn = (
  database: SqliteDatabase,
  input: { workspaceId: string; executionId: string; operationId: string },
): void => {
  const binding = database.prepare(`
    SELECT checkpoint_id, journaled_resource_ids_json, status, workspace_id
    FROM turn_bindings WHERE execution_id = ?
  `).get(input.executionId) as BindingRow | undefined;
  if (!binding || binding.workspace_id !== input.workspaceId || binding.status === "incomplete") {
    throw new Error(`Parent turn recovery binding is unavailable: ${input.executionId}`);
  }
  const rawPaths = JSON.parse(binding.journaled_resource_ids_json) as unknown;
  if (!Array.isArray(rawPaths) || rawPaths.some((entry) => typeof entry !== "string")) {
    throw new Error(`Parent turn recovery paths are malformed: ${input.executionId}`);
  }
  const paths = new Set(rawPaths as string[]);
  const rows = database.prepare(`
    SELECT path, expected_json, target_json, safety_json
    FROM operation_files WHERE operation_id = ? AND phase = 'target-observed'
    ORDER BY ordinal
  `).all(input.operationId) as Array<Pick<ChangeRow, "path"> & {
    expected_json: string | null;
    target_json: string | null;
    safety_json: string | null;
  }>;
  const now = new Date().toISOString();
  for (const row of rows) {
    const before = parseRecoveryState(JSON.parse(row.safety_json ?? row.expected_json ?? "null") as unknown);
    const after = parseRecoveryState(JSON.parse(row.target_json ?? "null") as unknown);
    const existing = database.prepare(`
      SELECT before_json FROM checkpoint_changes WHERE checkpoint_id = ? AND path = ?
    `).get(binding.checkpoint_id, row.path) as { before_json: string } | undefined;
    const firstBefore = existing ? parseRecoveryState(JSON.parse(existing.before_json) as unknown) : before;
    database.prepare(`
      INSERT INTO checkpoint_changes(
        checkpoint_id, path, tool_name, mutation_id, before_json, after_json, created_at, updated_at
      ) VALUES (?, ?, 'thread.merge', ?, ?, ?, ?, ?)
      ON CONFLICT(checkpoint_id, path) DO UPDATE SET
        tool_name = excluded.tool_name,
        mutation_id = excluded.mutation_id,
        after_json = excluded.after_json,
        updated_at = excluded.updated_at
    `).run(
      binding.checkpoint_id,
      row.path,
      input.operationId,
      JSON.stringify(firstBefore),
      JSON.stringify(after),
      now,
      now,
    );
    replaceObjectReferences(database, input.workspaceId, "checkpoint-change", JSON.stringify([binding.checkpoint_id, row.path]), [
      ...(objectHash(firstBefore) ? [{ objectHash: objectHash(firstBefore)!, slot: "before" }] : []),
      ...(objectHash(after) ? [{ objectHash: objectHash(after)!, slot: "after" }] : []),
    ]);
    paths.add(row.path);
  }
  database.prepare(`
    UPDATE turn_bindings SET journaled_resource_ids_json = ? WHERE execution_id = ?
  `).run(JSON.stringify([...paths].sort()), input.executionId);
  const stats = database.prepare(`
    SELECT before_json, after_json FROM checkpoint_changes
    WHERE checkpoint_id = ? AND after_json IS NOT NULL
  `).all(binding.checkpoint_id) as Array<{ before_json: string; after_json: string }>;
  let byteLength = 0;
  let changedPathCount = 0;
  for (const row of stats) {
    const before = parseRecoveryState(JSON.parse(row.before_json) as unknown);
    const after = parseRecoveryState(JSON.parse(row.after_json) as unknown);
    if (sameState(before, after)) continue;
    changedPathCount += 1;
    const beforeBytes = before.kind === "regular-file" ? before.byteLength : 0;
    const afterBytes = after.kind === "regular-file" ? after.byteLength : 0;
    byteLength += Math.max(beforeBytes, afterBytes);
  }
  database.prepare(`UPDATE checkpoints SET changed_path_count = ?, byte_length = ? WHERE id = ?`)
    .run(changedPathCount, byteLength, binding.checkpoint_id);
};
