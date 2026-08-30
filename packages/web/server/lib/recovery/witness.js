import { RecoveryPrimitiveError } from './errors.js';

const PREFIX = 'piarium-witness:v1:';

const positiveInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RecoveryPrimitiveError('storage-malformed', `Workspace witness ${label} is malformed`);
  }
  return value;
};

export const normalizeWorkspaceWitness = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Workspace witness is malformed');
  }
  return {
    epoch: positiveInteger(value.epoch, 'epoch'),
    mutationRevision: positiveInteger(value.mutationRevision, 'mutation revision'),
    writerRevision: positiveInteger(value.writerRevision, 'writer revision'),
  };
};

export const encodeWorkspaceWitness = (value) => {
  const witness = normalizeWorkspaceWitness(value);
  return `${PREFIX}${witness.epoch}:${witness.mutationRevision}:${witness.writerRevision}`;
};

export const decodeWorkspaceWitness = (value) => {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null;
  const parts = value.slice(PREFIX.length).split(':').map(Number);
  if (parts.length !== 3) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Workspace witness reference is malformed');
  }
  return normalizeWorkspaceWitness({
    epoch: parts[0],
    mutationRevision: parts[1],
    writerRevision: parts[2],
  });
};

export const sameWorkspaceContentWitness = (left, right) => (
  left.epoch === right.epoch
  && left.mutationRevision === right.mutationRevision
);
