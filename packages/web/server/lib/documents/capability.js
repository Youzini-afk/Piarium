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

export const createDocumentsCapabilityHandler = (authority) => async (method, params) => {
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
  if (method === 'write') return authority.write(record);
  if (method === 'move') return authority.move(record);
  if (method === 'delete') return authority.delete(record);
  if (method === 'listRecoveryJournals') return authority.listRecoveryJournals(record);
  if (method === 'writeRecoveryJournal') return authority.writeRecoveryJournal(record);
  if (method === 'deleteRecoveryJournal') return authority.deleteRecoveryJournal(record);
  throw new Error(`workspace.documents does not implement ${method}`);
};
