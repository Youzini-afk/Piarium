/* eslint-disable react-refresh/only-export-components */
import React from 'react';
import type { ComponentType } from 'react';
import type {
  PiariumExtensionContributionKind,
  PiariumWorkbenchDistributionProfile,
  PiariumWorkbenchLayoutLayer,
} from '@piarium/extension-contract';
import { resolvePiariumWorkbenchLayout } from '@piarium/extension-contract';
import type { SurfaceContribution, SurfaceRegistrySnapshot } from '@piarium/extension-surface';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import {
  getPiariumExtensionCatalogState,
  refreshPiariumExtensionCatalog,
  usePiariumExtensionCatalog,
} from './catalog-store';
import { piariumSurfaceRuntime } from './surface-runtime';

export const WORKBENCH_REPLACEMENT_TARGETS = {
  agents: 'agents.workbench',
  chatComposer: 'chat.composer',
  chatTimeline: 'chat.timeline',
  mcp: 'mcp.workbench',
  sessionNavigator: 'sessions.navigator',
  settings: 'settings.workbench',
  shell: 'workbench.shell',
  workspaceExplorer: 'workspace.explorer',
} as const;

type RenderImplementation<TProps extends object> = {
  render(props: TProps): React.ReactNode;
};

type MountDisposer = () => void | Promise<void>;

interface MountContext<TProps extends object> {
  readonly contributionId: string;
  readonly owner: Readonly<SurfaceContribution['owner']>;
  readonly props: Readonly<TProps>;
  reportError(error: unknown): void;
  readonly signal: AbortSignal;
}

type MountImplementation<TProps extends object> = {
  mount(
    container: HTMLElement,
    context: MountContext<TProps>,
  ): void | MountDisposer | Promise<void | MountDisposer>;
};

type WorkbenchMountFailurePhase = 'dispose' | 'mount' | 'render';

interface WorkbenchMountSession {
  dispose(reason?: unknown): Promise<void>;
  readonly mounted: Promise<void>;
  readonly signal: AbortSignal;
}

interface ReactContribution<TProps extends object> {
  Component: ComponentType<TProps>;
  framework: 'react-19';
  props?: TProps;
}

interface ReactReplacementProps {
  fallback: React.ReactNode;
  target: string;
}

interface MountReplacementProps {
  target: string;
}

interface MountOwnedViewProps {
  onItemSelect?(): void;
  region: 'content' | 'sidebar';
  target: string;
}

const isReactContribution = <TProps extends object>(
  value: unknown,
): value is ReactContribution<TProps> => (
  typeof value === 'object'
  && value !== null
  && (value as { framework?: unknown }).framework === 'react-19'
  && typeof (value as { Component?: unknown }).Component === 'function'
);

const isRenderImplementation = <TProps extends object>(
  value: unknown,
): value is RenderImplementation<TProps> => (
  typeof value === 'object' && value !== null && typeof (value as { render?: unknown }).render === 'function'
);

const isMountImplementation = <TProps extends object>(
  value: unknown,
): value is MountImplementation<TProps> => (
  typeof value === 'object' && value !== null && typeof (value as { mount?: unknown }).mount === 'function'
);

export const startWorkbenchMountSession = <TProps extends object>(options: {
  container: HTMLElement;
  contributionId: string;
  implementation: MountImplementation<TProps>;
  onError(error: unknown, phase: WorkbenchMountFailurePhase): void;
  owner: SurfaceContribution['owner'];
  props: TProps;
}): WorkbenchMountSession => {
  const controller = new AbortController();
  let disposer: MountDisposer | undefined;
  let disposal: Promise<void> | null = null;
  const mounted = Promise.resolve().then(async () => {
    const returned = await options.implementation.mount(options.container, {
      contributionId: options.contributionId,
      owner: { ...options.owner },
      props: options.props,
      reportError: (error) => options.onError(error, 'render'),
      signal: controller.signal,
    });
    if (returned !== undefined && typeof returned !== 'function') {
      throw new TypeError(`Surface contribution ${options.contributionId} mount must return a disposer or undefined`);
    }
    disposer = typeof returned === 'function' ? returned : undefined;
  }).catch((error: unknown) => {
    options.onError(error, 'mount');
  });

  return {
    mounted,
    signal: controller.signal,
    dispose: (reason) => {
      if (disposal) return disposal;
      controller.abort(reason);
      disposal = mounted.then(async () => {
        if (!disposer) return;
        const current = disposer;
        disposer = undefined;
        try {
          await current();
        } catch (error) {
          options.onError(error, 'dispose');
        }
      });
      return disposal;
    },
  };
};

