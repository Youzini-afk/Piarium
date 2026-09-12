/**
 * Copy-on-write (reflink) file copy with a real-fallback contract (D-244).
 *
 * `COPYFILE_FICLONE` silently degrades to a full copy when the filesystem
 * lacks block cloning, so callers cannot tell whether sharing happened.
 * This helper tries `COPYFILE_FICLONE_FORCE` first — a real reflink or a
 * real failure — and falls back to a plain copy, returning which backend
 * actually ran so callers and tests see the truth.
 *
 * D-244 rework (D-250): `EACCES`/`EPERM` are permission or policy errors,
 * not "unsupported reflink" signals — they must propagate so the caller
 * knows the copy was denied rather than silently degrading to a full copy.
 * Only platform-level "clone not supported" or "cross-volume" errors
 * (ENOSYS/ENOTSUP/EOPNOTSUPP/EINVAL/EXDEV) fall back to a plain copy.
 */

import fs from "node:fs";
import { createHash } from "node:crypto";

export type ReflinkBackend = "reflink" | "copy";

// A missing source is a real error, not an unsupported-filesystem signal, so
// ENOENT is deliberately absent: the caller should see the original failure.
// EACCES/EPERM are permission/policy errors — they must propagate (D-250).
const REFLINK_UNSUPPORTED_CODES = new Set([
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EINVAL",
  "EXDEV",
]);

/**
 * Copy `source` to `destination`, preferring a filesystem reflink.
 * Returns "reflink" when extents are shared, "copy" when the platform or
 * filesystem cannot clone blocks and a full byte copy ran instead.
 */
export const copyFilePreferReflink = async (
  source: string,
  destination: string,
  fsPromises: Pick<typeof fs.promises, "copyFile"> = fs.promises,
): Promise<ReflinkBackend> => {
  try {
    await fsPromises.copyFile(source, destination, fs.constants.COPYFILE_FICLONE_FORCE);
    return "reflink";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code ?? "";
    if (!REFLINK_UNSUPPORTED_CODES.has(code)) throw error;
    await fsPromises.copyFile(source, destination);
    return "copy";
  }
};

/**
 * Verify a content object's integrity before reflinking/copying it into an
 * execution directory (D-250). A corrupt object must not enter the execution
 * directory — the caller must see the verification failure rather than
 * materialize damaged bytes.
 */
export const verifyObjectIntegrity = async (
  objectPath: string,
  expectedHash: string,
  expectedByteLength: number,
  fsPromises: Pick<typeof fs.promises, "readFile" | "stat"> = fs.promises,
): Promise<void> => {
  const stat = await fsPromises.stat(objectPath);
  if (stat.size !== expectedByteLength) {
    throw new Error(`Object ${objectPath} is corrupt: expected ${expectedByteLength} bytes, got ${stat.size}`);
  }
  const bytes = await fsPromises.readFile(objectPath);
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  // Object hashes may carry a "sha256-" prefix (content-addressed store format);
  // strip it before comparing so the integrity check works with both forms.
  const normalizedExpected = expectedHash.startsWith("sha256-") ? expectedHash.slice(7) : expectedHash;
  if (actualHash !== normalizedExpected) {
    throw new Error(`Object ${objectPath} is corrupt: expected hash ${normalizedExpected}, got ${actualHash}`);
  }
};
