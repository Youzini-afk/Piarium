import type {
  PiariumApplicationSurface,
  PiariumWorkbenchLayoutLayer,
  PiariumWorkbenchLayoutUpdateRequest,
  PiariumWorkbenchProfileSelectionRequest,
} from '@piarium/extension-contract';
import {
  inspectPiariumWorkbenchShell,
  PIARIUM_WORKBENCH_REPLACEMENT_TARGETS,
  resolvePiariumWorkbenchLayout,
  resolvePiariumWorkbenchLayoutForProfile,
  type PiariumWorkbenchShellStatus,
} from '@piarium/extension-contract';
import type { SurfaceContribution, SurfaceRegistrySnapshot } from '@piarium/extension-surface';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { PiariumExtensionCatalogStoreState } from './catalog-store';
import {
  getPiariumExtensionCatalogState,
  getPiariumExtensionCatalogWatchGeneration,
  refreshPiariumExtensionCatalog,
  setPiariumExtensionEnabled,
} from './catalog-store';
import {
  beginWorkbenchProfileTransition,
  finishWorkbenchProfileTransition,
  resolveTransitionDirection,
  waitForWorkbenchProfileTransitionCover,
} from '@/lib/workbench/profile-transition';
import { startWorkbenchMountSession } from './workbench-mount';
import {
  stageWorkbenchShellRender,
  type WorkbenchShellRenderStagingHandle,
} from './workbench-shell-staging-store';
import { piariumSurfaceRuntime } from './surface-runtime';

export type WorkbenchShellUnavailableStatus = Extract<PiariumWorkbenchShellStatus, 'disabled' | 'failed' | 'missing'>;

export class WorkbenchShellUnavailableError extends Error {
  readonly profileId: string;
  readonly shellContributionId: string;
  readonly shellExtensionId?: string;
  readonly status: WorkbenchShellUnavailableStatus;

  constructor(input: {
    profileId: string;
    shellContributionId: string;
    shellExtensionId?: string;
    status: WorkbenchShellUnavailableStatus;
  }) {
    super(`Workbench shell is ${input.status}`);
    this.name = 'WorkbenchShellUnavailableError';
    this.profileId = input.profileId;
    this.shellContributionId = input.shellContributionId;
    this.status = input.status;
    if (input.shellExtensionId) this.shellExtensionId = input.shellExtensionId;
  }
}

export class WorkbenchShellTransitionAbortedError extends Error {
  constructor(message = 'Workbench shell candidate was superseded') {
    super(message);
    this.name = 'WorkbenchShellTransitionAbortedError';
  }
}

export interface WorkbenchProfileTransitionOptions {
  enableShell?: boolean;
}

export interface WorkbenchShellTransitionDependencies {
  createMountContainer(): HTMLElement;
  getCatalogState(): PiariumExtensionCatalogStoreState;
  getCatalogWatchGeneration(): number;
  getSurface(): PiariumApplicationSurface;
  getSurfaceSnapshot(): SurfaceRegistrySnapshot;
  refreshCatalog(): Promise<void>;
  selectProfile(request: PiariumWorkbenchProfileSelectionRequest): Promise<void>;
  setEnabled(extensionId: string, enabled: boolean): Promise<void>;
  stageRender(
    contribution: SurfaceContribution,
    props: Readonly<Record<string, unknown>>,
  ): Promise<WorkbenchShellRenderStagingHandle>;
  startMount: typeof startWorkbenchMountSession;
  triggerActivation(contributionId: string, extensionId: string): Promise<void>;
  triggerVisible(contributions: readonly SurfaceContribution[]): Promise<void>;
  updateLayout(request: PiariumWorkbenchLayoutUpdateRequest): Promise<void>;
}

