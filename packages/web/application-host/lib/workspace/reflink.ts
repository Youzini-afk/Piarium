/**
 * Copy-on-write (reflink) file copy with a real-fallback contract (D-244).
 *
 * `COPYFILE_FICLONE` silently degrades to a full copy when the filesystem
 * lacks block cloning, so callers cannot tell whether sharing happened.
 * This helper tries `COPYFILE_FICLONE_FORCE` first — a real reflink or a
 * real failure — and falls back to a plain copy, returning which backend
 * actually ran so callers and tests see the truth.
 */

import fs from "node:fs";

export type ReflinkBackend = "reflink" | "copy";

// A missing source is a real error, not an unsupported-filesystem signal, so
// ENOENT is deliberately absent: the caller should see the original failure.
const REFLINK_UNSUPPORTED_CODES = new Set([
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EINVAL",
  "EPERM",
  "EACCES",
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
