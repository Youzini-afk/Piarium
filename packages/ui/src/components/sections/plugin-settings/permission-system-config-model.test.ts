import { describe, expect, test } from 'bun:test';
import { permissionSystemDraftIssues } from './permission-system-config-model';

describe('permission-system config model', () => {
  test('keeps an empty source empty instead of materializing plugin defaults', () => {
    const draft = {};
    expect(permissionSystemDraftIssues(draft, '{}\n')).toEqual([]);
    expect(draft).toEqual({});
  });

  test('accepts and preserves pattern maps including deny reasons', () => {
    const draft = {
      permission: {
        bash: {
          '*': 'ask',
          'npm *': { action: 'deny', reason: 'Use bun instead' },
        },
      },
    } as const;
    expect(permissionSystemDraftIssues(draft, JSON.stringify(draft, null, 2))).toEqual([]);
    expect(draft.permission.bash['npm *']).toEqual({ action: 'deny', reason: 'Use bun instead' });
  });

  test('allows comments but blocks the trailing commas rejected by the plugin', () => {
    expect(permissionSystemDraftIssues(
      { yoloMode: false },
      '{\n  // keep this comment\n  "yoloMode": false,\n}\n',
    ).some((issue) => issue.code === 'trailing-comma' && issue.field === '$document')).toBe(true);
    expect(permissionSystemDraftIssues(
      { yoloMode: false },
      '{\n  // keep this comment\n  "yoloMode": false\n}\n',
    )).toEqual([]);
  });

  test('rejects invalid permission, number, and boolean values', () => {
    const draft = {
      forwardingTimeoutMs: 1.5,
      permission: { read: 'sometimes' },
      yoloMode: 'yes',
    } as const;
    const issues = permissionSystemDraftIssues(draft, JSON.stringify(draft));
    expect(issues.some((issue) => issue.code === 'invalid-number' && issue.field === 'forwardingTimeoutMs')).toBe(true);
    expect(issues.some((issue) => issue.code === 'invalid-value' && issue.field === 'permission.read')).toBe(true);
    expect(issues.some((issue) => issue.code === 'invalid-boolean' && issue.field === 'yoloMode')).toBe(true);
  });

  test('validates known arrays and shell aliases', () => {
    const draft = {
      authorizerChain: [''],
      shellTools: { exec_command: { commandArgument: '', extra: 'ignored' } },
    };
    const issues = permissionSystemDraftIssues(draft, JSON.stringify(draft));
    expect(issues.some((issue) => issue.code === 'invalid-value' && issue.field === 'authorizerChain')).toBe(true);
    expect(issues.some((issue) => issue.code === 'invalid-value' && issue.field === 'shellTools.exec_command')).toBe(true);
  });

  test('rejects empty patterns and oversized custom denial reasons', () => {
    const draft = {
      permission: {
        bash: {
          '': 'ask',
          'npm *': { action: 'deny', reason: 'x'.repeat(501) },
        },
      },
    };
    expect(permissionSystemDraftIssues(draft, JSON.stringify(draft)).some((issue) => (
      issue.code === 'invalid-value' && issue.field === 'permission.bash'
    ))).toBe(true);
  });

  test('preserves but diagnoses top-level keys rejected by the current strict schema', () => {
    const draft = { futureRuntimeKnob: { mode: 'later' } } as const;
    expect(permissionSystemDraftIssues(draft, JSON.stringify(draft)).some((issue) => (
      issue.code === 'invalid-value' && issue.field === 'futureRuntimeKnob'
    ))).toBe(true);
    expect(draft.futureRuntimeKnob).toEqual({ mode: 'later' });
  });
});
