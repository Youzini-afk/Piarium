import {
  PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE,
  PIARIUM_WORKBENCH_REPLACEMENT_TARGETS,
  PiariumTransitionSceneContractError,
  parsePiariumTransitionSceneContributionData,
  type PiariumTransitionSceneContributionDataV1,
} from '@piarium/extension-contract';
import type { SurfaceContribution, SurfaceRegistrySnapshot } from '@piarium/extension-surface';
import { piariumSurfaceRuntime } from './surface-runtime';

export interface WorkbenchTransitionSceneCapture {
  contributionId: string;
  data: PiariumTransitionSceneContributionDataV1;
  desiredRevision: number;
  entrypointId: string;
  extensionId: string;
  extensionVersion: string;
  generation: number;
  hostId: string;
  realmId: string;
}

export type WorkbenchTransitionScenePreparation =
  | { scene: WorkbenchTransitionSceneCapture; status: 'ready' }
  | { scene: null; status: 'missing' }
  | { error: Error; scene: null; status: 'failed' };

export type WorkbenchTransitionSceneResolution =
  | { contribution: SurfaceContribution; scene: WorkbenchTransitionSceneCapture; status: 'ready' }
  | { contribution: null; scene: null; status: 'missing' }
  | { contribution: SurfaceContribution; error: Error; scene: null; status: 'failed' };

const isDeclarative = (contribution: SurfaceContribution): boolean => (
  typeof contribution.implementation === 'object'
  && contribution.implementation !== null
  && (contribution.implementation as { kind?: unknown }).kind === 'declarative'
);

const matchesCapture = (
  contribution: SurfaceContribution,
  capture: WorkbenchTransitionSceneCapture,
): boolean => {
  const { owner } = contribution;
  return contribution.descriptor.id === capture.contributionId
    && owner.desiredRevision === capture.desiredRevision
    && owner.entrypointId === capture.entrypointId
    && owner.extensionId === capture.extensionId
    && owner.extensionVersion === capture.extensionVersion
    && owner.generation === capture.generation
    && owner.hostId === capture.hostId
    && owner.realmId === capture.realmId;
};

const captureContribution = (contribution: SurfaceContribution): WorkbenchTransitionSceneCapture => {
  const data = parsePiariumTransitionSceneContributionData(contribution.descriptor.data);
  if (!data.scenes.includes(PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE)) {
    throw new PiariumTransitionSceneContractError(
      'Workbench transition scene does not support Profile transitions',
      [`data.scenes must contain ${PIARIUM_WORKBENCH_PROFILE_TRANSITION_SCENE}`],
    );
  }
  return {
    contributionId: contribution.descriptor.id,
    data,
    desiredRevision: contribution.owner.desiredRevision,
    entrypointId: contribution.owner.entrypointId,
    extensionId: contribution.owner.extensionId,
    extensionVersion: contribution.owner.extensionVersion,
    generation: contribution.owner.generation,
    hostId: contribution.owner.hostId,
    realmId: contribution.owner.realmId,
  };
};

const transitionSceneCandidates = (snapshot: SurfaceRegistrySnapshot): SurfaceContribution[] => (
  snapshot.contributions.filter((contribution) => (
    contribution.descriptor.kind === 'transition-scene'
    && contribution.descriptor.replacement?.target === PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.transition
  ))
);

const resolveContribution = (
  snapshot: SurfaceRegistrySnapshot,
  replacementSelections: Readonly<Record<string, string>>,
): SurfaceContribution | undefined => {
  const candidates = transitionSceneCandidates(snapshot);
  const selectedId = replacementSelections[PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.transition];
  if (selectedId) return candidates.find((candidate) => candidate.descriptor.id === selectedId);
  return candidates.find((candidate) => candidate.descriptor.data.fallback === true);
};

export const resolveWorkbenchTransitionScene = (
  snapshot: SurfaceRegistrySnapshot,
  replacementSelections: Readonly<Record<string, string>>,
): WorkbenchTransitionSceneResolution => {
  const contribution = resolveContribution(snapshot, replacementSelections);
  if (!contribution) return { contribution: null, scene: null, status: 'missing' };
  try {
    return { contribution, scene: captureContribution(contribution), status: 'ready' };
  } catch (error) {
    return {
      contribution,
      error: error instanceof Error ? error : new Error(String(error)),
      scene: null,
      status: 'failed',
    };
  }
};

export const findCapturedWorkbenchTransitionScene = (
  snapshot: SurfaceRegistrySnapshot,
  capture: WorkbenchTransitionSceneCapture | null,
): SurfaceContribution | undefined => capture
  ? snapshot.contributions.find((contribution) => matchesCapture(contribution, capture))
  : undefined;

/**
 * Resolve the mounted scene once per transaction, then keep it for the rest of that transaction.
 *
 * The surface registry changes underneath a transition precisely during the Profile commit — that is the
 * event being covered. Re-resolving each render means a single missed match, from a regenerated owner or a
 * reloaded host, swaps the mounted scene out and back, and remounting a scene restarts every animation in it
 * from its first frame. Mid-reveal that reads as the finished cover snapping shut and the logo fading in
 * again, at whatever moment the registry happened to settle.
 *
 * Holding a contribution whose owner has since gone is deliberate: the render boundary around it already
 * degrades to the Core fallback if it actually fails, which is a better outcome for the last frames of a
 * reveal than tearing the scene down and rebuilding it.
 */
export const holdWorkbenchTransitionSceneContribution = (input: {
  readonly capture: WorkbenchTransitionSceneCapture | null;
  readonly held: SurfaceContribution | undefined;
  readonly snapshot: SurfaceRegistrySnapshot;
}): SurfaceContribution | undefined => (
  input.held ?? findCapturedWorkbenchTransitionScene(input.snapshot, input.capture)
);

/**
 * Resolve the target Profile's scene without applying its layout. A lazy executable contribution is
 * activated before capture, and its exact owner generation is frozen for cover through reveal.
 */
export const prepareWorkbenchTransitionScene = async (
  replacementSelections: Readonly<Record<string, string>>,
): Promise<WorkbenchTransitionScenePreparation> => {
  let resolution = resolveWorkbenchTransitionScene(piariumSurfaceRuntime.getSnapshot(), replacementSelections);
  if (resolution.status === 'missing') return { scene: null, status: 'missing' };
  if (resolution.status === 'failed') return { error: resolution.error, scene: null, status: 'failed' };
  let contribution = resolution.contribution;
  try {
    if (isDeclarative(contribution)) {
      const { surfaceExtensionLoader } = await import('./managed-runtime');
      await surfaceExtensionLoader.triggerActivation('contribution-visible', {
        contributionId: contribution.descriptor.id,
        extensionId: contribution.owner.extensionId,
      });
      resolution = resolveWorkbenchTransitionScene(piariumSurfaceRuntime.getSnapshot(), replacementSelections);
      if (resolution.status === 'missing') return { scene: null, status: 'missing' };
      if (resolution.status === 'failed') return { error: resolution.error, scene: null, status: 'failed' };
      contribution = resolution.contribution;
      if (isDeclarative(contribution)) {
        throw new Error(`Transition scene did not activate: ${contribution.descriptor.id}`);
      }
    }
    return { scene: resolution.scene, status: 'ready' };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      scene: null,
      status: 'failed',
    };
  }
};
