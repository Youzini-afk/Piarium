const METHODS = new Set([
  'resolveWorkspace',
  'read',
  'write',
  'move',
  'delete',
  'listRecoveryJournals',
  'readRecoveryJournal',
  'writeRecoveryJournal',
  'deleteRecoveryJournal',
]);

const asRecord = (params) => (
  params && typeof params === 'object' && !Array.isArray(params) ? params : null
);

const asResource = (params) => {
  const record = asRecord(params);
  if (!record) return null;
  if (record.resource && typeof record.resource === 'object' && !Array.isArray(record.resource)) {
    return record.resource;
  }
  if (typeof record.workspaceId === 'string' && typeof record.resourceId === 'string') return record;
  return null;
};

const bindCapabilityOwner = (record, context) => {
  const owner = context?.owner;
  if (!owner || !record.token || typeof record.token !== 'object' || Array.isArray(record.token)) return record;
  return {
    ...record,
    token: {
      ...record.token,
      owner: {
        kind: 'extension',
        id: `${owner.extensionId}:${owner.entrypointId}`,
        generation: owner.generation,
      },
    },
  };
};

export const createDocumentsCapabilityHandler = (authority) => async (method, params, context) => {
  if (!METHODS.has(method)) {
    throw new Error(`workspace.documents does not implement ${method}`);
  }
  if (method === 'resolveWorkspace') {
    return authority.resolveWorkspace(asRecord(params) ?? {});
  }
  if (method === 'read') {
    const resource = asResource(params);
    if (!resource) throw new Error('workspace.documents.read requires a resource');
    return authority.read(resource);
  }
  if (method === 'readRecoveryJournal') {
    const journalId = typeof params === 'string' ? params : asRecord(params)?.journalId;
    if (typeof journalId !== 'string' || !journalId) {
      throw new Error('workspace.documents.readRecoveryJournal requires a journalId');
    }
    return authority.readRecoveryJournal(journalId);
  }
  const record = asRecord(params);
  if (!record) throw new Error('workspace.documents expects an object');
  if (method === 'write') return authority.write(bindCapabilityOwner(record, context));
  if (method === 'move') return authority.move(bindCapabilityOwner(record, context));
  if (method === 'delete') return authority.delete(bindCapabilityOwner(record, context));
  if (method === 'listRecoveryJournals') return authority.listRecoveryJournals(record);
  if (method === 'writeRecoveryJournal') return authority.writeRecoveryJournal(bindCapabilityOwner(record, context));
  if (method === 'deleteRecoveryJournal') return authority.deleteRecoveryJournal(bindCapabilityOwner(record, context));
  throw new Error(`workspace.documents does not implement ${method}`);
};
