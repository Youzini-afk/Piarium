import React from 'react';
import type { JsonValue } from '@piarium/extension-contract';
import { useI18n } from '@/lib/i18n';
import {
  WorkbenchSurfaceContributionHost,
  useSurfaceRegistrySnapshot,
  workbenchContributionInstanceKey,
} from '@/lib/extensions/workbench-registry';
import { findCapturedWorkbenchTransitionScene } from '@/lib/extensions/workbench-transition-scene';
import {
  armWorkbenchProfileTransitionPhase,
  createWorkbenchTransitionSceneController,
  getWorkbenchProfileTransitionSnapshot,
  subscribeWorkbenchProfileTransition,
} from '@/lib/workbench/profile-transition';
import {
  createWorkbenchTransitionPaintHandoff,
  type WorkbenchTransitionPaintHandoff,
} from '@/lib/workbench/transition-paint-handoff';

const CoreTransitionFallback: React.FC<{ onReady(): void }> = ({ onReady }) => {
  React.useEffect(() => {
    onReady();
  }, [onReady]);
  return <div className="absolute inset-0 bg-background" aria-hidden="true" />;
};

/**
 * Shell-independent Transition Scene host. The captured contribution is mounted once outside both
 * Shells; Profile commit can therefore replace the entire workbench without replacing its visual
 * owner halfway through cover/reveal.
 */
export const WorkbenchTransitionOverlay: React.FC = () => {
  const { t } = useI18n();
  const transition = React.useSyncExternalStore(
    subscribeWorkbenchProfileTransition,
    getWorkbenchProfileTransitionSnapshot,
    getWorkbenchProfileTransitionSnapshot,
  );
  const paintHandoffRef = React.useRef<WorkbenchTransitionPaintHandoff | null>(null);
  React.useLayoutEffect(() => {
    if (transition.phase === 'idle') {
      paintHandoffRef.current?.releaseAfterPaint();
      return;
    }
    if (!paintHandoffRef.current && typeof document !== 'undefined') {
      paintHandoffRef.current = createWorkbenchTransitionPaintHandoff(document.documentElement);
    }
    paintHandoffRef.current?.hold();
  }, [transition.id, transition.phase]);
  React.useLayoutEffect(() => () => {
    paintHandoffRef.current?.dispose();
    paintHandoffRef.current = null;
  }, []);
  const surface = useSurfaceRegistrySnapshot();
  const controller = React.useMemo(() => transition.id > 0
    ? createWorkbenchTransitionSceneController(transition.id)
    : null, [transition.id]);
  const sceneProps = React.useMemo(() => controller ? { transition: controller } : null, [controller]);
  const contribution = findCapturedWorkbenchTransitionScene(surface, transition.scene);
  const readinessKey = `${transition.id}\0${contribution
    ? workbenchContributionInstanceKey(contribution)
    : 'core-fallback'}`;
  const [readyKey, setReadyKey] = React.useState<string | null>(null);
  const onMountReady = React.useCallback(() => {
    setReadyKey(readinessKey);
  }, [readinessKey]);
  React.useEffect(() => {
    if (readyKey !== readinessKey) return;
    if (transition.phase === 'covering' || transition.phase === 'revealing') {
      armWorkbenchProfileTransitionPhase(transition.id, transition.phase);
    }
  }, [readinessKey, readyKey, transition.id, transition.phase]);

  if (transition.phase === 'idle' || !controller || !sceneProps) return null;

  const frame = controller.getSnapshot();
  const isolatedFrame = contribution ? {
    contributionId: contribution.descriptor.id,
    frame,
    type: 'motion.transition.frame',
  } as unknown as JsonValue : undefined;
  const fallback = <CoreTransitionFallback onReady={onMountReady} />;

  return (
    <div
      className={`fixed inset-0 z-[9998] overflow-hidden ${transition.phase === 'revealing' ? 'pointer-events-none' : 'pointer-events-auto'}`}
      role="status"
      aria-live="polite"
      aria-label={t('splash.aria.switching')}
      data-piarium-transition-scene={contribution?.descriptor.id ?? 'core-fallback'}
    >
      {contribution ? (
        <WorkbenchSurfaceContributionHost
          className="h-full min-h-0 w-full min-w-0"
          contribution={contribution}
          fallback={fallback}
          isolatedProps={isolatedFrame}
          onMountReady={onMountReady}
          props={sceneProps}
        />
      ) : fallback}
    </div>
  );
};
