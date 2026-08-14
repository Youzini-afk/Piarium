import type { ComponentType } from "react";
import type { Root } from "react-dom/client";
import type { PiariumManagedSurfaceContext } from "@piarium/extension-sdk";

export interface PiariumReactContribution<TProps extends object = Record<string, never>> {
  Component: ComponentType<TProps>;
  framework: "react-19";
  props?: TProps;
}

export const defineReactContribution = <TProps extends object>(
  Component: ComponentType<TProps>,
  props?: TProps,
): PiariumReactContribution<TProps> => ({ Component, framework: "react-19", ...(props ? { props } : {}) });

export const ownReactRoot = (context: PiariumManagedSurfaceContext, root: Root): Root => {
  context.onDispose(() => root.unmount());
  return root;
};