export const workbenchContributionInstanceKey = (contribution: SurfaceContribution): string => {
  const { owner } = contribution;
  return [
    contribution.descriptor.id,
    owner.extensionId,
    owner.entrypointId,
    owner.realmId,
    owner.generation,
  ].join('\0');
};

const renderImplementation = <TProps extends object>(
  implementation: unknown,
  props: TProps,
): React.ReactNode => {
  if (isReactContribution<TProps>(implementation)) {
    const Component = implementation.Component;
    return <Component {...implementation.props} {...props} />;
  }
  if (isRenderImplementation<TProps>(implementation)) return implementation.render(props);
  return null;
};

interface ContributionRenderBoundaryProps {
  children: React.ReactNode;
  contribution: SurfaceContribution;
  fallback: React.ReactNode;
}

interface ContributionRenderBoundaryState {
  failed: boolean;
}

class ContributionRenderBoundary extends React.Component<
  ContributionRenderBoundaryProps,
  ContributionRenderBoundaryState
> {
  state: ContributionRenderBoundaryState = { failed: false };

  static getDerivedStateFromError(): ContributionRenderBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, errorInfo: React.ErrorInfo): void {
    const { descriptor, owner } = this.props.contribution;
    console.error(
      `[Piarium Extensions] Contribution ${descriptor.id} from ${owner.extensionId} failed to render:`,
      error,
      errorInfo,
    );
  }

  render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const WorkbenchRenderImplementation = <TProps extends object>({
  fallbackOnEmpty,
  implementation,
  props,
}: {
  fallbackOnEmpty: React.ReactNode;
  implementation: unknown;
  props: TProps;
}): React.ReactNode => {
  const rendered = renderImplementation(implementation, props);
  return rendered === null || rendered === undefined ? fallbackOnEmpty : rendered;
};

interface MountFailure {
  contributionKey: string;
  implementation: unknown;
  props: object;
}

const WorkbenchMountHost = <TProps extends object>({
  className,
  contribution,
  fallback,
  implementation,
  props,
}: {
  className?: string;
  contribution: SurfaceContribution;
  fallback: React.ReactNode;
  implementation: MountImplementation<TProps>;
  props: TProps;
}): React.ReactNode => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [failure, setFailure] = React.useState<MountFailure | null>(null);
  const contributionKey = workbenchContributionInstanceKey(contribution);
  const failed = failure?.contributionKey === contributionKey
    && failure.implementation === implementation
    && failure.props === props;

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let active = true;
    const session = startWorkbenchMountSession({
      container,
      contributionId: contribution.descriptor.id,
      implementation,
      owner: contribution.owner,
      props,
      onError: (error, phase) => {
        console.error(
          `[Piarium Extensions] Contribution ${contribution.descriptor.id} from ${contribution.owner.extensionId} failed during ${phase}:`,
          error,
        );
        if (!active || phase === 'dispose') return;
        setFailure({ contributionKey, implementation, props });
        void session.dispose(error);
      },
    });
    return () => {
      active = false;
      void session.dispose(`Surface contribution ${contribution.descriptor.id} was unmounted`);
    };
  }, [contribution, contributionKey, implementation, props]);

  if (failed) return fallback;
  return (
    <div
      ref={containerRef}
      className={className}
      data-piarium-surface-contribution={contribution.descriptor.id}
    />
  );
};

export const useSurfaceRegistrySnapshot = (): SurfaceRegistrySnapshot => React.useSyncExternalStore(
  piariumSurfaceRuntime.subscribe,
  piariumSurfaceRuntime.getSnapshot,
  piariumSurfaceRuntime.getSnapshot,
);

