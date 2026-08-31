import type { JsonObject, JsonValue, PiariumExtensionContributionKind } from '@piarium/extension-contract';
import type { PiariumWorkbenchChildMount, PiariumWorkbenchCompositionHost } from '@piarium/extension-sdk';
import type { SurfaceContribution } from '@piarium/extension-surface';
import { createElement, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { startWorkbenchMountSession, type WorkbenchMountSession } from './workbench-mount';

interface ReplacementCandidate {
  contribution: SurfaceContribution;
  props: JsonObject;
}

export interface WorkbenchCompositionHostOptions {
  shellContributionId: string;
  owner: SurfaceContribution['owner'];
  allowedReplacementTargets: ReadonlySet<string>;
  allowedSlots: ReadonlySet<string>;
  activate(contributions: readonly SurfaceContribution[]): Promise<void>;
  resolveReplacement(target: string): ReplacementCandidate | undefined;
  resolveSlotCandidates(slot: string, kind?: PiariumExtensionContributionKind): SurfaceContribution[];
  subscribe(listener: () => void): () => void;
  onError(error: unknown, phase: 'dispose' | 'mount' | 'render'): void;
}

export interface WorkbenchCompositionHostController extends PiariumWorkbenchCompositionHost {
  dispose(reason?: unknown): Promise<void>;
}

interface MountedChild {
  container: HTMLElement;
  inspectorId: string;
  key: string;
  session: WorkbenchMountSession;
}

interface CompositionBinding extends PiariumWorkbenchChildMount {
  start(): Promise<void>;
}

export interface WorkbenchCompositionInspectorEntry {
  contributionId: string;
  extensionId: string;
  generation: number;
  host: 'replacement' | 'slot';
  hostId: string;
  shellContributionId: string;
}

let inspectorRevision = 0;
let inspectorSnapshot: Readonly<{ revision: number; entries: readonly WorkbenchCompositionInspectorEntry[] }> = {
  revision: 0,
  entries: [],
};
let inspectorCounter = 0;
const inspectorEntries = new Map<string, WorkbenchCompositionInspectorEntry>();
const inspectorListeners = new Set<() => void>();

const publishInspector = (): void => {
  inspectorRevision += 1;
  inspectorSnapshot = {
    revision: inspectorRevision,
    entries: [...inspectorEntries.values()].sort((left, right) => (
      left.shellContributionId.localeCompare(right.shellContributionId)
      || left.hostId.localeCompare(right.hostId)
      || left.contributionId.localeCompare(right.contributionId)
    )),
  };
  for (const listener of inspectorListeners) listener();
};

export const getWorkbenchCompositionInspectorSnapshot = () => inspectorSnapshot;
export const subscribeWorkbenchCompositionInspector = (listener: () => void): (() => void) => {
  inspectorListeners.add(listener);
  return () => inspectorListeners.delete(listener);
};

const contributionKey = (contribution: SurfaceContribution): string => [
  contribution.descriptor.id,
  contribution.owner.extensionId,
  contribution.owner.entrypointId,
  contribution.owner.realmId,
  contribution.owner.generation,
].join('\0');

const sameOwner = (
  left: SurfaceContribution['owner'],
  right: SurfaceContribution['owner'],
): boolean => left.extensionId === right.extensionId
  && left.entrypointId === right.entrypointId
  && left.realmId === right.realmId
  && left.generation === right.generation;

const isJsonValue = (value: unknown, seen: Set<object>): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype
      && Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
};

const normalizeProps = (value: JsonObject | undefined): JsonObject => {
  const props = value ?? {};
  if (!isJsonValue(props, new Set()) || Array.isArray(props)) {
    throw new TypeError('Workbench composition props must be a JSON-safe object');
  }
  return structuredClone(props);
};

const createChildContainer = (container: HTMLElement, kind: 'replacement' | 'slot'): HTMLElement => {
  const child = container.ownerDocument.createElement('div');
  child.dataset.piariumWorkbenchChild = kind;
  if (kind === 'replacement') child.className = 'h-full min-h-0 w-full min-w-0';
  else {
    child.className = 'piarium-workbench-slot-child';
    child.style.display = 'contents';
  }
  container.appendChild(child);
  return child;
};

const mountImplementation = (contribution: SurfaceContribution) => {
  const implementation = contribution.implementation as {
    Component?: ComponentType<Record<string, unknown>>;
    framework?: string;
    mount?: (container: HTMLElement, context: Record<string, unknown>) => unknown;
    props?: Record<string, unknown>;
    render?: (props: Record<string, unknown>) => unknown;
  };
  if (typeof implementation.mount === 'function') return implementation as never;
  if (implementation.framework === 'react-19' && typeof implementation.Component === 'function') {
    return {
      mount: (container: HTMLElement, context: { props: Record<string, unknown>; reportError(error: unknown): void }) => {
        const root = createRoot(container, { onUncaughtError: context.reportError });
        root.render(createElement(implementation.Component!, { ...implementation.props, ...context.props }));
        return () => root.unmount();
      },
    };
  }
  if (typeof implementation.render === 'function') {
    return {
      mount: (container: HTMLElement, context: { props: Record<string, unknown>; reportError(error: unknown): void }) => {
        const root = createRoot(container, { onUncaughtError: context.reportError });
        root.render(implementation.render!(context.props) as never);
        return () => root.unmount();
      },
    };
  }
  throw new TypeError(`Contribution ${contribution.descriptor.id} does not provide a mountable implementation`);
};

const disposeMountedChild = async (child: MountedChild | null, reason?: unknown): Promise<void> => {
  if (!child) return;
  await child.session.dispose(reason);
  child.container.remove();
  if (inspectorEntries.delete(child.inspectorId)) publishInspector();
};

