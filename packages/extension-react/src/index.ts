import { createElement, createContext, useContext, type ComponentType, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  PiariumManagedSurfaceContext,
  PiariumShellMountContext,
  PiariumShellMountImplementation,
  PiariumSurfaceMountImplementation,
  PiariumWorkbenchCompositionHost,
  PiariumTransitionSceneMountProps,
  PiariumTransitionSceneFrameV1,
} from "@piarium/extension-sdk";

export interface PiariumReactContribution<TProps extends object = Record<string, unknown>>
  extends PiariumSurfaceMountImplementation<TProps> {
  Component: ComponentType<TProps>;
  framework: "react-19";
  props?: Partial<TProps>;
}

export interface PiariumReactReplacementProps {
  target: string;
}

export type PiariumReactReplacementContribution = PiariumReactContribution<PiariumReactReplacementProps>;
export type PiariumReactTransitionSceneContribution = PiariumReactContribution<PiariumTransitionSceneMountProps>;

export interface PiariumReactShellProps {
  workbench: PiariumWorkbenchCompositionHost;
}

export interface PiariumReactShellContribution extends PiariumShellMountImplementation<PiariumReactShellProps> {
  Component: ComponentType<PiariumReactShellProps>;
  framework: "react-19";
}

const WorkbenchCompositionHostContext = createContext<PiariumWorkbenchCompositionHost | null>(null);

/**
 * Access the composition host supplied to a managed Shell mount.
 * Returns `null` when the component is rendered outside a Shell mount
 * (e.g. in tests or isolated previews).
 */
export const useWorkbenchCompositionHost = (): PiariumWorkbenchCompositionHost | null => (
  useContext(WorkbenchCompositionHostContext)
);

export const WorkbenchCompositionHostProvider = WorkbenchCompositionHostContext.Provider;

export const defineReactReplacement = (
  Component: ComponentType<PiariumReactReplacementProps>,
): PiariumReactReplacementContribution => defineReactContribution(Component);

export const defineReactContribution = <TProps extends object>(
  Component: ComponentType<TProps>,
  props?: Partial<TProps>,
): PiariumReactContribution<TProps> => ({
  Component,
  framework: "react-19",
  ...(props ? { props } : {}),
  mount: (container, context) => {
    const root = createRoot(container, {
      onUncaughtError: (error) => context.reportError(error),
    });
    try {
      root.render(createElement(Component, { ...props, ...context.props } as TProps));
    } catch (error) {
      try {
        root.unmount();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "React contribution mount and cleanup failed");
      }
      throw error;
    }
    return () => root.unmount();
  },
});

export const defineReactShell = (
  Component: ComponentType<PiariumReactShellProps>,
): PiariumReactShellContribution => ({
  Component,
  framework: "react-19",
  mount: (container, context: PiariumShellMountContext<PiariumReactShellProps>) => {
    const workbench = context.workbench;
    const root = createRoot(container, {
      onUncaughtError: (error) => context.reportError(error),
    });
    try {
      root.render(createElement(
        WorkbenchCompositionHostProvider,
        { value: workbench },
        createElement(Component, { workbench }),
      ));
    } catch (error) {
      try {
        root.unmount();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "React shell mount and cleanup failed");
      }
      throw error;
    }
    return () => root.unmount();
  },
});
export const defineReactView = defineReactContribution;
export const defineReactEditor = defineReactContribution;
export const defineReactTransitionScene = (
  Component: ComponentType<PiariumTransitionSceneMountProps>,
): PiariumReactTransitionSceneContribution => defineReactContribution(Component);

export const usePiariumTransitionScene = (
  transition: PiariumTransitionSceneMountProps["transition"],
): PiariumTransitionSceneFrameV1 => useSyncExternalStore(
  transition.subscribe,
  transition.getSnapshot,
  transition.getSnapshot,
);

export const ownReactRoot = (context: PiariumManagedSurfaceContext, root: Root): Root => {
  context.onDispose(() => root.unmount());
  return root;
};
