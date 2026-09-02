import { describe, expect, it } from 'vitest';

import { createRelayHostLock } from './host-lock.js';

// In-memory fs standing in for the shared data dir.
const makeFakeFs = () => {
  const files = new Map<string, string>();
  return {
    readFileSync: (path: string) => {
      if (!files.has(path)) {
        const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw error;
      }
      return files.get(path) ?? '';
    },
    writeFileSync: (path: string, data: string) => {
      files.set(path, data);
    },
    unlinkSync: (path: string) => {
      files.delete(path);
    },
    peek: (path: string) => files.get(path),
  };
};

// Fake process: `alive` is the set of pids that respond to kill(pid, 0).
const makeFakeProcess = (pid: number, alive = new Set<number>([pid])) => ({
  pid,
  kill: (target: number) => {
    if (!alive.has(target)) {
      const error = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      throw error;
    }
    return true;
  },
});

const LOCK = '/data/relay-host.lock';
const silentLogger = { warn: () => {} };

describe('relay host lock', () => {
  it('claims a free lock and reports holding it', () => {
    const fs = makeFakeFs();
    const lock = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(100), logger: silentLogger });

    expect(lock.tryClaim()).toBe(true);
    expect(lock.holdsClaim()).toBe(true);
    const claim = fs.peek(LOCK);
    if (!claim) throw new Error('Expected relay host claim');
    expect(JSON.parse(claim).pid).toBe(100);
  });

  it('refuses to claim while another LIVE process holds it', () => {
    const fs = makeFakeFs();
    const alive = new Set([100, 200]);
    const first = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(100, alive), logger: silentLogger });
    const second = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(200, alive), logger: silentLogger });

    expect(first.tryClaim()).toBe(true);
    expect(second.tryClaim()).toBe(false);
    expect(second.holdsClaim()).toBe(false);
    expect(second.liveClaimantPid()).toBe(100);
  });

  it('treats a dead claimant as free (stale claim takeover)', () => {
    const fs = makeFakeFs();
    const alive = new Set([200]); // pid 100 is gone
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100 }));
    const lock = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(200, alive), logger: silentLogger });

    expect(lock.liveClaimantPid()).toBe(null);
    expect(lock.tryClaim()).toBe(true);
    expect(lock.holdsClaim()).toBe(true);
  });

  it('forceClaim overrides a live holder; the loser sees the takeover', () => {
    const fs = makeFakeFs();
    const alive = new Set([100, 200]);
    const first = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(100, alive), logger: silentLogger });
    const second = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(200, alive), logger: silentLogger });

    expect(first.tryClaim()).toBe(true);
    expect(second.forceClaim()).toBe(true);
    expect(second.holdsClaim()).toBe(true);
    expect(first.holdsClaim()).toBe(false);
    expect(first.liveClaimantPid()).toBe(200);
  });

  it('release removes only its own claim', () => {
    const fs = makeFakeFs();
    const alive = new Set([100, 200]);
    const first = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(100, alive), logger: silentLogger });
    const second = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(200, alive), logger: silentLogger });

    expect(first.tryClaim()).toBe(true);
    second.release(); // not the holder — must be a no-op
    expect(first.holdsClaim()).toBe(true);

    first.release();
    expect(fs.peek(LOCK)).toBeUndefined();
    expect(first.liveClaimantPid()).toBe(null);
  });

  it('treats an unparsable claim file as free', () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, 'not-json');
    const lock = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(100), logger: silentLogger });

    expect(lock.liveClaimantPid()).toBe(null);
    expect(lock.tryClaim()).toBe(true);
  });

  it('an EPERM kill probe still counts as a live holder', () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100 }));
    const proc = {
      pid: 200,
      kill: () => {
        const error = Object.assign(new Error('EPERM'), { code: 'EPERM' });
        throw error;
      },
    };
    const lock = createRelayHostLock({ lockFilePath: LOCK, fs, process: proc, logger: silentLogger });

    expect(lock.liveClaimantPid()).toBe(100);
    expect(lock.tryClaim()).toBe(false);
  });
});
