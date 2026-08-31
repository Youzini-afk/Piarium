import { expect, test } from 'bun:test';
import type {
  PiariumExtensionCatalogEntry,
  PiariumWorkbenchResolvedLayout,
} from '@piarium/extension-contract';
import {
  PIARIUM_WORKBENCH_REPLACEMENT_TARGETS,
  PIARIUM_WORKBENCH_SHELL_DATA_CONTRACT,
  PIARIUM_WORKBENCH_SLOTS,
} from '@piarium/extension-contract';
import type { SurfaceContribution } from '@piarium/extension-surface';
import { projectWorkbenchSeams } from './workbench-seams';

const agentEntry = (enabled = true): PiariumExtensionCatalogEntry => ({
  manifest: {
    schemaVersion: 1,
    id: 'piarium.builtin.agent-workspace',
    version: '1.0.0',
    engines: { piarium: '*' },
    contributions: [{
      contractVersion: 1,
      data: {
        contract: PIARIUM_WORKBENCH_SHELL_DATA_CONTRACT,
        seams: {
          web: {
            replacementTargets: [
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.agents,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.mcp,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.settings,
            ],
            slots: [],
          },
          desktop: {
            replacementTargets: [
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.agents,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.mcp,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.settings,
            ],
            slots: [],
          },
          mobile: {
            replacementTargets: [
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.agents,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.mcp,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.settings,
            ],
            slots: [],
          },
        },
      },
      id: 'piarium.builtin.agent-workspace.shell',
      kind: 'shell',
      replacement: { target: PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell },
      supports: ['web', 'desktop', 'mobile'],
    }],
  },
  source: { display: 'Agent', kind: 'builtin' },
  desired: { enabled, revision: 1, updatedAt: '2026-08-20T00:00:00.000Z' },
  actual: [],
  capabilityGrants: [],
  installedAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  resolvedVersion: '1.0.0',
  selectedVersion: '1.0.0',
});

const ideEntry = (enabled = true): PiariumExtensionCatalogEntry => ({
  manifest: {
    schemaVersion: 1,
    id: 'piarium.builtin.ide-workbench',
    version: '1.0.0',
    engines: { piarium: '*' },
    contributions: [{
      contractVersion: 1,
      data: {
        contract: PIARIUM_WORKBENCH_SHELL_DATA_CONTRACT,
        seams: {
          web: {
            replacementTargets: [
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.agents,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.mcp,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.settings,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.activity,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.primarySidebar,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.editor,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.secondarySidebar,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.panel,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.status,
            ],
            slots: Object.values(PIARIUM_WORKBENCH_SLOTS),
          },
          desktop: {
            replacementTargets: [
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.chatTimeline,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.chatComposer,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.agents,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.mcp,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.settings,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.activity,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.primarySidebar,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.editor,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.secondarySidebar,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.panel,
              PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.status,
            ],
            slots: Object.values(PIARIUM_WORKBENCH_SLOTS),
          },
        },
      },
      id: 'piarium.builtin.ide-workbench.shell',
      kind: 'shell',
      replacement: { target: PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell },
      supports: ['web', 'desktop'],
    }],
  },
  source: { display: 'IDE', kind: 'builtin' },
  desired: { enabled, revision: 1, updatedAt: '2026-08-20T00:00:00.000Z' },
  actual: [],
  capabilityGrants: [],
  installedAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  resolvedVersion: '1.0.0',
  selectedVersion: '1.0.0',
});

const layout = (selections: Record<string, string>): PiariumWorkbenchResolvedLayout => ({
  profileId: 'default',
  references: [],
  replacementSelections: selections,
});

