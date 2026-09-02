// Per-machine relay-host claim. Every Piarium instance on a machine shares
// the same data dir and therefore the same relay signing key / serverId, so if
// two processes run a relay host at once they fight over the single host slot
// at the relay worker (each new connection closes the previous one with
// "4001: Control replaced") and paired devices land on whichever instance won
// last — often a dev/worktree instance running different code.
//
// The claim file (`relay-host.lock` in the shared data dir) makes the contest
// deterministic instead of a network race:
//   - an instance only starts its relay host when there is no LIVE claimant
//     (a dead claimant's stale file is ignored);
//   - explicit user intent (creating a pairing link) claims unconditionally —
//     the instance the user is interacting with must be the one devices reach;
//   - a running host that discovers another live process has claimed backs off
//     instead of reconnecting, which is what ends the replace/reconnect fight.
//
// This is a cooperative claim, not an OS lock: correctness does not depend on
// atomicity (the relay worker still enforces a single host); the claim only
// decides which process KEEPS retrying and which stands down.

/**
 * @param {{
 *   lockFilePath: string,
 *   fs?: typeof import('node:fs'),
 *   process?: NodeJS.Process,
 *   logger?: Pick<Console, 'warn'>,
 * }} deps
 */
const errorCode = (error: unknown): string | null => (
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null
);

export const createRelayHostLock = ({ lockFilePath, fs, process: proc, logger = console }: {
  fs: {
    readFileSync(path: string, encoding: 'utf8'): string;
    unlinkSync(path: string): void;
    writeFileSync(path: string, data: string): void;
  };
  lockFilePath: string;
  logger?: Pick<Console, 'warn'>;
  process: { kill(pid: number, signal: 0): unknown; pid: number };
}) => {
  const fsImpl = fs;
  const selfPid = proc.pid;

  const isPidAlive = (pid: unknown): boolean => {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
    try {
      proc.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but belongs to another user — treat as
      // alive; only ESRCH (no such process) means the claim is stale.
      return errorCode(error) === 'EPERM';
    }
  };

  const readClaim = (): { pid: number } | null => {
    try {
      const raw = fsImpl.readFileSync(lockFilePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const pid = Number(parsed && typeof parsed === 'object' && 'pid' in parsed ? parsed.pid : NaN);
      return Number.isInteger(pid) && pid > 0 ? { pid } : null;
    } catch {
      // Missing file or unparsable content: no valid claim.
      return null;
    }
  };

  const writeClaim = () => {
    try {
      fsImpl.writeFileSync(lockFilePath, JSON.stringify({ pid: selfPid, claimedAt: new Date().toISOString() }));
      return true;
    } catch (error) {
      // An unwritable data dir must not take the relay down with it — fall back
      // to pre-lock behavior (start the host, let the relay worker arbitrate).
      logger.warn(`[Relay] could not write host claim file: ${error instanceof Error ? error.message : error}`);
      return true;
    }
  };

  /** The pid of the current live claimant, or null when the claim is free/stale. */
  const liveClaimantPid = () => {
    const claim = readClaim();
    if (!claim) return null;
    return isPidAlive(claim.pid) ? claim.pid : null;
  };

  /** Claim unless another LIVE process already holds it. Re-claiming our own is a no-op refresh. */
  const tryClaim = () => {
    const holder = liveClaimantPid();
    if (holder !== null && holder !== selfPid) return false;
    return writeClaim();
  };

  /** Unconditional claim — explicit user intent (pairing) overrides any holder. */
  const forceClaim = () => writeClaim();

  /** True while this process is the live claimant. */
  const holdsClaim = () => liveClaimantPid() === selfPid;

  /** Release only our own claim; never delete another process's. */
  const release = () => {
    const claim = readClaim();
    if (!claim || claim.pid !== selfPid) return;
    try {
      fsImpl.unlinkSync(lockFilePath);
    } catch {
      // Already gone or unwritable — nothing to do.
    }
  };

  return { tryClaim, forceClaim, holdsClaim, liveClaimantPid, release };
};
