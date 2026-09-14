import type { KernelComputeInput, KernelComputeOptions, KernelComputeResult } from "../../kernel/compute-runner.js";
/** Private read-only system boundary. Resource identities are supplied by the
 * store, never by a model query or by a mutable current-directory global. */
export type WorkingStateFileQuery = Omit<KernelComputeInput,"workspaceId"|"pinId"|"rootId"|"objects"|"operation"> & {
  operation: "read"|"bytes"|"list"|"search"|"structure"|"chunks";
};
export type { KernelComputeOptions as WorkingStateQueryOptions, KernelComputeResult as WorkingStateQueryResult };
