import { describe, expect, test } from 'vitest';
import { parsePermissionSystemStatus } from './permissionSystemStatus';

describe('permission-system status', () => {
  test('parses the public Piarium projection without inventing policy state', () => {
    expect(parsePermissionSystemStatus({
      adjudicatesLocally: true,
      lastDecision: {
        agentName: null,
        matchedPattern: '*',
        origin: 'global',
        requestId: 'decision-1',
        resolution: 'policy_deny',
        result: 'deny',
        surface: 'write',
        value: '.env',
      },
      pending: [{
        agentName: 'worker',
        forwarding: {
          requesterAgentName: 'worker',
          requesterSessionId: 'child-1',
        },
        requestId: 'prompt-1',
        source: 'tool_call',
        surface: 'bash',
        value: 'git status',
      }],
      ready: true,
      version: 1,
    })?.pending[0]?.surface).toBe('bash');
  });

  test('rejects malformed snapshots and future versions', () => {
    expect(parsePermissionSystemStatus({ ready: true, version: 2 })).toBeNull();
    expect(parsePermissionSystemStatus({
      adjudicatesLocally: true,
      lastDecision: null,
      pending: [{ requestId: 'missing-fields' }],
      ready: true,
      version: 1,
    })).toBeNull();
  });
});
