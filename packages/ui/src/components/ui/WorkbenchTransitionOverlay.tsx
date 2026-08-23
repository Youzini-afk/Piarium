import React from 'react';
import { PiariumSplash } from '@/components/ui/PiariumSplash';
import { useI18n } from '@/lib/i18n';
import { usePiariumExtensionCatalog } from '@/lib/extensions/catalog-store';
import { workbenchProfileLabel } from '@/lib/extensions/workbench-profile-label';
import {
  completeWorkbenchProfileTransition,
  getWorkbenchProfileTransitionSnapshot,
  markWorkbenchProfileTransitionCovered,
  subscribeWorkbenchProfileTransition,
} from '@/lib/workbench/profile-transition';

/**
 * Covers a Workbench Profile switch.
 *
 * Mounted next to the other application-level overlays rather than inside the shell host, so the
 * shared kernel underneath — documents, editor groups, terminals, the Pi session — keeps running and
 * only the presentation changes. It also masks the shell host's own loading state, which is an
 * unstyled background-coloured div and would otherwise flash between the two shells.
 */
export const WorkbenchTransitionOverlay: React.FC = () => {
  const { t } = useI18n();
  const catalog = usePiariumExtensionCatalog();
  const transition = React.useSyncExternalStore(
    subscribeWorkbenchProfileTransition,
    getWorkbenchProfileTransitionSnapshot,
    getWorkbenchProfileTransitionSnapshot,
  );

  if (transition.phase === 'idle') return null;

  const profiles = catalog.snapshot?.workbench?.document.profiles ?? [];
  const target = profiles.find((profile) => profile.id === transition.toProfileId);
  const status = target
    ? t('splash.switchingTo', { profile: workbenchProfileLabel(target, t) })
    : t('splash.switching');

  return (
    <PiariumSplash
      mode="switch"
      direction={transition.direction}
      phase={transition.phase}
      tempo={transition.tempo}
      label={t('splash.aria.switching')}
      status={status}
      onPhaseComplete={() => {
        if (transition.phase === 'covering') {
          markWorkbenchProfileTransitionCovered(transition.id);
        } else if (transition.phase === 'revealing') {
          completeWorkbenchProfileTransition(transition.id);
        }
      }}
    />
  );
};
