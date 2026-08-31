import type { SurfaceContribution } from '@piarium/extension-surface';

type MountDisposer = () => void | Promise<void>;

interface WorkbenchMountContext<TProps extends object> {
  readonly contributionId: string;
  readonly owner: Readonly<SurfaceContribution['owner']>;
  readonly props: Readonly<TProps>;
  reportError(error: unknown): void;
  readonly signal: AbortSignal;
}

export type WorkbenchMountImplementation<TProps extends object> = {
  mount(
    container: HTMLElement,
    context: WorkbenchMountContext<TProps>,
  ): void | MountDisposer | Promise<void | MountDisposer>;
};

type WorkbenchMountFailurePhase = 'dispose' | 'mount' | 'render';

export interface WorkbenchMountSession {
  dispose(reason?: unknown): Promise<void>;
  readonly mounted: Promise<void>;
  readonly signal: AbortSignal;
}

export const startWorkbenchMountSession = <TProps extends object>(options: {
  container: HTMLElement;
  contributionId: string;
  implementation: WorkbenchMountImplementation<TProps>;
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
