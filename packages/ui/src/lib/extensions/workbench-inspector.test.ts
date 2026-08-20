import { describe, expect, test } from 'bun:test';
import { PIARIUM_DEBUG_SERVICE_ID, PIARIUM_LANGUAGE_SERVICE_ID, PIARIUM_WORKBENCH_SLOTS } from '@piarium/extension-contract';
import {
  describeWorkbenchContributionPlacement,
  workbenchInspectorOwnsDocuments,
  workbenchInspectorOwnsLanguage,
  workbenchInspectorOwnsRun,
} from './workbench-inspector';

describe('workbench inspector summaries', () => {
  test('describe contribution placement and replacement without private state', () => {
    expect(describeWorkbenchContributionPlacement({
      id: 'dev.example.view',
      kind: 'view',
      placement: { slot: PIARIUM_WORKBENCH_SLOTS.primarySidebarViews, order: 10 },
    })).toEqual({
      id: 'dev.example.view',
      kind: 'view',
      placement: PIARIUM_WORKBENCH_SLOTS.primarySidebarViews,
    });
    expect(describeWorkbenchContributionPlacement({
      id: 'dev.example.shell',
      kind: 'shell',
      replacement: { target: 'workbench.shell' },
    }).replacement).toBe('workbench.shell');
  });

  test('identifies document and language owners from public service and capability ids', () => {
    expect(workbenchInspectorOwnsLanguage(PIARIUM_LANGUAGE_SERVICE_ID)).toBe(true);
    expect(workbenchInspectorOwnsRun(PIARIUM_DEBUG_SERVICE_ID)).toBe(true);
    expect(workbenchInspectorOwnsDocuments('workspace.documents')).toBe(true);
    expect(workbenchInspectorOwnsDocuments('workspace.search')).toBe(false);
  });
});
