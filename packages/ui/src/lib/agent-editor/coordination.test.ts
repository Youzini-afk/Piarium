import { afterEach, describe, expect, test } from 'bun:test';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { addEditorContextAttachment, consumeEditorContextAttachments, listEditorContextAttachments, resetEditorContextAttachments, restoreEditorContextAttachments } from './attachments';
import { projectEditorContextAttachments } from './projection';
import { extractToolFileChanges, recordHintsFromToolCall, peekAgentFileChangeHint, resetAgentFileChangeHints } from './hints';
import { applyHunkDecisions, parseUnifiedHunks } from './patch';
import { computeThreeWayMerge, applyMergeDecisions } from './merge';
import { sliceDocumentRange } from './range';
import type { EditorContextAttachment } from './types';

const runtimeKey = getRuntimeKey();

afterEach(() => {
  resetEditorContextAttachments();
  resetAgentFileChangeHints();
});

const attachment = (overrides: Partial<EditorContextAttachment> = {}): EditorContextAttachment => ({
  id: overrides.id ?? 'att-1',
  runtimeKey,
  sessionId: 'session-a',
  workspaceId: 'ws-1',
  resourceId: 'src/a.ts',
  label: 'a.ts',
  documentRevision: 'rev-1',
  localEditRevision: 3,
  source: 'saved',
  kind: 'editor',
  ...overrides,
});

describe('editor context attachments', () => {
  test('consume is scoped to runtime and session', () => {
    addEditorContextAttachment(attachment());
    addEditorContextAttachment(attachment({ id: 'att-2', sessionId: 'session-b', resourceId: 'src/b.ts' }));
    expect(listEditorContextAttachments(runtimeKey, 'session-a')).toHaveLength(1);
    const taken = consumeEditorContextAttachments(runtimeKey, 'session-a');
    expect(taken).toHaveLength(1);
    expect(listEditorContextAttachments(runtimeKey, 'session-a')).toHaveLength(0);
    expect(listEditorContextAttachments(runtimeKey, 'session-b')).toHaveLength(1);
    restoreEditorContextAttachments(taken);
    expect(listEditorContextAttachments(runtimeKey, 'session-a')).toHaveLength(1);
  });

  test('rejects attachments captured for another runtime', () => {
    expect(addEditorContextAttachment(attachment({ runtimeKey: 'other-host' }))).toEqual({ status: 'wrong-runtime' });
  });
});

describe('unsaved attachment projection', () => {
  test('saved attachments do not include buffer text and unsaved ones say disk cannot see them', () => {
    const saved = projectEditorContextAttachments('Please review', [attachment()]);
    expect(saved).toContain('Pi file tools can read the current disk contents');
    expect(saved).not.toContain('const value');
    const unsaved = projectEditorContextAttachments('', [attachment({
      source: 'unsaved-buffer',
      kind: 'selection',
      text: 'const value = 1;',
      languageId: 'typescript',
    })]);
    expect(unsaved).toContain('Pi file tools cannot see it on disk');
    expect(unsaved).toContain('const value = 1;');
  });
});

describe('agent file change hints', () => {
  test('extracts write and apply_patch paths without copying plugin history', () => {
    expect(extractToolFileChanges('write', { path: 'src/a.ts', content: 'secret' })).toEqual([
      { path: 'src/a.ts', kind: 'write' },
    ]);
    expect(extractToolFileChanges('apply_patch', {
      patchText: '*** Begin Patch\n*** Update File: src/b.ts\n@@ -1 +1 @@\n-a\n+b\n*** End Patch\n',
    })).toEqual([{ path: 'src/b.ts', kind: 'patch' }]);
    expect(extractToolFileChanges('bash', { command: 'rm src/a.ts' })).toEqual([]);
  });

  test('records a hint that watcher reconciliation can read', () => {
    recordHintsFromToolCall({
      runtimeKey,
      sessionId: 'session-a',
      toolCallId: 'tool-1',
      toolName: 'write',
      args: { filePath: 'D:/work/src/a.ts' },
      workspaceId: 'ws-1',
      workspaceRoot: 'D:/work',
    });
    expect(peekAgentFileChangeHint({ workspaceId: 'ws-1', resourceId: 'src/a.ts' })?.toolCallId).toBe('tool-1');
  });
});

describe('patch hunk apply and revert', () => {
  const original = 'one\ntwo\nthree';
  const patch = [
    '@@ -1,3 +1,3 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
  ].join('\n');

  test('accepts and rejects hunks without applying mismatched text', () => {
    const hunks = parseUnifiedHunks(patch);
    expect(hunks).toHaveLength(1);
    expect(applyHunkDecisions(original, hunks, ['accept'])).toEqual({ status: 'applied', content: 'one\nTWO\nthree' });
    expect(applyHunkDecisions(original, hunks, ['reject'])).toEqual({ status: 'applied', content: original });
    expect(applyHunkDecisions(original, hunks, ['accept'], 'revert').status).toBe('mismatch');
    expect(applyHunkDecisions('one\nTWO\nthree', hunks, ['accept'], 'revert')).toEqual({
      status: 'applied',
      content: original,
    });
  });
});

describe('three-way merge', () => {
  test('classifies ours, theirs, and overlapping conflict', () => {
    expect(computeThreeWayMerge('base', 'base', 'theirs')).toEqual([{ kind: 'theirs', text: 'theirs' }]);
    expect(computeThreeWayMerge('base', 'ours', 'base')).toEqual([{ kind: 'ours', text: 'ours' }]);
    expect(computeThreeWayMerge('base', 'ours', 'theirs')).toEqual([
      { kind: 'conflict', ancestor: 'base', ours: 'ours', theirs: 'theirs' },
    ]);
    expect(applyMergeDecisions(computeThreeWayMerge('base', 'ours', 'theirs'), [
      { index: 0, choice: 'theirs' },
    ])).toBe('theirs');
  });
});

describe('range slice', () => {
  test('slices 1-based editor ranges', () => {
    expect(sliceDocumentRange('alpha\nbeta\ngamma', {
      startLine: 2,
      startColumn: 1,
      endLine: 2,
      endColumn: 5,
    })).toBe('beta');
  });
});