interface MountImplementation<TProps extends object> {
  mount(
    container: HTMLElement,
    context: {
      contributionId: string;
      owner: SurfaceContribution['owner'];
      props: Readonly<TProps>;
      reportError(error: unknown): void;
      signal: AbortSignal;
    },
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

type StagingSession = Pick<ReturnType<typeof startWorkbenchMountSession>, 'dispose'>;

let transitionQueue: Promise<void> = Promise.resolve();

const enqueueWorkbenchShellTransition = (operation: () => Promise<void>): Promise<void> => {
  const run = transitionQueue.then(operation, operation);
  transitionQueue = run.then(() => undefined, () => undefined);
  return run;
};

const isDeclarativeImplementation = (value: unknown): boolean => (
  typeof value === 'object'
  && value !== null
  && (value as { kind?: unknown }).kind === 'declarative'
);

const isMountImplementation = <TProps extends object>(
  value: unknown,
): value is MountImplementation<TProps> => (
  typeof value === 'object' && value !== null && typeof (value as { mount?: unknown }).mount === 'function'
);

const createLiveWorkbenchShellTransitionDependencies = (): WorkbenchShellTransitionDependencies => ({
  createMountContainer: () => {
    const element = document.createElement('div');
    element.setAttribute('data-piarium-workbench-shell-staging', '');
    Object.assign(element.style, {
      inset: '0',
      pointerEvents: 'none',
      position: 'fixed',
      visibility: 'hidden',
      zIndex: '-1',
    });
    document.body.append(element);
    return element;
  },
  getCatalogState: getPiariumExtensionCatalogState,
  getCatalogWatchGeneration: getPiariumExtensionCatalogWatchGeneration,
  getSurface: () => piariumSurfaceRuntime.surface,
  getSurfaceSnapshot: () => piariumSurfaceRuntime.getSnapshot(),
  refreshCatalog: refreshPiariumExtensionCatalog,
  selectProfile: async (request) => {
    const extensions = getRegisteredRuntimeAPIs()?.extensions;
    if (!extensions) throw new Error('Piarium Extensions runtime is unavailable');
    await extensions.selectWorkbenchProfile(request);
  },
  setEnabled: setPiariumExtensionEnabled,
  stageRender: stageWorkbenchShellRender,
  startMount: startWorkbenchMountSession,
  triggerActivation: async (contributionId, extensionId) => {
    const { surfaceExtensionLoader } = await import('./managed-runtime');
    await surfaceExtensionLoader.triggerActivation('contribution-visible', { contributionId, extensionId });
  },
  triggerVisible: async (contributions) => {
    const { surfaceExtensionLoader } = await import('./managed-runtime');
    for (const contribution of contributions) {
      if (
        typeof contribution.implementation !== 'object'
        || contribution.implementation === null
        || (contribution.implementation as { kind?: unknown }).kind !== 'declarative'
      ) continue;
      await surfaceExtensionLoader.triggerActivation('contribution-visible', {
        contributionId: contribution.descriptor.id,
        extensionId: contribution.owner.extensionId,
      });
    }
  },
  updateLayout: async (request) => {
    const extensions = getRegisteredRuntimeAPIs()?.extensions;
    if (!extensions) throw new Error('Piarium Extensions runtime is unavailable');
    await extensions.updateWorkbenchLayout(request);
  },
});

const requireAuthoritativeWorkbench = (deps: WorkbenchShellTransitionDependencies) => {
  const snapshot = deps.getCatalogState().snapshot;
  if (!snapshot?.workbench.authoritative) throw new Error('Workbench profile state is unavailable');
  return snapshot;
};

const captureIdentity = (deps: WorkbenchShellTransitionDependencies) => {
  const snapshot = requireAuthoritativeWorkbench(deps);
  return {
    generation: deps.getCatalogWatchGeneration(),
    hostId: snapshot.catalog.hostId,
    revision: snapshot.workbench.document.revision,
  };
};

const assertSameIdentity = (
  expected: ReturnType<typeof captureIdentity>,
  deps: WorkbenchShellTransitionDependencies,
): void => {
  const current = captureIdentity(deps);
  if (current.generation !== expected.generation || current.hostId !== expected.hostId) {
    throw new WorkbenchShellTransitionAbortedError();
  }
};

const findContribution = (
  snapshot: SurfaceRegistrySnapshot,
  contributionId: string,
): SurfaceContribution | undefined => snapshot.contributions.find((contribution) => (
  contribution.descriptor.id === contributionId
));

const releaseStaging = async (
  session: StagingSession | null,
  container: HTMLElement | null,
): Promise<void> => {
  if (session) await session.dispose('workbench shell candidate released');
  container?.remove();
};

const proveShellReady = async (
  contributionId: string,
  extensionId: string | undefined,
  deps: WorkbenchShellTransitionDependencies,
  captured: ReturnType<typeof captureIdentity>,
): Promise<{ container: HTMLElement | null; session: StagingSession | null }> => {
  let contribution = findContribution(deps.getSurfaceSnapshot(), contributionId);
  if (!contribution || isDeclarativeImplementation(contribution.implementation)) {
    if (extensionId) await deps.triggerActivation(contributionId, extensionId);
    else if (contribution) await deps.triggerVisible([contribution]);
    assertSameIdentity(captured, deps);
    contribution = findContribution(deps.getSurfaceSnapshot(), contributionId);
  }
  if (!contribution) throw new Error(`Workbench shell contribution did not activate: ${contributionId}`);
  if (isDeclarativeImplementation(contribution.implementation)) {
    throw new Error(`Workbench shell contribution did not activate: ${contributionId}`);
  }
  const props = { target: PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell };
  if (!isMountImplementation(contribution.implementation)) {
    const session = await deps.stageRender(contribution, props);
    assertSameIdentity(captured, deps);
    return { container: null, session };
  }
  const container = deps.createMountContainer();
  let failed: unknown;
  const session = deps.startMount({
    container,
    contributionId,
    implementation: contribution.implementation,
    owner: contribution.owner,
    props,
    onError: (error, phase) => {
      if (phase !== 'dispose') failed = error;
    },
  });
  try {
    await session.mounted;
    if (failed !== undefined) throw failed instanceof Error ? failed : new Error(String(failed));
    assertSameIdentity(captured, deps);
    return { container, session };
  } catch (error) {
    await releaseStaging(session, container);
    throw error;
  }
};

const persistProfileSelection = async (
  deps: WorkbenchShellTransitionDependencies,
  profileId: string,
  workspaceId: string | undefined,
  expectedRevision: number,
): Promise<void> => {
  await deps.selectProfile({
    expectedRevision,
    profileId,
    scope: workspaceId ? 'workspace' : 'user',
    scopeId: workspaceId ?? 'default',
  });
  await deps.refreshCatalog();
};

const persistReplacementSelection = async (
  deps: WorkbenchShellTransitionDependencies,
  target: string,
  contributionId: string | null,
  options: { scope?: 'user' | 'workspace'; scopeId?: string } | undefined,
  expectedRevision: number,
): Promise<void> => {
  const snapshot = requireAuthoritativeWorkbench(deps).workbench;
  const scope = options?.scope ?? (options?.scopeId ? 'workspace' : 'user');
  const scopeId = options?.scopeId ?? 'default';
  const resolved = resolvePiariumWorkbenchLayout(snapshot.document, {
    surface: deps.getSurface(),
    userId: 'default',
    ...(scope === 'workspace' ? { workspaceId: scopeId } : {}),
  });
  const currentLayer = snapshot.document.layouts.find((layer) => (
    layer.profileId === resolved.profileId
    && layer.surface === deps.getSurface()
    && layer.scope === scope
    && layer.scopeId === scopeId
  ));
  const replacementSelections = { ...(currentLayer?.replacementSelections ?? {}) };
  if (contributionId === null) delete replacementSelections[target];
  else replacementSelections[target] = contributionId;
  const layer: PiariumWorkbenchLayoutLayer = {
    profileId: resolved.profileId,
    references: currentLayer?.references ?? [],
    replacementSelections,
    scope,
    scopeId,
    surface: deps.getSurface(),
  };
  await deps.updateLayout({ expectedRevision, layer });
  await deps.refreshCatalog();
};

const commitCandidateShell = async (
  deps: WorkbenchShellTransitionDependencies,
  input: {
    enableShell?: boolean;
    profileId: string;
    replacementSelections: Readonly<Record<string, string>>;
    persist(expectedRevision: number): Promise<void>;
  },
): Promise<void> => {
  const inspectShell = (): ReturnType<typeof inspectPiariumWorkbenchShell> => {
    const current = requireAuthoritativeWorkbench(deps);
    const surface = deps.getSurfaceSnapshot();
    return inspectPiariumWorkbenchShell(
      input.replacementSelections,
      current.catalog.extensions,
      deps.getSurface(),
      {
        hostId: current.catalog.hostId,
        realmIds: surface.actual.map((state) => state.realmId),
      },
    );
  };
  let autoEnabledExtensionId: string | undefined;
  let committed = false;
  try {
    let inspected = inspectShell();
    if (input.enableShell && inspected.status === 'disabled' && inspected.shellExtensionId) {
      await deps.setEnabled(inspected.shellExtensionId, true);
      autoEnabledExtensionId = inspected.shellExtensionId;
      inspected = inspectShell();
    }
    const captured = captureIdentity(deps);
    if (inspected.status === 'builtin') {
      await input.persist(captured.revision);
      committed = true;
      return;
    }
    if (inspected.status === 'missing' || inspected.status === 'disabled' || inspected.status === 'failed') {
      throw new WorkbenchShellUnavailableError({
        profileId: input.profileId,
        shellContributionId: inspected.shellContributionId ?? '',
        status: inspected.status,
        ...(inspected.shellExtensionId ? { shellExtensionId: inspected.shellExtensionId } : {}),
      });
    }
    const staging = await proveShellReady(
      inspected.shellContributionId ?? '',
      inspected.shellExtensionId,
      deps,
      captured,
    );
    try {
      assertSameIdentity(captured, deps);
      await input.persist(captured.revision);
      committed = true;
    } catch (error) {
      await releaseStaging(staging.session, staging.container);
      throw error;
    }
    await releaseStaging(staging.session, staging.container);
  } catch (error) {
    if (autoEnabledExtensionId && !committed) {
      await deps.setEnabled(autoEnabledExtensionId, false).catch((rollbackError) => {
        console.error('[Piarium Extensions] Failed to roll back workbench shell enablement:', rollbackError);
      });
    }
    throw error;
  }
};

export const runSelectActiveWorkbenchProfile = (
  deps: WorkbenchShellTransitionDependencies,
  profileId: string,
  workspaceId?: string,
  options?: WorkbenchProfileTransitionOptions,
): Promise<void> => enqueueWorkbenchShellTransition(async () => {
  const snapshot = requireAuthoritativeWorkbench(deps);
  const layout = resolvePiariumWorkbenchLayoutForProfile(snapshot.workbench.document, {
    surface: deps.getSurface(),
    userId: 'default',
    ...(workspaceId ? { workspaceId } : {}),
  }, profileId);
  await commitCandidateShell(deps, {
    persist: (expectedRevision) => persistProfileSelection(deps, profileId, workspaceId, expectedRevision),
    profileId,
    replacementSelections: layout.replacementSelections,
    ...(options?.enableShell ? { enableShell: true } : {}),
  });
});

const runSetWorkbenchReplacementSelection = (
  deps: WorkbenchShellTransitionDependencies,
  target: string,
  contributionId: string | null,
  options?: { scope?: 'user' | 'workspace'; scopeId?: string },
): Promise<void> => enqueueWorkbenchShellTransition(async () => {
  const snapshot = requireAuthoritativeWorkbench(deps);
  const persist = (expectedRevision: number) => persistReplacementSelection(
    deps,
    target,
    contributionId,
    options,
    expectedRevision,
  );
  if (target !== PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell) {
    await persist(snapshot.workbench.document.revision);
    return;
  }
  const context = {
    surface: deps.getSurface(),
    userId: 'default',
    ...(options?.scope === 'workspace' && options.scopeId ? { workspaceId: options.scopeId } : {}),
  };
  const resolved = resolvePiariumWorkbenchLayout(snapshot.workbench.document, context);
  const replacementSelections = { ...resolved.replacementSelections };
  if (contributionId === null) delete replacementSelections[target];
  else replacementSelections[target] = contributionId;
  await commitCandidateShell(deps, {
    persist,
    profileId: resolved.profileId,
    replacementSelections,
  });
});

/**
 * The live switch. The transition cover is driven from here rather than from the switcher component,
 * because the switcher is rendered inside the shell being replaced and stops existing partway
 * through. `finish` runs for both outcomes: a rejected switch leaves the previous shell active and
 * still has to drop the cover.
 */
export const selectActiveWorkbenchProfile = async (
  profileId: string,
  workspaceId?: string,
  options?: WorkbenchProfileTransitionOptions,
): Promise<void> => {
  const workbench = getPiariumExtensionCatalogState().snapshot?.workbench;
  const profileIds = workbench?.document.profiles.map((profile) => profile.id) ?? [];
  const fromProfileId = workbench?.authoritative
    ? resolvePiariumWorkbenchLayout(workbench.document, {
      surface: piariumSurfaceRuntime.surface,
      userId: 'default',
      ...(workspaceId ? { workspaceId } : {}),
    }).profileId
    : null;

  beginWorkbenchProfileTransition({
    direction: resolveTransitionDirection(profileIds, fromProfileId, profileId),
    fromProfileId,
    toProfileId: profileId,
  });

  // Do not let the shell replacement consume the same frame as the overlay state update. The overlay
  // acknowledges after a painted frame, making the transition deterministic on both fast and busy hosts.
  await waitForWorkbenchProfileTransitionCover();

  try {
    await runSelectActiveWorkbenchProfile(
      createLiveWorkbenchShellTransitionDependencies(),
      profileId,
      workspaceId,
      options,
    );
  } finally {
    await finishWorkbenchProfileTransition();
  }
};

export const setWorkbenchReplacementSelection = (
  target: string,
  contributionId: string | null,
  options?: { scope?: 'user' | 'workspace'; scopeId?: string },
): Promise<void> => runSetWorkbenchReplacementSelection(
  createLiveWorkbenchShellTransitionDependencies(),
  target,
  contributionId,
  options,
);
