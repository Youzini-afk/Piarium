import path from "node:path";
import { RecoveryPrimitiveError } from "./errors.js";

/** Resolve a content-addressed object without exposing the storage catalog. */
export const objectPath = (root: string, objectHash: string): string => {
  const match = /^sha256-([0-9a-f]{64})$/u.exec(objectHash);
  if (!match) throw new RecoveryPrimitiveError("checkpoint-corrupt", `Recovery object hash is malformed: ${objectHash}`);
  return path.join(root, "objects", match[1]!.slice(0, 2), match[1]!.slice(2));
};
