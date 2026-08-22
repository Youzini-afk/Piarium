import React from 'react';
import { PiariumSplash } from '@/components/ui/PiariumSplash';
import {
  SPLASH_EXIT_DURATION_MS,
  SPLASH_REDUCED_EXIT_DURATION_MS,
} from '@/components/ui/piarium-splash-lattice';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { useI18n } from '@/lib/i18n';
import { usePiariumExtensionCatalog } from '@/lib/extensions/catalog-store';
import { workbenchProfileLabel } from '@/lib/extensions/workbench-profile-label';
import {
  getWorkbenchProfileTransitionSnapshot,
  subscribeWorkbenchProfileTransition,
  type WorkbenchProfileTransitionState,
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
  const reducedMotion = usePrefersReducedMotion();
  const [transition, setTransition] = React.useState<WorkbenchProfileTransitionState>(
    getWorkbenchProfileTransitionSnapshot,
  );
  // Kept mounted through the exit so the sweep can finish after the store has gone idle.
  const [exiting, setExiting] = React.useState(false);

  React.useEffect(() => subscribeWorkbenchProfileTransition(setTransition), []);

  React.useEffect(() => {
    if (transition.isSwitching) {
      setExiting(false);
      return;
    }
    if (!exiting) return;
    const duration = reducedMotion ? SPLASH_REDUCED_EXIT_DURATION_MS : SPLASH_EXIT_DURATION_MS;
    const timer = setTimeout(() => setExiting(false), duration);
    return () => clearTimeout(timer);
  }, [transition.isSwitching, exiting, reducedMotion]);

  React.useEffect(() => {
    if (transition.isSwitching) setExiting(true);
  }, [transition.isSwitching]);

  if (!transition.isSwitching && !exiting) return null;

  const profiles = catalog.snapshot?.workbench?.document.profiles ?? [];
  const target = profiles.find((profile) => profile.id === transition.toProfileId);
  const status = target
    ? t('splash.switchingTo', { profile: workbenchProfileLabel(target, t) })
    : t('splash.switching');

  return (
    <PiariumSplash
      mode="switch"
      direction={transition.direction}
      label={t('splash.aria.switching')}
      status={status}
      leaving={!transition.isSwitching}
    />
  );
};
