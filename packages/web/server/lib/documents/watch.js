import { revisionFromBytes } from './inspect.js';

const toResource = (workspaceId, relativePath) => ({
  workspaceId,
  resourceId: relativePath.replace(/\\/g, '/'),
});

export const createWorkspaceWatcher = ({
  workspaceId,
  rootPath,
  fsModule,
  fsPromises,
  pathModule,
  overflowLimit = 256,
  onEvent,
}) => {
  let sequence = 0;
  let generation = 1;
  let pending = 0;
  let closed = false;
  let watcher = null;
  const known = new Map();
  let batch = [];
  let batchTimer = null;

  const nextSequence = () => {
    sequence += 1;
    return sequence;
  };

  const relativeFrom = (absolutePath) => {
    const relative = pathModule.relative(rootPath, absolutePath).replace(/\\/g, '/');
    if (!relative || relative === '.' || relative.startsWith('..') || pathModule.isAbsolute(relative)) {
      return null;
    }
    return relative;
  };

  const revisionOf = async (absolutePath) => {
    try {
      const bytes = await fsPromises.readFile(absolutePath);
      return revisionFromBytes(bytes);
    } catch {
      return undefined;
    }
  };

  const emit = (event) => {
    if (closed) return;
    if (event.kind !== 'reset') {
      const serialized = JSON.stringify(event);
      if (serialized.includes('"content"')) return;
    }
    onEvent(event);
  };

  const reset = (reason) => {
    known.clear();
    batch = [];
    pending = 0;
    generation += 1;
    sequence = 0;
    emit({ kind: 'reset', sequence: nextSequence(), reason });
  };

  const flushBatch = async () => {
    const current = batch;
    batch = [];
    batchTimer = null;
    if (current.length === 0 || closed) return;

    const deleted = [];
    const created = [];
    const changed = [];

    for (const absolutePath of current) {
      const resourceId = relativeFrom(absolutePath);
      if (!resourceId) continue;
      const resource = toResource(workspaceId, resourceId);
      const previous = known.get(resourceId);
      let stat = null;
      try {
        stat = await fsPromises.stat(absolutePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (!stat || !stat.isFile()) {
        if (previous) {
          known.delete(resourceId);
          deleted.push({ resource, previous });
        }
        continue;
      }
      const revision = await revisionOf(absolutePath);
      if (!previous) {
        known.set(resourceId, revision);
        created.push({ resource, revision });
        continue;
      }
      if (previous !== revision) {
        known.set(resourceId, revision);
        changed.push({ resource, revision });
      }
    }

    const moved = [];
    if (deleted.length === 1 && created.length === 1 && deleted[0].previous && deleted[0].previous === created[0].revision) {
      moved.push({
        from: deleted[0].resource,
        resource: created[0].resource,
        revision: created[0].revision,
      });
      deleted.length = 0;
      created.length = 0;
    }

    for (const entry of moved) {
      emit({
        kind: 'moved',
        sequence: nextSequence(),
        from: entry.from,
        resource: entry.resource,
        ...(entry.revision ? { revision: entry.revision } : {}),
      });
    }
    for (const entry of deleted) {
      emit({ kind: 'deleted', sequence: nextSequence(), resource: entry.resource });
    }
    for (const entry of created) {
      emit({
        kind: 'created',
        sequence: nextSequence(),
        resource: entry.resource,
        ...(entry.revision ? { revision: entry.revision } : {}),
      });
    }
    for (const entry of changed) {
      emit({
        kind: 'changed',
        sequence: nextSequence(),
        resource: entry.resource,
        ...(entry.revision ? { revision: entry.revision } : {}),
      });
    }
  };

  const queuePath = (filename) => {
    if (closed) return;
    pending += 1;
    if (pending > overflowLimit) {
      reset('overflow');
      return;
    }
    const absolutePath = filename
      ? pathModule.resolve(rootPath, filename)
      : rootPath;
    if (!batch.includes(absolutePath)) batch.push(absolutePath);
    if (batchTimer) return;
    batchTimer = setTimeout(() => {
      void flushBatch().catch(() => undefined);
    }, 20);
  };

  const start = () => {
    watcher = fsModule.watch(rootPath, { recursive: true, persistent: false }, (_eventType, filename) => {
      queuePath(typeof filename === 'string' ? filename : '');
    });
    watcher.on('error', () => {
      reset('reconnected');
    });
  };

  start();

  return {
    get generation() {
      return generation;
    },
    overflow() {
      reset('overflow');
    },
    reconnect() {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      reset('reconnected');
      if (!closed) start();
    },
    authorityChanged() {
      reset('authority-changed');
    },
    close() {
      closed = true;
      if (batchTimer) clearTimeout(batchTimer);
      if (watcher) watcher.close();
      watcher = null;
    },
  };
};