interface VisibleContributionActivationDependencies {
  trigger(contribution: SurfaceContribution): Promise<void>;
}

const visibleContributionActivationDependencies: VisibleContributionActivationDependencies = {
  trigger: async (contribution) => {
    const { surfaceExtensionLoader } = await import('./managed-runtime');
    await surfaceExtensionLoader.triggerActivation('contribution-visible', {
      contributionId: contribution.descriptor.id,
      extensionId: contribution.owner.extensionId,
    });
  },
};

export const triggerVisibleSurfaceContributions = async (
  contributions: readonly SurfaceContribution[],
  dependencies: VisibleContributionActivationDependencies = visibleContributionActivationDependencies,
): Promise<void> => {
  for (const contribution of contributions) {
    if (
      typeof contribution.implementation !== 'object'
      || contribution.implementation === null
      || (contribution.implementation as { kind?: unknown }).kind !== 'declarative'
    ) continue;
    await dependencies.trigger(contribution);
  }
};

const useVisibleContributionActivation = (contributions: readonly SurfaceContribution[]): void => {
  const activationKey = contributions.map(workbenchContributionInstanceKey).join('\n');
  React.useEffect(() => {
    void triggerVisibleSurfaceContributions(contributions).catch((error) => {
      console.error('[Piarium Extensions] Visible Surface contribution activation failed:', error);
    });
  // The owner-generation key changes exactly when a newly visible implementation needs evaluation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activationKey]);
};

export const WorkbenchProfileBridge: React.FC = () => {
  const catalog = usePiariumExtensionCatalog();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const workbench = catalog.snapshot?.workbench;
  React.useEffect(() => {
    if (!workbench?.authoritative) return;
    const resolved = resolvePiariumWorkbenchLayout(workbench.document, {
      surface: piariumSurfaceRuntime.surface,
      userId: 'default',
      ...(currentDirectory ? { workspaceId: currentDirectory } : {}),
    });
    piariumSurfaceRuntime.setWorkbenchState(resolved.references, resolved.replacementSelections);
  }, [currentDirectory, workbench]);
  return null;
};

const selectedReplacement = (
  snapshot: SurfaceRegistrySnapshot,
  target: string,
): SurfaceContribution | undefined => snapshot.visibleContributions.find((contribution) => (
  contribution.descriptor.replacement?.target === target
));

export const WorkbenchReplacement: React.FC<{
  fallback: React.ReactNode;
  target: string;
}> = ({ fallback, target }) => {
  const snapshot = useSurfaceRegistrySnapshot();
  const mountProps = React.useMemo<MountReplacementProps>(() => ({ target }), [target]);
  const contribution = selectedReplacement(snapshot, target);
  useVisibleContributionActivation(contribution ? [contribution] : []);
  if (!contribution) return <>{fallback}</>;
  const contributionKey = workbenchContributionInstanceKey(contribution);
  if (isMountImplementation<MountReplacementProps>(contribution.implementation)) {
    return (
      <WorkbenchMountHost
        key={contributionKey}
        className="h-full min-h-0 w-full min-w-0"
        contribution={contribution}
        fallback={fallback}
        implementation={contribution.implementation}
        props={mountProps}
      />
    );
  }
  return (
    <ContributionRenderBoundary key={contributionKey} contribution={contribution} fallback={fallback}>
      <WorkbenchRenderImplementation
        fallbackOnEmpty={fallback}
        implementation={contribution.implementation}
        props={{ fallback, target } satisfies ReactReplacementProps}
      />
    </ContributionRenderBoundary>
  );
};

export interface WorkbenchOwnedViewImplementation {
  renderContent?(): React.ReactNode;
  renderSidebar?(options: { onItemSelect?(): void }): React.ReactNode;
}

export const WorkbenchOwnedView: React.FC<{
  fallback: React.ReactNode;
  onItemSelect?(): void;
  region: 'content' | 'sidebar';
  target: string;
}> = ({ fallback, onItemSelect, region, target }) => {
  const snapshot = useSurfaceRegistrySnapshot();
  const mountProps = React.useMemo<MountOwnedViewProps>(
    () => ({ region, target, ...(onItemSelect ? { onItemSelect } : {}) }),
    [onItemSelect, region, target],
  );
  const contribution = selectedReplacement(snapshot, target);
  useVisibleContributionActivation(contribution ? [contribution] : []);
  if (!contribution) return <>{fallback}</>;
  const contributionKey = workbenchContributionInstanceKey(contribution);
  if (isMountImplementation<MountOwnedViewProps>(contribution.implementation)) {
    return (
      <WorkbenchMountHost
        key={contributionKey}
        className="h-full min-h-0 w-full min-w-0"
        contribution={contribution}
        fallback={fallback}
        implementation={contribution.implementation}
        props={mountProps}
      />
    );
  }
  const implementation = contribution.implementation as WorkbenchOwnedViewImplementation;
  return (
    <ContributionRenderBoundary key={contributionKey} contribution={contribution} fallback={fallback}>
      <WorkbenchOwnedViewRender
        fallback={fallback}
        implementation={implementation}
        onItemSelect={onItemSelect}
        region={region}
      />
    </ContributionRenderBoundary>
  );
};

const WorkbenchOwnedViewRender: React.FC<{
  fallback: React.ReactNode;
  implementation: WorkbenchOwnedViewImplementation;
  onItemSelect?(): void;
  region: 'content' | 'sidebar';
}> = ({ fallback, implementation, onItemSelect, region }) => {
  const rendered = region === 'content'
    ? implementation.renderContent?.()
    : implementation.renderSidebar?.({ onItemSelect });
  return rendered === undefined ? <>{fallback}</> : <>{rendered}</>;
};

const EMPTY_MOUNT_PROPS: Readonly<Record<string, unknown>> = {};

export const WorkbenchContributionSlot: React.FC<{
  kind?: PiariumExtensionContributionKind;
  props?: Record<string, unknown>;
  slot: string;
}> = ({ kind, props, slot }) => {
  const snapshot = useSurfaceRegistrySnapshot();
  const contributionProps = props ?? EMPTY_MOUNT_PROPS;
  const contributions = snapshot.visibleContributions.filter((contribution) => (
    contribution.descriptor.placement?.slot === slot
    && (kind === undefined || contribution.descriptor.kind === kind)
    && contribution.descriptor.replacement === undefined
  ));
  useVisibleContributionActivation(contributions);
  return <>{contributions.map((contribution) => {
    const contributionKey = workbenchContributionInstanceKey(contribution);
    if (isMountImplementation<Record<string, unknown>>(contribution.implementation)) {
      return (
        <WorkbenchMountHost
          key={contributionKey}
          contribution={contribution}
          fallback={null}
          implementation={contribution.implementation}
          props={contributionProps}
        />
      );
    }
    return (
      <ContributionRenderBoundary key={contributionKey} contribution={contribution} fallback={null}>
        <WorkbenchRenderImplementation
          fallbackOnEmpty={null}
          implementation={contribution.implementation}
          props={contributionProps}
        />
      </ContributionRenderBoundary>
    );
  })}</>;
};

export interface WorkbenchMatchRenderer<TInput> {
  matches(input: TInput): boolean;
  render(input: TInput): React.ReactNode;
}

export interface WorkbenchMatchRendererRegistration<TInput> {
  contributionId: string;
  implementation: WorkbenchMatchRenderer<TInput>;
}

export const useWorkbenchMatchRenderers = <TInput,>(
  kind: 'message-renderer' | 'tool-renderer' | 'session-decoration',
  slot: string,
): WorkbenchMatchRendererRegistration<TInput>[] => {
  const snapshot = useSurfaceRegistrySnapshot();
  const contributions = React.useMemo(() => snapshot.visibleContributions.filter((contribution) => (
    contribution.descriptor.kind === kind && contribution.descriptor.placement?.slot === slot
  )), [kind, slot, snapshot]);
  useVisibleContributionActivation(contributions);
  return React.useMemo(() => contributions.flatMap((contribution) => {
    const implementation = contribution.implementation as Partial<WorkbenchMatchRenderer<TInput>>;
    return typeof implementation.matches === 'function' && typeof implementation.render === 'function'
      ? [{ contributionId: contribution.descriptor.id, implementation: implementation as WorkbenchMatchRenderer<TInput> }]
      : [];
  }), [contributions]);
};

export const renderFirstWorkbenchMatch = <TInput,>(
  renderers: readonly WorkbenchMatchRendererRegistration<TInput>[],
  input: TInput,
): React.ReactNode | undefined => {
  for (const renderer of renderers) {
    if (renderer.implementation.matches(input)) return renderer.implementation.render(input);
  }
  return undefined;
};

export const setWorkbenchReplacementSelection = async (
  target: string,
  contributionId: string | null,
  options?: { scope?: 'user' | 'workspace'; scopeId?: string },
): Promise<void> => {
  const state = getPiariumExtensionCatalogState();
  const snapshot = state.snapshot?.workbench;
  if (!snapshot?.authoritative) throw new Error('Workbench profile state is unavailable');
  const scope = options?.scope ?? (options?.scopeId ? 'workspace' : 'user');
  const scopeId = options?.scopeId ?? 'default';
  const resolved = resolvePiariumWorkbenchLayout(snapshot.document, {
    surface: piariumSurfaceRuntime.surface,
    userId: 'default',
    ...(scope === 'workspace' ? { workspaceId: scopeId } : {}),
  });
  const currentLayer = snapshot.document.layouts.find((layer) => (
    layer.profileId === resolved.profileId
    && layer.surface === piariumSurfaceRuntime.surface
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
    surface: piariumSurfaceRuntime.surface,
  };
  await window.__PIARIUM_RUNTIME_APIS__?.extensions.updateWorkbenchLayout({
    expectedRevision: snapshot.document.revision,
    layer,
  });
  await refreshPiariumExtensionCatalog();
};

export const selectActiveWorkbenchProfile = async (
  profileId: string,
  workspaceId?: string,
): Promise<void> => {
  const snapshot = getPiariumExtensionCatalogState().snapshot?.workbench;
  if (!snapshot?.authoritative) throw new Error('Workbench profile state is unavailable');
  await window.__PIARIUM_RUNTIME_APIS__?.extensions.selectWorkbenchProfile({
    expectedRevision: snapshot.document.revision,
    profileId,
    scope: workspaceId ? 'workspace' : 'user',
    scopeId: workspaceId ?? 'default',
  });
  await refreshPiariumExtensionCatalog();
};

export const upsertWorkbenchProfile = async (
  profile: PiariumWorkbenchDistributionProfile,
): Promise<void> => {
  const snapshot = getPiariumExtensionCatalogState().snapshot?.workbench;
  if (!snapshot?.authoritative) throw new Error('Workbench profile state is unavailable');
  await window.__PIARIUM_RUNTIME_APIS__?.extensions.upsertWorkbenchProfile({
    expectedRevision: snapshot.document.revision,
    profile,
  });
  await refreshPiariumExtensionCatalog();
};

export const removeWorkbenchProfile = async (profileId: string): Promise<void> => {
  const snapshot = getPiariumExtensionCatalogState().snapshot?.workbench;
  if (!snapshot?.authoritative) throw new Error('Workbench profile state is unavailable');
  await window.__PIARIUM_RUNTIME_APIS__?.extensions.removeWorkbenchProfile({
    expectedRevision: snapshot.document.revision,
    profileId,
  });
  await refreshPiariumExtensionCatalog();
};

export const applyWorkbenchProfile = async (profileId: string): Promise<void> => {
  const snapshot = getPiariumExtensionCatalogState().snapshot;
  if (!snapshot?.workbench.authoritative) throw new Error('Workbench profile state is unavailable');
  await window.__PIARIUM_RUNTIME_APIS__?.extensions.applyWorkbenchProfile({
    expectedCatalogRevision: snapshot.catalog.revision,
    profileId,
  });
  await refreshPiariumExtensionCatalog();
};