const candidate = (id: string, target: string): SurfaceContribution => ({
  descriptor: {
    contractVersion: 1,
    data: {},
    id,
    kind: 'view',
    replacement: { target },
    supports: ['web'],
  },
  implementation: { render: () => null },
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

test('Agent does not show the six IDE structure targets', () => {
  const projections = projectWorkbenchSeams({
    layout: layout({ [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'piarium.builtin.agent-workspace.shell' }),
    shellContributionId: 'piarium.builtin.agent-workspace.shell',
    shellExtensionId: 'piarium.builtin.agent-workspace',
    shellStatus: 'ready',
    catalog: [agentEntry()],
    surface: 'web',
    visibleContributions: [],
  });
  const targets = new Set(projections.map((p) => p.target));
  expect(targets.has(PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.activity)).toBe(false);
  expect(targets.has(PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.primarySidebar)).toBe(false);
  expect(targets.has(PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.editor)).toBe(false);
  expect(targets.has(PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.secondarySidebar)).toBe(false);
  expect(targets.has(PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.panel)).toBe(false);
  expect(targets.has(PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.status)).toBe(false);
  expect(targets.has(PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator)).toBe(true);
});

test('IDE shows the six structure targets', () => {
  const projections = projectWorkbenchSeams({
    layout: layout({ [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'piarium.builtin.ide-workbench.shell' }),
    shellContributionId: 'piarium.builtin.ide-workbench.shell',
    shellExtensionId: 'piarium.builtin.ide-workbench',
    shellStatus: 'ready',
    catalog: [ideEntry()],
    surface: 'web',
    visibleContributions: [],
  });
  const targets = new Set(projections.map((p) => p.target));
  expect(targets.has(PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.activity)).toBe(true);
  expect(targets.has(PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.primarySidebar)).toBe(true);
  expect(targets.has(PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.editor)).toBe(true);
  expect(targets.has(PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.secondarySidebar)).toBe(true);
  expect(targets.has(PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.panel)).toBe(true);
  expect(targets.has(PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.status)).toBe(true);
});

test('Agent Mobile does not claim workspace.explorer support', () => {
  const projections = projectWorkbenchSeams({
    layout: layout({ [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'piarium.builtin.agent-workspace.shell' }),
    shellContributionId: 'piarium.builtin.agent-workspace.shell',
    shellExtensionId: 'piarium.builtin.agent-workspace',
    shellStatus: 'ready',
    catalog: [agentEntry()],
    surface: 'mobile',
    visibleContributions: [],
  });
  const explorer = projections.find((p) => p.target === PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer);
  expect(explorer).toBeUndefined();
});

test('IDE selection for a structure target becomes dormant when switching to Agent', () => {
  const projections = projectWorkbenchSeams({
    layout: layout({
      [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'piarium.builtin.agent-workspace.shell',
      [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.panel]: 'dev.example.panel',
    }),
    shellContributionId: 'piarium.builtin.agent-workspace.shell',
    shellExtensionId: 'piarium.builtin.agent-workspace',
    shellStatus: 'ready',
    catalog: [agentEntry()],
    surface: 'web',
    visibleContributions: [],
  });
  const panel = projections.find((p) => p.target === PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.panel);
  expect(panel?.status).toBe('dormant');
  expect(panel?.selected).toBe('dev.example.panel');
});

test('dormant selection becomes supported again when switching back to IDE', () => {
  const projections = projectWorkbenchSeams({
    layout: layout({
      [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'piarium.builtin.ide-workbench.shell',
      [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.panel]: 'dev.example.panel',
    }),
    shellContributionId: 'piarium.builtin.ide-workbench.shell',
    shellExtensionId: 'piarium.builtin.ide-workbench',
    shellStatus: 'ready',
    catalog: [ideEntry()],
    surface: 'web',
    visibleContributions: [candidate('dev.example.panel', PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.panel)],
  });
  const panel = projections.find((p) => p.target === PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.panel);
  expect(panel?.status).toBe('supported');
  expect(panel?.selected).toBe('dev.example.panel');
});

test('unsupported candidate does not appear in supported candidates', () => {
  const projections = projectWorkbenchSeams({
    layout: layout({ [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'piarium.builtin.agent-workspace.shell' }),
    shellContributionId: 'piarium.builtin.agent-workspace.shell',
    shellExtensionId: 'piarium.builtin.agent-workspace',
    shellStatus: 'ready',
    catalog: [agentEntry()],
    surface: 'web',
    visibleContributions: [candidate('dev.example.panel', PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.panel)],
  });
  const panel = projections.find((p) => p.target === PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.panel);
  // panel target is not supported by Agent shell, so even though a candidate exists,
  // it should not appear as supported
  expect(panel).toBeUndefined();
});

test('missing selected contribution is distinct from dormant', () => {
  const projections = projectWorkbenchSeams({
    layout: layout({
      [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'piarium.builtin.ide-workbench.shell',
      [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.editor]: 'dev.example.missing-editor',
    }),
    shellContributionId: 'piarium.builtin.ide-workbench.shell',
    shellExtensionId: 'piarium.builtin.ide-workbench',
    shellStatus: 'ready',
    catalog: [ideEntry()],
    surface: 'web',
    visibleContributions: [candidate('dev.example.available-editor', PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.editor)],
  });
  const editor = projections.find((p) => p.target === PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.editor);
  expect(editor?.status).toBe('missing-selection');
  expect(editor?.selected).toBe('dev.example.missing-editor');
  expect(editor?.status === 'missing-selection' ? editor.candidates.map((item) => item.descriptor.id) : [])
    .toEqual(['dev.example.available-editor']);
});

test('profile input object is not mutated', () => {
  const inputLayout = layout({
    [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'piarium.builtin.agent-workspace.shell',
  });
  const frozen = JSON.stringify(inputLayout);
  projectWorkbenchSeams({
    layout: inputLayout,
    shellContributionId: 'piarium.builtin.agent-workspace.shell',
    shellExtensionId: 'piarium.builtin.agent-workspace',
    shellStatus: 'ready',
    catalog: [agentEntry()],
    surface: 'web',
    visibleContributions: [],
  });
  expect(JSON.stringify(inputLayout)).toBe(frozen);
});

test('shell and transition are always platform', () => {
  const projections = projectWorkbenchSeams({
    layout: layout({ [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'piarium.builtin.agent-workspace.shell' }),
    shellContributionId: 'piarium.builtin.agent-workspace.shell',
    shellExtensionId: 'piarium.builtin.agent-workspace',
    shellStatus: 'ready',
    catalog: [agentEntry()],
    surface: 'web',
    visibleContributions: [candidate('dev.example.transition', PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.transition)],
  });
  const shell = projections.find((p) => p.target === PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell);
  expect(shell?.status).toBe('platform');
  const transition = projections.find((p) => p.target === PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.transition);
  expect(transition?.status).toBe('platform');
  expect(transition?.status === 'platform' ? transition.candidates.map((item) => item.descriptor.id) : [])
    .toEqual(['dev.example.transition']);
});

test('malformed shell contract shows existing selections as dormant, not supported', () => {
  const badEntry: PiariumExtensionCatalogEntry = {
    ...agentEntry(),
    manifest: {
      ...agentEntry().manifest,
      contributions: [{
        contractVersion: 1,
        data: { contract: 'wrong', seams: {} },
        id: 'piarium.builtin.agent-workspace.shell',
        kind: 'shell',
        replacement: { target: PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell },
        supports: ['web', 'desktop', 'mobile'],
      }],
    },
  };
  const projections = projectWorkbenchSeams({
    layout: layout({
      [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.shell]: 'piarium.builtin.agent-workspace.shell',
      [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator]: 'dev.example.nav',
    }),
    shellContributionId: 'piarium.builtin.agent-workspace.shell',
    shellExtensionId: 'piarium.builtin.agent-workspace',
    shellStatus: 'ready',
    catalog: [badEntry],
    surface: 'web',
    visibleContributions: [],
  });
  const nav = projections.find((p) => p.target === PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator);
  expect(nav?.status).toBe('dormant');
});
