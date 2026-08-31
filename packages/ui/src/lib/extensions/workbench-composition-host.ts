import type { JsonObject, PiariumExtensionContributionKind } from '@piarium/extension-contract';
import type { SurfaceContribution } from '@piarium/extension-surface';
import { startWorkbenchMountSession, type WorkbenchMountSession } from './workbench-mount';

export interface PiariumWorkbenchChildMount {
  dispose(reason?: unknown): Promise<void>;
}

export interface PiariumWorkbenchCompositionHost {
  mountReplacement(options: {
    container: HTMLElement;
    target: string;
    props?: JsonObject;
  }): Promise<PiariumWorkbenchChildMount>;

  mountSlot(options: {
    container: HTMLElement;
    slot: string;
    kind?: PiariumExtensionContributionKind;
    props?: JsonObject;
  }): Promise<PiariumWorkbenchChildMount>;
}

interface ReplacementCandidate {
  contribution: SurfaceContribution;
  props: JsonObject;
}

export interface WorkbenchCompositionHostOptions {
  owner: SurfaceContribution['owner'];
  resolveReplacement(target: string): ReplacementCandidate | undefined;
  resolveSlotCandidates(slot: string, kind?: PiariumExtensionContributionKind): SurfaceContribution[];
  onError(error: unknown, phase: 'dispose' | 'mount' | 'render'): void;
}

const NO_OP_CHILD: PiariumWorkbenchChildMount = { dispose: () => Promise.resolve() };

/**
 * Create a framework-neutral composition host that a managed Shell can use
 * to mount child contributions (replacements and slots) into DOM containers.
 *
 * The host is bound to a single Shell mount owner. Replacement and slot
 * resolution is delegated to the caller via the options callbacks so the
 * host remains pure and testable.
 */
export const createWorkbenchCompositionHost = (
  options: WorkbenchCompositionHostOptions,
): PiariumWorkbenchCompositionHost => {
  const sessions = new Map<string, WorkbenchMountSession>();
  let counter = 0;

  const mountContribution = (
    container: HTMLElement,
    contribution: SurfaceContribution,
    props: JsonObject,
  ): PiariumWorkbenchChildMount => {
    const id = `composition-${++counter}`;
    const session = startWorkbenchMountSession({
      container,
      contributionId: contribution.descriptor.id,
      implementation: contribution.implementation as never,
      onError: options.onError,
      owner: options.owner,
      props: props as never,
    });
    sessions.set(id, session);
    return {
      dispose: async (reason?: unknown) => {
        const existing = sessions.get(id);
        if (!existing) return;
        sessions.delete(id);
        await existing.dispose(reason);
      },
    };
  };

  return {
    mountReplacement: async ({ container, target, props }) => {
      const candidate = options.resolveReplacement(target);
      if (!candidate) return NO_OP_CHILD;
      return mountContribution(container, candidate.contribution, { ...candidate.props, ...props });
    },
    mountSlot: async ({ container, slot, kind, props }) => {
      const contributions = options.resolveSlotCandidates(slot, kind);
      if (contributions.length === 0) return NO_OP_CHILD;
      // Mount each contribution in its own child container so multiple
      // contributions can coexist in the same slot.
      const children: PiariumWorkbenchChildMount[] = [];
      for (const contribution of contributions) {
        const childContainer = document.createElement('div');
        childContainer.className = 'piarium-workbench-slot-child';
        childContainer.style.display = 'contents';
        container.appendChild(childContainer);
        children.push(mountContribution(childContainer, contribution, props ?? {}));
      }
      return {
        dispose: async (reason?: unknown) => {
          await Promise.all(children.map((child) => child.dispose(reason)));
        },
      };
    },
  };
};
