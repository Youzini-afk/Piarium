import React from 'react';
import { PiariumSplash } from '@/components/ui/PiariumSplash';
import { useI18n } from '@/lib/i18n';
import { usePiariumExtensionCatalog } from '@/lib/extensions/catalog-store';
import { workbenchProfileLabel } from '@/lib/extensions/workbench-profile-label';
import type { WorkbenchTransitionSceneController } from '@/lib/workbench/profile-transition';

export interface BuiltinWorkbenchTransitionSceneProps {
  transition: WorkbenchTransitionSceneController;
}

/** Default Motion extension scene. It owns visuals only; the controller remains Core-owned. */
export const BuiltinWorkbenchTransitionScene: React.FC<BuiltinWorkbenchTransitionSceneProps> = ({
  transition,
}) => {
  const { t } = useI18n();
  const catalog = usePiariumExtensionCatalog();
  const frame = React.useSyncExternalStore(
    transition.subscribe,
    transition.getSnapshot,
    transition.getSnapshot,
  );
  const profiles = catalog.snapshot?.workbench?.document.profiles ?? [];
  const target = profiles.find((profile) => profile.id === frame.toProfileId);
  const status = target
    ? t('splash.switchingTo', { profile: workbenchProfileLabel(target, t) })
    : t('splash.switching');

  return (
    <PiariumSplash
      mode="switch"
      announce={false}
      direction={frame.direction}
      phase={frame.phase}
      tempo={frame.tempo}
      reducedMotion={frame.reducedMotion}
      label={t('splash.aria.switching')}
      status={status}
      onPhaseComplete={() => {
        if (frame.phase === 'covering' || frame.phase === 'revealing') {
          transition.complete(frame.transitionId, frame.phase);
        }
      }}
    />
  );
};
