import type { WorkspaceCombinedRecoveryPlan } from '@piarium/extension-contract';
import type { RecoveryPreference } from '@piarium/protocol';

export const shouldOpenRecoveryDialog = (
  preference: RecoveryPreference,
  plan: WorkspaceCombinedRecoveryPlan,
): boolean => (
  preference === 'ask'
  || plan.coverage !== 'ready'
  || plan.conflicts.length > 0
);
