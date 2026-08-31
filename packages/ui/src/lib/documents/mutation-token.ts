import { DocumentsError } from '@piarium/application-client';

export const requireWorkspaceEpoch = (epoch: number | undefined): number => {
  if (!Number.isSafeInteger(epoch) || Number(epoch) < 1) {
    throw new DocumentsError('Application Host did not provide a workspace mutation epoch', {
      reason: 'failed',
    });
  }
  return Number(epoch);
};
