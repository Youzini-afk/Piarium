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
  const renderedTransitionRef = React.useRef<{
    controller: ReturnType<typeof createWorkbenchTransitionSceneController>;
    id: number;
    scene: typeof transition.scene;
  } | null>(null);
  const [retiredTransitionId, setRetiredTransitionId] = React.useState<number | null>(null);
  if (
    transition.phase !== 'idle'
    && renderedTransitionRef.current?.id !== transition.id
  ) {
    renderedTransitionRef.current = {
      controller: createWorkbenchTransitionSceneController(transition.id),
      id: transition.id,
      scene: transition.scene,
    };
  }
  const renderedTransition = renderedTransitionRef.current;
  const sceneRetired = renderedTransition?.id === retiredTransitionId;
  React.useLayoutEffect(() => {
    if (
      !paintHandoffRef.current
      && transition.phase !== 'idle'
      && typeof document !== 'undefined'
    ) {
      paintHandoffRef.current = createWorkbenchTransitionPaintHandoff(document.documentElement);
    }
    const handoff = paintHandoffRef.current;
    if (!handoff) return;
    if (transition.phase !== 'idle') {
      handoff.hold();
      return;
    }
    if (renderedTransition && !sceneRetired) {
      handoff.retireSceneAfterPaint(() => setRetiredTransitionId(renderedTransition.id));
      return;
    }
    handoff.releaseAfterPaint();
  }, [renderedTransition, sceneRetired, transition.id, transition.phase]);
  React.useLayoutEffect(() => () => {
    paintHandoffRef.current?.dispose();
    paintHandoffRef.current = null;
  }, []);
  const surface = useSurfaceRegistrySnapshot();
  const controller = renderedTransition?.controller ?? null;
  const sceneProps = React.useMemo(() => controller ? { transition: controller } : null, [controller]);
  const contribution = findCapturedWorkbenchTransitionScene(surface, renderedTransition?.scene ?? null);
  const readinessKey = `${renderedTransition?.id ?? 0}\0${contribution
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

  if (!renderedTransition || sceneRetired || !controller || !sceneProps) return null;

  const frame = controller.getSnapshot();
  const isolatedFrame = contribution ? {
    contributionId: contribution.descriptor.id,
    frame,
    type: 'motion.transition.frame',
  } as unknown as JsonValue : undefined;
  const fallback = <CoreTransitionFallback onReady={onMountReady} />;

  return (
    <div
      className={`fixed inset-0 z-[9998] overflow-hidden ${frame.phase === 'revealing' ? 'pointer-events-none' : 'pointer-events-auto'}`}
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
