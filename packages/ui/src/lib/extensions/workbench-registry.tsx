/* eslint-disable react-refresh/only-export-components */
import React from 'react';
import type { ComponentType } from 'react';
import type { PiariumExtensionContributionKind, PiariumWorkbenchLayoutLayer } from '@piarium/extension-contract';
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

interface ReactContribution<TProps extends object> {
  Component: ComponentType<TProps>;
  framework: 'react-19';
  props?: TProps;
}

interface ReactReplacementProps {
  fallback: React.ReactNode;
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

export const useSurfaceRegistrySnapshot = (): SurfaceRegistrySnapshot => React.useSyncExternalStore(
  piariumSurfaceRuntime.subscribe,
  piariumSurfaceRuntime.getSnapshot,
  piariumSurfaceRuntime.getSnapshot,
);

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
  const contribution = selectedReplacement(snapshot, target);
  if (!contribution) return <>{fallback}</>;
  const rendered = renderImplementation<ReactReplacementProps>(contribution.implementation, { fallback, target });
  return rendered === null || rendered === undefined ? <>{fallback}</> : <>{rendered}</>;
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
  const contribution = selectedReplacement(snapshot, target);
  if (!contribution) return <>{fallback}</>;
  const implementation = contribution.implementation as WorkbenchOwnedViewImplementation;
  const rendered = region === 'content'
    ? implementation.renderContent?.()
    : implementation.renderSidebar?.({ onItemSelect });
  if (rendered === undefined) return <>{fallback}</>;
  return <>{rendered}</>;
};

export const WorkbenchContributionSlot: React.FC<{
  kind?: PiariumExtensionContributionKind;
  props?: Record<string, unknown>;
  slot: string;
}> = ({ kind, props = {}, slot }) => {
  const snapshot = useSurfaceRegistrySnapshot();
  const contributions = snapshot.visibleContributions.filter((contribution) => (
    contribution.descriptor.placement?.slot === slot
    && (kind === undefined || contribution.descriptor.kind === kind)
    && contribution.descriptor.replacement === undefined
  ));
  return <>{contributions.map((contribution) => (
    <React.Fragment key={contribution.descriptor.id}>
      {renderImplementation(contribution.implementation, props)}
    </React.Fragment>
  ))}</>;
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
  return React.useMemo(() => snapshot.visibleContributions.flatMap((contribution) => {
    if (contribution.descriptor.kind !== kind || contribution.descriptor.placement?.slot !== slot) return [];
    const implementation = contribution.implementation as Partial<WorkbenchMatchRenderer<TInput>>;
    return typeof implementation.matches === 'function' && typeof implementation.render === 'function'
      ? [{ contributionId: contribution.descriptor.id, implementation: implementation as WorkbenchMatchRenderer<TInput> }]
      : [];
  }), [kind, slot, snapshot]);
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
