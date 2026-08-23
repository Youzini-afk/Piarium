import { describe, expect, test } from 'vitest';
import { PIARIUM_BUILTIN_TRANSITION_SCENE_EXTENSION } from '@piarium/extension-builtins';
import { PIARIUM_WORKBENCH_REPLACEMENT_TARGETS } from '@piarium/extension-contract';
import type { SurfaceContribution, SurfaceRegistrySnapshot } from '@piarium/extension-surface';
import {
  findCapturedWorkbenchTransitionScene,
  resolveWorkbenchTransitionScene,
} from './workbench-transition-scene';

const descriptor = PIARIUM_BUILTIN_TRANSITION_SCENE_EXTENSION.manifest.contributions?.[0];
if (!descriptor) throw new Error('Built-in transition scene descriptor is unavailable');

const contribution = (generation = 1): SurfaceContribution => ({
  descriptor,
  implementation: { framework: 'test' },
  owner: {
    desiredRevision: 1,
    entrypointId: 'main',
    extensionId: PIARIUM_BUILTIN_TRANSITION_SCENE_EXTENSION.manifest.id,
    extensionVersion: PIARIUM_BUILTIN_TRANSITION_SCENE_EXTENSION.manifest.version,
    generation,
    hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
    realmId: 'transition-scene-test',
  },
});

const snapshot = (contributions: SurfaceContribution[]): SurfaceRegistrySnapshot => ({
  actual: [],
  contributions,
  layoutReferences: [],
  replacementSelections: {},
  revision: 1,
  serviceSelections: {},
  services: [],
  visibleContributions: contributions,
});

describe('Workbench Transition Scene selection', () => {
  test('uses the one declared fallback only when the target Profile has no explicit selection', () => {
    const fallback = contribution();
    const resolved = resolveWorkbenchTransitionScene(snapshot([fallback]), {});
    expect(resolved.status).toBe('ready');
    expect(resolved.scene?.contributionId).toBe(descriptor.id);
  });

  test('retains an explicit missing selection instead of silently choosing another scene', () => {
    const resolved = resolveWorkbenchTransitionScene(snapshot([contribution()]), {
      [PIARIUM_WORKBENCH_REPLACEMENT_TARGETS.transition]: 'dev.example.missing.transition',
    });
    expect(resolved).toEqual({ contribution: null, scene: null, status: 'missing' });
  });

  test('captures the complete owner generation and rejects a replacement generation mid-transition', () => {
    const first = contribution(3);
    const resolved = resolveWorkbenchTransitionScene(snapshot([first]), {});
    expect(resolved.status).toBe('ready');
    expect(findCapturedWorkbenchTransitionScene(snapshot([first]), resolved.scene)).toBe(first);
    expect(findCapturedWorkbenchTransitionScene(snapshot([contribution(4)]), resolved.scene)).toBeUndefined();
  });

  test('reports malformed scene data as failure rather than an empty catalog', () => {
    const malformed: SurfaceContribution = {
      ...contribution(),
      descriptor: { ...descriptor, data: { fallback: true } },
    };
    const resolved = resolveWorkbenchTransitionScene(snapshot([malformed]), {});
    expect(resolved.status).toBe('failed');
    expect(resolved.scene).toBeNull();
  });
});

