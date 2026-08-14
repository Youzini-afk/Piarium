import type { ComponentType, ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { PiariumManagedSurfaceContext } from "@piarium/extension-sdk";

export interface PiariumReactContribution<TProps extends object = Record<string, never>> {
  Component: ComponentType<TProps>;
  framework: "react-19";
  props?: TProps;
}

export interface PiariumReactReplacementProps {
  fallback: ReactNode;
  target: string;
}

export type PiariumReactReplacementContribution = PiariumReactContribution<PiariumReactReplacementProps>;

export const defineReactReplacement = (
  Component: ComponentType<PiariumReactReplacementProps>,
): PiariumReactReplacementContribution => defineReactContribution(Component);

export const defineReactContribution = <TProps extends object>(
  Component: ComponentType<TProps>,
  props?: TProps,
): PiariumReactContribution<TProps> => ({ Component, framework: "react-19", ...(props ? { props } : {}) });

export const ownReactRoot = (context: PiariumManagedSurfaceContext, root: Root): Root => {
  context.onDispose(() => root.unmount());
  return root;
};
