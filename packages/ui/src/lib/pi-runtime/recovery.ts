import type {
  RecoveryAction,
  RecoveryMode,
  RecoveryPreference,
  RecoveryRepairAction,
  RecoveryStatus,
} from '@piarium/protocol';
import { getPiRuntimeConnection } from './client';

export const recoveryModeFromPreference = (
  preference: RecoveryPreference,
): Exclude<RecoveryMode, 'files'> | null => (
  preference === 'ask' ? null : preference
);

export const supportsPiRecoveryAction = (
  status: RecoveryStatus | null | undefined,
  action: RecoveryAction,
  mode?: RecoveryMode,
): boolean => (
  status?.providers.some((provider) => (
    provider.active
    && provider.actions.includes(action)
    && (mode === undefined || provider.modes.includes(mode))
  )) === true
);

export const recoveryModeForStatus = (
  preference: RecoveryPreference,
  status: RecoveryStatus | null | undefined,
): Exclude<RecoveryMode, 'files'> | null => {
  const mode = recoveryModeFromPreference(preference);
  if (mode !== 'both') return mode;
  return supportsPiRecoveryAction(status, 'navigate', 'both') ? mode : null;
};

export const getPiRecoveryStatus = async (sessionId: string) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('recovery.status', { sessionId });
};

export const navigatePiRecovery = async (
  sessionId: string,
  targetId: string,
  mode: RecoveryMode,
  options: { summarize?: boolean } = {},
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('recovery.navigate', {
    mode,
    sessionId,
    targetId,
    ...(options.summarize === undefined ? {} : { summarize: options.summarize }),
  });
};

export const undoPiRecovery = async (sessionId: string, mode: RecoveryMode) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('recovery.undo', { mode, sessionId });
};

export const redoPiRecovery = async (sessionId: string, mode: RecoveryMode) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('recovery.redo', { mode, sessionId });
};

export const createPiRecoveryCheckpoint = async (sessionId: string, name: string) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('recovery.checkpoint.create', { name, sessionId });
};

export const repairPiRecovery = async (
  sessionId: string,
  action: RecoveryRepairAction,
) => {
  const { client } = await getPiRuntimeConnection();
  return client.request('recovery.repair', { action, sessionId });
};
