import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitWebAssetGeneration } from './commit-web-asset-generation.mjs';

// ---------------------------------------------------------------------------
// Fault-injection harness — a tiny in-memory filesystem that records every
// operation and can simulate EPERM, EBUSY, ENOENT, or generic failures at
// any step. No real I/O.
// ---------------------------------------------------------------------------

class FakeFs {
  constructor() {
    this.dirs = new Set();
    this.renameCalls = [];
    this.removeCalls = [];
    this.failOnRename = null; // { fromStartsWith?, error }
    this.failOnRemove = null;
  }

  exists(target) {
    return Promise.resolve(this.dirs.has(target));
  }

  rename(src, dest) {
    this.renameCalls.push({ src, dest });
    if (this.failOnRename) {
      const { fromStartsWith, error } = this.failOnRename;
      if (!fromStartsWith || src.startsWith(fromStartsWith)) {
        return Promise.reject(error);
      }
    }
    if (!this.dirs.has(src)) {
      const err = new Error(`ENOENT: ${src}`);
      err.code = 'ENOENT';
      return Promise.reject(err);
    }
    this.dirs.delete(src);
    this.dirs.add(dest);
    return Promise.resolve();
  }

  removeDir(target) {
    this.removeCalls.push({ target });
    if (this.failOnRemove) {
      const { targetMatches, error } = this.failOnRemove;
      if (!targetMatches || target === targetMatches) {
        return Promise.reject(error);
      }
    }
    this.dirs.delete(target);
    return Promise.resolve();
  }

  // Helpers to set up state
  createDir(target) { this.dirs.add(target); }
  deleteDir(target) { this.dirs.delete(target); }
}

const lockError = (code = 'EPERM') => {
  const err = new Error(`${code}: operation not permitted`);
  err.code = code;
  return err;
};

const enoentError = () => {
  const err = new Error('ENOENT: no such file or directory');
  err.code = 'ENOENT';
  return err;
};

// ---------------------------------------------------------------------------
// 1. active exists, candidate complete: active → backup, candidate → active,
//    backup cleaned.
// ---------------------------------------------------------------------------

test('commit: active exists, candidate complete — active→backup, candidate→active, backup cleaned', async () => {
  const fs = new FakeFs();
  const active = '/res/web-dist';
  const candidate = '/res/web-dist-staging-123';
  const backup = '/res/web-dist-backup-123';
  fs.createDir(active);
  fs.createDir(candidate);

  const result = await commitWebAssetGeneration({
    activeDir: active, candidateDir: candidate, backupDir: backup,
    rename: (s, d) => fs.rename(s, d),
    removeDir: (t) => fs.removeDir(t),
    exists: (t) => fs.exists(t),
  });

  assert.equal(result.ok, true);
  assert.equal(fs.dirs.has(active), true, 'candidate should now be active');
  assert.equal(fs.dirs.has(backup), false, 'backup should be cleaned');
  assert.equal(fs.dirs.has(candidate), false, 'candidate should be consumed');
  assert.equal(fs.renameCalls.length, 2, 'two renames: active→backup, candidate→active');
  assert.equal(fs.removeCalls.length, 1, 'one remove: backup cleanup');
});

// ---------------------------------------------------------------------------
// 2. active rename fails with EPERM/EBUSY: old active preserved, candidate
//    cleaned, clear failure returned.
// ---------------------------------------------------------------------------

test('commit: active rename EPERM — active preserved, candidate cleaned, clear failure', async () => {
  const fs = new FakeFs();
  const active = '/res/web-dist';
  const candidate = '/res/web-dist-staging-123';
  const backup = '/res/web-dist-backup-123';
  fs.createDir(active);
  fs.createDir(candidate);
  fs.failOnRename = { fromStartsWith: active, error: lockError('EPERM') };

  const result = await commitWebAssetGeneration({
    activeDir: active, candidateDir: candidate, backupDir: backup,
    rename: (s, d) => fs.rename(s, d),
    removeDir: (t) => fs.removeDir(t),
    exists: (t) => fs.exists(t),
  });

  assert.equal(result.ok, false);
  assert.ok(result.error.message.includes('in use'), `error should mention "in use": ${result.error.message}`);
  assert.equal(fs.dirs.has(active), true, 'active should still be the old generation');
  assert.equal(fs.dirs.has(candidate), false, 'candidate should be cleaned');
  assert.equal(fs.dirs.has(backup), false, 'backup should not exist');
  assert.equal(fs.removeCalls.length, 1, 'candidate should be removed');
  assert.equal(fs.removeCalls[0].target, candidate);
});

test('commit: active rename EBUSY — active preserved, candidate cleaned', async () => {
  const fs = new FakeFs();
  const active = '/res/web-dist';
  const candidate = '/res/web-dist-staging-456';
  const backup = '/res/web-dist-backup-456';
  fs.createDir(active);
  fs.createDir(candidate);
  fs.failOnRename = { fromStartsWith: active, error: lockError('EBUSY') };

  const result = await commitWebAssetGeneration({
    activeDir: active, candidateDir: candidate, backupDir: backup,
    rename: (s, d) => fs.rename(s, d),
    removeDir: (t) => fs.removeDir(t),
    exists: (t) => fs.exists(t),
  });

  assert.equal(result.ok, false);
  assert.equal(fs.dirs.has(active), true, 'old active preserved');
  assert.equal(fs.dirs.has(candidate), false, 'candidate cleaned');
});