const mountContribution = async (
  options: WorkbenchCompositionHostOptions,
  container: HTMLElement,
  contribution: SurfaceContribution,
  props: JsonObject,
  kind: 'replacement' | 'slot',
  hostId: string,
): Promise<MountedChild> => {
  if (contribution.descriptor.id === options.shellContributionId && sameOwner(contribution.owner, options.owner)) {
    throw new Error(`Shell contribution ${contribution.descriptor.id} cannot mount itself`);
  }
  const target = createChildContainer(container, kind);
  let implementation;
  try {
    implementation = mountImplementation(contribution);
  } catch (error) {
    target.remove();
    throw error;
  }
  let mountFailure: unknown;
  const session = startWorkbenchMountSession({
    container: target,
    contributionId: contribution.descriptor.id,
    implementation,
    onError: (error, phase) => {
      options.onError(error, phase);
      if (phase !== 'dispose') mountFailure = error;
    },
    owner: contribution.owner,
    props: props as never,
  });
  await session.mounted;
  if (mountFailure !== undefined) {
    await session.dispose(mountFailure);
    target.remove();
    throw mountFailure;
  }
  const inspectorId = `composition-child-${++inspectorCounter}`;
  inspectorEntries.set(inspectorId, {
    contributionId: contribution.descriptor.id,
    extensionId: contribution.owner.extensionId,
    generation: contribution.owner.generation,
    host: kind,
    hostId,
    shellContributionId: options.shellContributionId,
  });
  publishInspector();
  return { container: target, inspectorId, key: contributionKey(contribution), session };
};

const createSerialBinding = (
  options: WorkbenchCompositionHostOptions,
  reconcile: () => Promise<void>,
  disposeChildren: (reason?: unknown) => Promise<void>,
  onDispose: () => void,
): CompositionBinding => {
  let disposed = false;
  let tail = Promise.resolve();
  const schedule = (propagate: boolean): Promise<void> => {
    if (disposed) return tail;
    const operation = tail.then(reconcile, reconcile);
    tail = operation.catch((error) => {
      options.onError(error, 'mount');
    });
    return propagate ? operation : tail;
  };
  const unsubscribe = options.subscribe(() => { void schedule(false); });
  return {
    start: () => schedule(true),
    dispose: async (reason?: unknown) => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      await tail;
      await disposeChildren(reason);
      onDispose();
    },
  };
};

export const createWorkbenchCompositionHost = (
  options: WorkbenchCompositionHostOptions,
): WorkbenchCompositionHostController => {
  const bindings: CompositionBinding[] = [];
  let disposed = false;

  const own = async (binding: CompositionBinding): Promise<PiariumWorkbenchChildMount> => {
    if (disposed) {
      await binding.dispose('Shell composition host is disposed');
      throw new Error('Shell composition host is disposed');
    }
    bindings.push(binding);
    try {
      await binding.start();
      return binding;
    } catch (error) {
      await binding.dispose(error);
      throw error;
    }
  };

  return {
    mountReplacement: async ({ container, target, props }) => {
      if (!options.allowedReplacementTargets.has(target)) {
        throw new Error(`Shell did not declare replacement target ${target}`);
      }
      const normalizedProps = normalizeProps(props);
      let current: MountedChild | null = null;
      const binding = createSerialBinding(
        options,
        async () => {
          let candidate = options.resolveReplacement(target);
          if (candidate) {
            await options.activate([candidate.contribution]);
            candidate = options.resolveReplacement(target);
          }
          const nextKey = candidate ? contributionKey(candidate.contribution) : null;
          if (current?.key === nextKey) return;
          await disposeMountedChild(current, 'Replacement owner changed');
          current = null;
          if (!candidate) return;
          current = await mountContribution(
            options,
            container,
            candidate.contribution,
            normalizeProps({ ...candidate.props, ...normalizedProps }),
            'replacement',
            target,
          );
        },
        async (reason) => {
          await disposeMountedChild(current, reason);
          current = null;
        },
        () => {
          const index = bindings.indexOf(binding);
          if (index >= 0) bindings.splice(index, 1);
        },
      );
      return own(binding);
    },

    mountSlot: async ({ container, slot, kind, props }) => {
      if (!options.allowedSlots.has(slot)) throw new Error(`Shell did not declare slot ${slot}`);
      const normalizedProps = normalizeProps(props);
      let current: MountedChild[] = [];
      let currentKey = '';
      const binding = createSerialBinding(
        options,
        async () => {
          let contributions = options.resolveSlotCandidates(slot, kind);
          if (contributions.length > 0) {
            await options.activate(contributions);
            contributions = options.resolveSlotCandidates(slot, kind);
          }
          const nextKey = contributions.map(contributionKey).join('\n');
          if (nextKey === currentKey) return;
          for (const child of [...current].reverse()) await disposeMountedChild(child, 'Slot owners changed');
          current = [];
          currentKey = '';
          const mounted: MountedChild[] = [];
          try {
            for (const contribution of contributions) {
              mounted.push(await mountContribution(options, container, contribution, normalizedProps, 'slot', slot));
            }
          } catch (error) {
            for (const child of [...mounted].reverse()) await disposeMountedChild(child, error);
            throw error;
          }
          current = mounted;
          currentKey = nextKey;
        },
        async (reason) => {
          for (const child of [...current].reverse()) await disposeMountedChild(child, reason);
          current = [];
          currentKey = '';
        },
        () => {
          const index = bindings.indexOf(binding);
          if (index >= 0) bindings.splice(index, 1);
        },
      );
      return own(binding);
    },

    dispose: async (reason?: unknown) => {
      if (disposed) return;
      disposed = true;
      for (const binding of [...bindings].reverse()) await binding.dispose(reason);
      bindings.length = 0;
    },
  };
};
