import { createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  PiariumManagedSurfaceContext,
  PiariumSurfaceMountImplementation,
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

export const ownReactRoot = (context: PiariumManagedSurfaceContext, root: Root): Root => {
  context.onDispose(() => root.unmount());
  return root;
};