// ---------------------------------------------------------------------------
// 3. active → backup succeeds, but candidate commit fails: backup restored
//    to active.
// ---------------------------------------------------------------------------

test('commit: candidate commit fails — backup restored to active', async () => {
  const fs = new FakeFs();
  const active = '/res/web-dist';
  const candidate = '/res/web-dist-staging-123';
  const backup = '/res/web-dist-backup-123';
  fs.createDir(active);
  fs.createDir(candidate);

  // First rename (active→backup) succeeds, second rename (candidate→active) fails.
  let renameCount = 0;
  const result = await commitWebAssetGeneration({
    activeDir: active, candidateDir: candidate, backupDir: backup,
    rename: async (src, dest) => {
      renameCount += 1;
      if (renameCount === 2) {
        // candidate → active fails
        throw new Error('EIO: I/O error during rename');
      }
      return fs.rename(src, dest);
    },
    removeDir: (t) => fs.removeDir(t),
    exists: (t) => fs.exists(t),
  });

  assert.equal(result.ok, false);
  assert.ok(result.error.message.includes('Failed to commit candidate'), result.error.message);
  assert.equal(fs.dirs.has(active), true, 'backup should be restored as active');
  assert.equal(fs.dirs.has(backup), false, 'backup should be consumed by restore');
  assert.equal(fs.dirs.has(candidate), false, 'candidate should be cleaned');
  // 3 renames: active→backup, candidate→active(fail), backup→active(restore)
  assert.equal(renameCount, 3);
});

// ---------------------------------------------------------------------------
// 4. candidate commit fails AND recovery (backup→active) also fails: do NOT
//    delete backup; error preserves both primary and recovery failures.
// ---------------------------------------------------------------------------

test('commit: candidate commit and recovery both fail — backup preserved, both errors reported', async () => {
  const fs = new FakeFs();
  const active = '/res/web-dist';
  const candidate = '/res/web-dist-staging-123';
  const backup = '/res/web-dist-backup-123';
  fs.createDir(active);
  fs.createDir(candidate);

  let renameCount = 0;
  const result = await commitWebAssetGeneration({
    activeDir: active, candidateDir: candidate, backupDir: backup,
    rename: async (src, dest) => {
      renameCount += 1;
      if (renameCount === 2) throw new Error('primary: candidate commit failed');
      if (renameCount === 3) throw new Error('recovery: backup restore failed');
      return fs.rename(src, dest);
    },
    removeDir: (t) => fs.removeDir(t),
    exists: (t) => fs.exists(t),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.cause?.message, 'primary: candidate commit failed');
  assert.ok(result.recoveryError, 'recovery error must be present');
  assert.equal(result.recoveryError.cause?.message, 'recovery: backup restore failed');
  assert.equal(fs.dirs.has(active), false, 'active should not exist');
  assert.equal(fs.dirs.has(backup), true, 'backup must NOT be deleted — recovery failed');
  assert.equal(fs.dirs.has(candidate), false, 'candidate should be cleaned');
});

// ---------------------------------------------------------------------------
// 5. active missing (first generation): candidate becomes active directly.
// ---------------------------------------------------------------------------

test('commit: active missing — candidate becomes active directly', async () => {
  const fs = new FakeFs();
  const active = '/res/web-dist';
  const candidate = '/res/web-dist-staging-123';
  const backup = '/res/web-dist-backup-123';
  fs.createDir(candidate);
  // active does not exist

  const result = await commitWebAssetGeneration({
    activeDir: active, candidateDir: candidate, backupDir: backup,
    rename: (s, d) => fs.rename(s, d),
    removeDir: (t) => fs.removeDir(t),
    exists: (t) => fs.exists(t),
  });

  assert.equal(result.ok, true);
  assert.equal(fs.dirs.has(active), true, 'candidate should now be active');
  assert.equal(fs.dirs.has(candidate), false, 'candidate consumed');
  assert.equal(fs.dirs.has(backup), false, 'no backup created');
  assert.equal(fs.renameCalls.length, 1, 'only one rename: candidate→active');
  assert.equal(fs.removeCalls.length, 0, 'no backup to clean');
});

// ---------------------------------------------------------------------------
// 6. cleanup backup fails after candidate committed: do NOT pretend rolled
//    back; report success with a backupCleanupWarning.
// ---------------------------------------------------------------------------

test('commit: backup cleanup fails after commit — success with warning, backup retained', async () => {
  const fs = new FakeFs();
  const active = '/res/web-dist';
  const candidate = '/res/web-dist-staging-123';
  const backup = '/res/web-dist-backup-123';
  fs.createDir(active);
  fs.createDir(candidate);
  fs.failOnRemove = { targetMatches: backup, error: lockError('EBUSY') };

  const result = await commitWebAssetGeneration({
    activeDir: active, candidateDir: candidate, backupDir: backup,
    rename: (s, d) => fs.rename(s, d),
    removeDir: (t) => fs.removeDir(t),
    exists: (t) => fs.exists(t),
  });

  assert.equal(result.ok, true, 'commit itself succeeded');
  assert.ok(result.backupCleanupWarning, 'must report a backupCleanupWarning');
  assert.ok(result.backupCleanupWarning.includes('backup'), `warning mentions backup: ${result.backupCleanupWarning}`);
  assert.equal(fs.dirs.has(active), true, 'new generation is active');
  assert.equal(fs.dirs.has(backup), true, 'orphaned backup still exists for manual cleanup');
});
