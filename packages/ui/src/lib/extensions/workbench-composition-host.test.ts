import { expect, test } from 'bun:test';
import type { JsonObject } from '@piarium/extension-contract';
import type { SurfaceContribution } from '@piarium/extension-surface';
import { createWorkbenchCompositionHost } from './workbench-composition-host';

const makeContribution = (id: string): SurfaceContribution => ({
  descriptor: {
    contractVersion: 1,
    data: {},
    id,
    kind: 'view',
    replacement: { target: 'workbench.test' },
    supports: ['web'],
  },
  implementation: {
    mount: (container: HTMLElement) => {
      container.textContent = `mounted:${id}`;
      return () => { container.textContent = ''; };
    },
  },
  owner: {
    desiredRevision: 1,
    entrypointId: 'main',
    extensionId: 'dev.example',
    extensionVersion: '1.0.0',
    generation: 1,
    hostId: 'host-1',
    realmId: 'realm-1',
  },
});

const owner = {
  desiredRevision: 1,
  entrypointId: 'main',
  extensionId: 'dev.example.shell',
  extensionVersion: '1.0.0',
  generation: 1,
  hostId: 'host-1',
  realmId: 'realm-1',
};

// Minimal DOM stub for tests that don't have a full jsdom environment.
const createContainer = (): HTMLElement => {
  const store: Record<string, unknown> = {};
  const children: HTMLElement[] = [];
  const element = {
    textContent: '',
    get children() { return children; },
    appendChild(child: HTMLElement) { children.push(child); return child; },
    style: store,
  } as unknown as HTMLElement;
  return element;
};

const createChildContainer = (): HTMLElement => {
  return createContainer();
};

// Patch document.createElement for the slot test
const ensureDocumentStub = () => {
  if (typeof document === 'undefined') {
    (globalThis as Record<string, unknown>).document = {
      createElement: () => createChildContainer(),
    };
  }
};

test('mountReplacement mounts the resolved contribution', async () => {
  const contribution = makeContribution('dev.example.replace');
  const container = createContainer();
  const host = createWorkbenchCompositionHost({
    owner,
    onError: () => {},
    resolveReplacement: () => ({ contribution, props: {} }),
    resolveSlotCandidates: () => [],
  });
  const child = await host.mountReplacement({ container, target: 'workbench.test' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(container.textContent).toBe('mounted:dev.example.replace');
  await child.dispose();
  expect(container.textContent).toBe('');
});

test('mountReplacement returns no-op child when no candidate', async () => {
  const container = createContainer();
  const host = createWorkbenchCompositionHost({
    owner,
    onError: () => {},
    resolveReplacement: () => undefined,
    resolveSlotCandidates: () => [],
  });
  const child = await host.mountReplacement({ container, target: 'workbench.test' });
  await child.dispose(); // should not throw
  expect(container.textContent).toBe('');
});

test('mountSlot mounts all resolved contributions in child containers', async () => {
  ensureDocumentStub();
  const contributions = [makeContribution('dev.example.slot1'), makeContribution('dev.example.slot2')];
  const container = createContainer();
  const host = createWorkbenchCompositionHost({
    owner,
    onError: () => {},
    resolveReplacement: () => undefined,
    resolveSlotCandidates: () => contributions,
  });
  const child = await host.mountSlot({ container, slot: 'workbench.test.views' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(container.children.length).toBe(2);
  expect(container.children[0].textContent).toBe('mounted:dev.example.slot1');
  expect(container.children[1].textContent).toBe('mounted:dev.example.slot2');
  await child.dispose();
  expect(container.children[0].textContent).toBe('');
  expect(container.children[1].textContent).toBe('');
});

test('mountSlot returns no-op child when no candidates', async () => {
  const container = createContainer();
  const host = createWorkbenchCompositionHost({
    owner,
    onError: () => {},
    resolveReplacement: () => undefined,
    resolveSlotCandidates: () => [],
  });
  const child = await host.mountSlot({ container, slot: 'workbench.test.views' });
  await child.dispose();
  expect(container.children.length).toBe(0);
});

test('mountSlot passes props to contributions', async () => {
  ensureDocumentStub();
  const contributions = [makeContribution('dev.example.slot')];
  const container = createContainer();
  let receivedProps: JsonObject | undefined;
  const host = createWorkbenchCompositionHost({
    owner,
    onError: () => {},
    resolveReplacement: () => undefined,
    resolveSlotCandidates: () => contributions.map((c) => ({
      ...c,
      implementation: {
        mount: (_container: HTMLElement, context: { props: JsonObject }) => {
          receivedProps = context.props;
          return () => {};
        },
      },
    })),
  });
  await host.mountSlot({ container, slot: 'workbench.test.views', props: { foo: 'bar' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(receivedProps).toEqual({ foo: 'bar' });
});
