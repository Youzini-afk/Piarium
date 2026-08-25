import { describe, expect, test } from 'vitest';

import { toDocumentWorkspaceEditInput } from './workspace-edit';

describe('language workspace edit adapter', () => {
  test('preserves text versions, annotations, and explicit unsupported resource operations', () => {
    const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const first = { workspaceId, resourceId: 'src/first.ts' };
    const second = { workspaceId, resourceId: 'src/second.ts' };
    expect(toDocumentWorkspaceEditInput(workspaceId, 'language:rename', {
      documentChanges: [
        {
          kind: 'text',
          resource: first,
          version: 4,
          edits: [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            newText: 'next',
            annotationId: 'rename',
          }],
        },
        { kind: 'rename', from: first, to: second },
      ],
      changeAnnotations: { rename: { label: 'Rename symbol', needsConfirmation: true } },
    })).toEqual({
      workspaceId,
      origin: 'language:rename',
      textEdits: [{
        identity: first,
        version: 4,
        edits: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
          newText: 'next',
          annotationId: 'rename',
        }],
      }],
      resourceOperations: [{ kind: 'rename', from: first, to: second }],
      changeAnnotations: { rename: { label: 'Rename symbol', needsConfirmation: true } },
    });
  });
});
