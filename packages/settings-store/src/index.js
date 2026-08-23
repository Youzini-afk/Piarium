import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromisesDefault from 'node:fs/promises';
import pathDefault from 'node:path';

const mutationQueues = new Map();
const LOCK_RETRY_MS = 25;

const errorCode = (error) => (
  error && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined
);

const assertObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Settings file is malformed (non-object payload)');
  }
  return value;
};

const parseSettings = (raw) => assertObject(JSON.parse(raw));

const processIsAlive = (processLike, pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof processLike.kill !== 'function') return false;
  try {
    processLike.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
};

const enqueueMutation = (key, operation) => {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.finally(() => {
    if (mutationQueues.get(key) === settled) mutationQueues.delete(key);
  });
  mutationQueues.set(key, settled);
  return current;
};

export const createSettingsFileStore = ({
  filePath,
  fsModule = fs,
  fsPromises = fsPromisesDefault,
  pathModule = pathDefault,
  processLike = process,
}) => {
  const resolvedPath = pathModule.resolve(filePath);
  const lockPath = `${resolvedPath}.lock`;
  const previousPath = `${resolvedPath}.previous`;
  const directory = pathModule.dirname(resolvedPath);

  const read = async () => {
    try {
      return parseSettings(await fsPromises.readFile(resolvedPath, 'utf8'));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        try {
          return parseSettings(await fsPromises.readFile(previousPath, 'utf8'));
        } catch (previousError) {
          if (errorCode(previousError) === 'ENOENT') return {};
          throw previousError;
        }
      }
      throw error;
    }
  };

  const readSync = () => {
    try {
      return parseSettings(fsModule.readFileSync(resolvedPath, 'utf8'));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        try {
          return parseSettings(fsModule.readFileSync(previousPath, 'utf8'));
        } catch (previousError) {
          if (errorCode(previousError) === 'ENOENT') return {};
          throw previousError;
        }
      }
      throw error;
    }
  };

  const acquireLock = async () => {
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    for (;;) {
      let handle;
      try {
        handle = await fsPromises.open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      if (handle) {
        const token = randomUUID();
        try {
          await handle.writeFile(JSON.stringify({ pid: processLike.pid, token }), 'utf8');
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => undefined);
          await fsPromises.rm(lockPath, { force: true }).catch(() => undefined);
          throw error;
        }
        return async () => {
          await handle.close();
          try {
            const owner = JSON.parse(await fsPromises.readFile(lockPath, 'utf8'));
            if (owner?.token === token) await fsPromises.rm(lockPath, { force: true });
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
          }
        };
      }

      let abandoned = false;
      try {
        const owner = JSON.parse(await fsPromises.readFile(lockPath, 'utf8'));
        abandoned = !processIsAlive(processLike, Number(owner?.pid));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        try {
          abandoned = Date.now() - (await fsPromises.stat(lockPath)).mtimeMs > 2_000;
        } catch (statError) {
          if (errorCode(statError) === 'ENOENT') continue;
          throw statError;
        }
      }

      if (abandoned) {
        const moved = `${lockPath}.abandoned.${processLike.pid}.${randomUUID()}`;
        try {
          await fsPromises.rename(lockPath, moved);
        } catch (error) {
          if (errorCode(error) === 'ENOENT') continue;
          throw error;
        }
        await fsPromises.rm(moved, { force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  };

  const replaceFile = async (temporaryPath) => {
    try {
      await fsPromises.rename(temporaryPath, resolvedPath);
      return;
    } catch (error) {
      if (processLike.platform !== 'win32' || !['EPERM', 'EACCES', 'EEXIST'].includes(errorCode(error))) {
        throw error;
      }
    }

    await fsPromises.rm(previousPath, { force: true });
    let movedCurrent = false;
    try {
      await fsPromises.rename(resolvedPath, previousPath);
      movedCurrent = true;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }

    try {
      await fsPromises.rename(temporaryPath, resolvedPath);
    } catch (error) {
      if (movedCurrent) await fsPromises.rename(previousPath, resolvedPath).catch(() => undefined);
      throw error;
    }
    if (movedCurrent) await fsPromises.rm(previousPath, { force: true });
  };

  const writeUnlocked = async (settings) => {
    assertObject(settings);
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    if (processLike.platform !== 'win32') await fsPromises.chmod(directory, 0o700);
    const temporaryPath = `${resolvedPath}.tmp-${processLike.pid}-${randomUUID()}`;
    try {
      await fsPromises.writeFile(temporaryPath, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
      if (processLike.platform !== 'win32') await fsPromises.chmod(temporaryPath, 0o600);
      await replaceFile(temporaryPath);
      if (processLike.platform !== 'win32') await fsPromises.chmod(resolvedPath, 0o600);
    } finally {
      await fsPromises.rm(temporaryPath, { force: true });
    }
  };

  const withMutationLock = (operation) => enqueueMutation(resolvedPath, async () => {
    const release = await acquireLock();
    try {
      return await operation();
    } finally {
      await release();
    }
  });

  const replace = (settings) => withMutationLock(async () => {
    await writeUnlocked(settings);
    return settings;
  });

  const update = (mutator) => withMutationLock(async () => {
    const current = await read();
    const next = assertObject((await mutator(structuredClone(current))) ?? current);
    await writeUnlocked(next);
    return next;
  });

  return { filePath: resolvedPath, read, readSync, replace, update };
};
