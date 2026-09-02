/**
 * Atomic directory-generation commit helper.
 *
 * Extracted from build-web-assets.mjs so the commit/rollback state machine
 * is testable without running Vite or touching product directories.
 *
 * Contract:
 * - The helper only touches the three exact directories passed in.
 * - `rename` and `removeDir` are injectable so tests can simulate EPERM,
 *   EBUSY, and other filesystem failures without real I/O.
 * - No retries, sleeps, or global locks. The caller owns retry policy.
 *
 * State machine:
 * 1. If active exists: rename active → backup.
 *    - EPERM/EBUSY/EACCES → active is still live; clean candidate; return failure.
 *    - ENOENT → active was already absent; proceed to step 2.
 * 2. Rename candidate → active.
 *    - If this fails and active does not exist, restore backup → active.
 *      - If restore also fails, return both primary and recovery errors.
 * 3. Remove backup (best-effort).
 *    - If cleanup fails after candidate committed, report success with a
 *      backupCleanupWarning so the caller can log it. Do NOT pretend the
 *      new generation was rolled back.
 */

/**
 * @typedef {Object} CommitWebAssetGenerationOptions
 * @property {string} activeDir
 * @property {string} candidateDir
 * @property {string} backupDir
 * @property {(src: string, dest: string) => Promise<void>} rename
 * @property {(target: string) => Promise<void>} removeDir
 * @property {(target: string) => Promise<boolean>} exists
 */

/**
 * @typedef {{ ok: true, backupCleanupWarning?: string } | { ok: false, error: Error, recoveryError?: Error }} CommitWebAssetGenerationResult
 */

const isLockError = (error) => {
  const code = error && typeof error === 'object' ? error.code : undefined;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
};

const failure = (message, cause) => new Error(message, { cause });

/**
 * @param {CommitWebAssetGenerationOptions} options
 * @returns {Promise<CommitWebAssetGenerationResult>}
 */
export const commitWebAssetGeneration = async ({
  activeDir,
  candidateDir,
  backupDir,
  rename,
  removeDir,
  exists,
}) => {
  // Step 1: Move active → backup (if active exists).
  const activeExists = await exists(activeDir);
  if (activeExists) {
    try {
      await rename(activeDir, backupDir);
    } catch (error) {
      if (isLockError(error)) {
        // Active is still live. Clean candidate and return a clear failure.
        await removeDir(candidateDir).catch(() => undefined);
        return {
          ok: false,
          error: failure(
            `Packaged Web assets are in use at ${activeDir}. Close the bundled Desktop process and retry.`,
            error,
          ),
        };
      }
      // ENOENT means active disappeared between stat and rename — proceed.
      // Any other error is unexpected; clean candidate and fail.
      if (error?.code !== 'ENOENT') {
        await removeDir(candidateDir).catch(() => undefined);
        return {
          ok: false,
          error: failure('Failed to move active generation to backup', error),
        };
      }
    }
  }

  // Step 2: Move candidate → active.
  try {
    await rename(candidateDir, activeDir);
  } catch (commitError) {
    // Candidate commit failed. If active doesn't exist, try to restore backup.
    const activeStillExists = await exists(activeDir);
    if (!activeStillExists) {
      const backupExists = await exists(backupDir);
      if (backupExists) {
        try {
          await rename(backupDir, activeDir);
        } catch (recoveryError) {
          // Recovery failed — do NOT delete backup. Clean orphaned candidate.
          // Return both errors so the caller has full diagnostic information.
          await removeDir(candidateDir).catch(() => undefined);
          return {
            ok: false,
            error: failure('Failed to commit candidate generation', commitError),
            recoveryError: failure('Failed to restore backup generation', recoveryError),
          };
        }
      }
    }
    // Clean up orphaned candidate if it still exists.
    await removeDir(candidateDir).catch(() => undefined);
    return {
      ok: false,
      error: failure('Failed to commit candidate generation', commitError),
    };
  }

  // Step 3: Clean up backup (best-effort, non-fatal).
  const backupExists = await exists(backupDir);
  if (backupExists) {
    try {
      await removeDir(backupDir);
    } catch (cleanupError) {
      // Candidate is already committed. Don't pretend we rolled back.
      return {
        ok: true,
        backupCleanupWarning: `Old Web asset backup could not be removed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      };
    }
  }

  return { ok: true };
};
