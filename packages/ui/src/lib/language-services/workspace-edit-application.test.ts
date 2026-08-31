import { describe, expect, test, vi } from 'vitest';

import type { PiariumLanguageWorkspaceEdit } from '@piarium/application-client';
import { applyLanguageWorkspaceEdit } from './workspace-edit-application';

const identity = { workspaceId: 'workspace-one', resourceId: 'src/a.ts' };

const edit: PiariumLanguageWorkspaceEdit = {
  documentChanges: [{
    kind: 'text',
    resource: identity,
    version: 1,
    edits: [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      newText: 'b',
    }],
  }],
};

describe('applyLanguageWorkspaceEdit', () => {
  test('applies a single-file unannotated edit without an unnecessary review', async () => {
    const review = vi.fn();
    const registry = {
      prepareWorkspaceEdit: vi.fn(async () => ({
        status: 'ready' as const,
        groupId: 'group-one',
        workspaceId: 'workspace-one',
        origin: 'rename',
        files: [{ identity, beforeContent: 'a', afterContent: 'b', editCount: 1 }],
        requiresConfirmation: false,
      })),
      applyWorkspaceEdit: vi.fn(async () => ({ status: 'applied' as const, groupId: 'group-one', records: [{}] })),
      discardWorkspaceEdit: vi.fn(),
    };
    expect(await applyLanguageWorkspaceEdit({
      edit,
      kind: 'rename',
      origin: 'language:rename',
      registry: registry as never,
      review,
      workspaceId: 'workspace-one',
    })).toEqual({ status: 'applied', groupId: 'group-one', changedFiles: 1 });
    expect(review).not.toHaveBeenCalled();
  });

  test('discards the prepared transaction when a required review is cancelled', async () => {
    const registry = {
      prepareWorkspaceEdit: vi.fn(async () => ({
        status: 'ready' as const,
        groupId: 'group-two',
        workspaceId: 'workspace-one',
        origin: 'action',
        files: [{ identity, beforeContent: 'a', afterContent: 'b', editCount: 1 }],
        requiresConfirmation: true,
      })),
      applyWorkspaceEdit: vi.fn(),
      discardWorkspaceEdit: vi.fn(),
    };
    expect(await applyLanguageWorkspaceEdit({
      edit,
      kind: 'code-action',
      origin: 'language:code-action',
      registry: registry as never,
      review: vi.fn(async () => false),
      workspaceId: 'workspace-one',
    })).toEqual({ status: 'cancelled' });
    expect(registry.discardWorkspaceEdit).toHaveBeenCalledWith('group-two');
    expect(registry.applyWorkspaceEdit).not.toHaveBeenCalled();
  });
});
