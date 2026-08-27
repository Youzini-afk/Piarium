import type {
  FoundationalPiPackageStatusEntry,
  FoundationalPiPackageStatusSnapshot,
} from '@piarium/protocol';
import type { I18nKey } from '@/lib/i18n';

export type FoundationalPackageAction = 'restore' | 'retry' | 'none';

export interface FoundationalPackagePresentation {
  action: FoundationalPackageAction;
  statusKey: I18nKey;
  tone: 'default' | 'success' | 'warning' | 'error';
  running: boolean;
}

const FOUNDATION_STATUS_KEYS = {
  actionRequired: 'settings.piarium.plugins.foundation.status.actionRequired',
  configuredBroken: 'settings.piarium.plugins.foundation.status.configuredBroken',
  disabled: 'settings.piarium.plugins.foundation.status.disabled',
  enabled: 'settings.piarium.plugins.foundation.status.enabled',
  failedRetryable: 'settings.piarium.plugins.foundation.status.failedRetryable',
  incompatible: 'settings.piarium.plugins.foundation.status.incompatible',
  missing: 'settings.piarium.plugins.foundation.status.missing',
  policySkipped: 'settings.piarium.plugins.foundation.status.policySkipped',
  sourceConflict: 'settings.piarium.plugins.foundation.status.sourceConflict',
  suppressed: 'settings.piarium.plugins.foundation.status.suppressed',
  unknown: 'settings.piarium.plugins.foundation.status.unknown',
  working: 'settings.piarium.plugins.foundation.status.working',
} as const satisfies Record<string, I18nKey>;

/**
 * Converts the broker's factual observation into the small status/action surface shown in Settings.
 * It intentionally does not infer health from intent or provenance, and never invents progress.
 */
export const projectFoundationalPackageStatus = (
  entry: FoundationalPiPackageStatusEntry | undefined,
): FoundationalPackagePresentation => {
  if (!entry) {
    return { action: 'none', running: false, statusKey: FOUNDATION_STATUS_KEYS.unknown, tone: 'default' };
  }

  if (entry.operation === 'planned' || entry.operation === 'mutating' || entry.operation === 'verifying') {
    return { action: 'none', running: true, statusKey: FOUNDATION_STATUS_KEYS.working, tone: 'warning' };
  }

  if (entry.operation === 'failed_retryable') {
    return { action: 'retry', running: false, statusKey: FOUNDATION_STATUS_KEYS.failedRetryable, tone: 'error' };
  }

  if (
    entry.operation === 'action_required'
    && entry.intent === 'suppressed'
    && (entry.observed === 'enabled' || entry.observed === 'disabled' || entry.observed === 'missing')
  ) {
    return { action: 'restore', running: false, statusKey: FOUNDATION_STATUS_KEYS.actionRequired, tone: 'error' };
  }

  switch (entry.observed) {
    case 'enabled':
      return { action: 'none', running: false, statusKey: FOUNDATION_STATUS_KEYS.enabled, tone: 'success' };
    case 'disabled':
      return { action: 'none', running: false, statusKey: FOUNDATION_STATUS_KEYS.disabled, tone: 'default' };
    case 'configured_broken':
      return { action: 'none', running: false, statusKey: FOUNDATION_STATUS_KEYS.configuredBroken, tone: 'error' };
    case 'source_conflict':
      return { action: 'none', running: false, statusKey: FOUNDATION_STATUS_KEYS.sourceConflict, tone: 'error' };
    case 'incompatible':
      return { action: 'none', running: false, statusKey: FOUNDATION_STATUS_KEYS.incompatible, tone: 'error' };
    case 'missing':
      if (entry.operation === 'action_required') {
        return { action: 'none', running: false, statusKey: FOUNDATION_STATUS_KEYS.actionRequired, tone: 'error' };
      }
      if (entry.intent === 'suppressed') {
        return { action: 'restore', running: false, statusKey: FOUNDATION_STATUS_KEYS.suppressed, tone: 'warning' };
      }
      if (entry.intent === 'policy_skipped') {
        return { action: 'restore', running: false, statusKey: FOUNDATION_STATUS_KEYS.policySkipped, tone: 'warning' };
      }
      return { action: 'restore', running: false, statusKey: FOUNDATION_STATUS_KEYS.missing, tone: 'warning' };
    default:
      return { action: 'none', running: false, statusKey: FOUNDATION_STATUS_KEYS.unknown, tone: 'default' };
  }
};

export const foundationalSnapshotStatusKey = (
  state: FoundationalPiPackageStatusSnapshot['state'] | undefined,
): I18nKey => {
  switch (state) {
    case 'running':
      return 'settings.piarium.plugins.foundation.state.running';
    case 'ready':
      return 'settings.piarium.plugins.foundation.state.ready';
    case 'degraded':
      return 'settings.piarium.plugins.foundation.state.degraded';
    default:
      return 'settings.piarium.plugins.foundation.state.idle';
  }
};

export const hasFoundationalPackageRestoreAction = (
  snapshot: FoundationalPiPackageStatusSnapshot | undefined,
): boolean => snapshot?.entries.some((entry) => (
  projectFoundationalPackageStatus(entry).action !== 'none'
)) === true;

export const foundationalRestoreSucceeded = (
  snapshot: FoundationalPiPackageStatusSnapshot,
  ids?: readonly FoundationalPiPackageStatusEntry['id'][],
): boolean => {
  const selected = ids === undefined ? snapshot.entries : snapshot.entries.filter((entry) => ids.includes(entry.id));
  return selected.length > 0 && selected.every((entry) => (
    entry.operation === 'idle'
    && (entry.observed === 'enabled' || entry.observed === 'disabled')
  ));
};
