import { describe, expect, it, mock } from 'bun:test';
import { createPiSessionAutomationRuntime } from './runtime.js';

const userEntry = {
  id: 'user-1',
  message: { content: 'Implement the feature', role: 'user', timestamp: 1 },
  parentId: null,
  timestamp: '2026-08-02T00:00:00.000Z',
  type: 'message',
};

const assistantEntry = {
  id: 'assistant-1',
  message: {
    api: 'test',
    content: [{ text: 'Implemented and verified the feature.', type: 'text' }],
    model: 'small-test',
    provider: 'faux',
    role: 'assistant',
    stopReason: 'stop',
    timestamp: 2,
    usage: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      input: 50,
      output: 20,
      totalTokens: 70,
    },
  },
  parentId: 'user-1',
  timestamp: '2026-08-02T00:00:01.000Z',
  type: 'message',
};

const goal = {
  auditFailStreak: 0,
  blockedStreak: 0,
  createdAt: 1,
  id: 'goal-1',
  objective: 'Implement and verify the feature',
  status: 'active',
  tokenBaseline: 10,
  tokensUsed: 0,
  turnsUsed: 0,
  updatedAt: 1,
};

const createHarness = ({ audit = { note: 'Verified.', verdict: 'complete' }, withGoal = true } = {}) => {
  let features = {
    ...(withGoal ? { goal: { ...goal } } : {}),
    revision: 1,
    schemaVersion: 1,
  };
  const prompts = [];
  const mutations = [];
  const broker = {
    requestForSession: mock(async (_sessionId, method, params) => {
      if (method === 'session.features.get') return features;
      if (method === 'session.snapshot') return {
        activeTools: [],
        busy: false,
        cwd: 'D:/work',
        features,
        followUp: [],
        followUpMode: 'all',
        isCompacting: false,
        isStreaming: false,
        leafId: assistantEntry.id,
        pendingMessageCount: 0,
        retryAttempt: 0,
        sessionId: 'session-1',
        steering: [],
        steeringMode: 'all',
        thinkingLevel: 'medium',
      };
      if (method === 'session.entries') return {
        entries: [userEntry, assistantEntry],
        leafId: assistantEntry.id,
        scope: 'branch',
        sessionId: 'session-1',
      };
      if (method === 'session.stats') return {
        assistantMessages: 1,
        cost: 0,
        sessionId: 'session-1',
        tokens: { cacheRead: 0, cacheWrite: 0, input: 80, output: 30, total: 110 },
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 2,
        userMessages: 1,
      };
      if (method === 'session.features.mutate') {
        mutations.push(params.mutation);
        if (params.mutation.type === 'goal.update') {
          features = {
            ...features,
            goal: { ...features.goal, ...params.mutation, type: undefined },
            revision: features.revision + 1,
          };
          delete features.goal.type;
        } else if (params.mutation.type === 'assist.set') {
          features = {
            ...features,
            assist: { ...params.mutation, type: undefined },
            revision: features.revision + 1,
          };
          delete features.assist.type;
        }
        return features;
      }
      if (method === 'agent.prompt') {
        prompts.push(params.text);
        return { accepted: true };
      }
      throw new Error(`Unexpected method: ${method}`);
    }),
  };
  const generateSmallModelText = mock(async ({ system }) => ({
    modelID: 'audit-model',
    providerID: 'faux',
    text: system.includes('Audit a coding agent')
      ? JSON.stringify(audit)
      : JSON.stringify({ recap: 'Feature is verified.', suggestion: 'Package the application.' }),
  }));
  return {
    broker,
    generateSmallModelText,
    get features() { return features; },
    mutations,
    prompts,
  };
};

describe('Pi-native session automation', () => {
  it('settles an independently verified goal without sending another turn', async () => {
    const harness = createHarness();
    const onGoalSettled = mock(() => {});
    const runtime = createPiSessionAutomationRuntime({
      broker: harness.broker,
      getSmallModelService: async () => ({ generateSmallModelText: harness.generateSmallModelText }),
      onGoalSettled,
    });
    await runtime.runGoalNow('session-1');
    expect(harness.features.goal.status).toBe('complete');
    expect(harness.features.goal.tokensUsed).toBe(100);
    expect(harness.features.goal.lastEvaluatedEntryId).toBe('assistant-1');
    expect(harness.prompts).toEqual([]);
    expect(onGoalSettled).toHaveBeenCalledTimes(1);
    runtime.stop();
  });

  it('persists progress before dispatching an accepted continuation', async () => {
    const harness = createHarness({ audit: { note: 'More work remains.', verdict: 'continue' } });
    const runtime = createPiSessionAutomationRuntime({
      broker: harness.broker,
      getSmallModelService: async () => ({ generateSmallModelText: harness.generateSmallModelText }),
    });
    await runtime.runGoalNow('session-1');
    expect(harness.features.goal.status).toBe('active');
    expect(harness.features.goal.turnsUsed).toBe(1);
    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0]).toContain('Implement and verify the feature');
    runtime.stop();
  });

  it('stores a fresh recap and one-click follow-up on the Pi session branch', async () => {
    const harness = createHarness({ withGoal: false });
    const runtime = createPiSessionAutomationRuntime({
      broker: harness.broker,
      getSmallModelService: async () => ({ generateSmallModelText: harness.generateSmallModelText }),
      readSettings: async () => ({ sessionRecapEnabled: true, sessionSuggestionEnabled: true }),
    });
    await runtime.runAssistNow('session-1');
    expect(harness.features.assist).toMatchObject({
      forEntryId: 'assistant-1',
      recap: 'Feature is verified.',
      suggestion: 'Package the application.',
    });
    runtime.stop();
  });
});
