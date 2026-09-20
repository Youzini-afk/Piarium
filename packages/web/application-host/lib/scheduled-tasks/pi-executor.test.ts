import { describe, expect, it, vi } from 'vitest';
import { createPiScheduledTaskExecutor } from './pi-executor.js';
import type { ScheduledTaskExecution } from '../projects/project-config.js';
import type { SessionSettleOutcome } from './session-settle.js';

type Broker = Parameters<typeof createPiScheduledTaskExecutor>[0]['broker'];
interface BrokerCall { method: string; params: unknown; sessionID: string }

const task = (overrides: Partial<ScheduledTaskExecution> = {}) => ({
  execution: {
    modelID: 'gpt-5',
    prompt: 'Inspect the project',
    providerID: 'openai',
    ...overrides,
  },
});

describe('Pi scheduled task executor', () => {
  it('creates a Pi session, selects the model and dispatches a prompt', async () => {
    const calls: BrokerCall[] = [];
    const broker = {
      createSession: vi.fn(async () => ({ sessionId: 'pi-session-1' })),
      requestForSession: vi.fn(async (sessionID: string, method: string, params: unknown) => {
        calls.push({ method, params, sessionID });
        return method === 'agent.prompt' ? { accepted: true } : {};
      }),
    };
    const onSessionCreated = vi.fn();
    const execute = createPiScheduledTaskExecutor({ broker: broker as unknown as Broker });

    await expect(execute({
      onSessionCreated,
      projectPath: 'C:/project/piarium',
      task: task({ thinkingLevel: 'high' }),
      title: 'Nightly review',
    })).resolves.toEqual({ dispatchedAsCommand: false, sessionID: 'pi-session-1' });

    expect(broker.createSession).toHaveBeenCalledWith('C:/project/piarium', 'Nightly review');
    expect(onSessionCreated).toHaveBeenCalledWith('pi-session-1');
    expect(calls).toEqual([
      {
        method: 'model.select',
        params: { modelId: 'gpt-5', provider: 'openai', sessionId: 'pi-session-1' },
        sessionID: 'pi-session-1',
      },
      {
        method: 'thinking.select',
        params: { level: 'high', sessionId: 'pi-session-1' },
        sessionID: 'pi-session-1',
      },
      {
        method: 'agent.prompt',
        params: { sessionId: 'pi-session-1', text: 'Inspect the project' },
        sessionID: 'pi-session-1',
      },
    ]);
  });

  it('routes slash commands through the Pi command runtime', async () => {
    const broker = {
      createSession: vi.fn(async () => ({ sessionId: 'pi-session-2' })),
      requestForSession: vi.fn(async () => ({})),
    };
    const execute = createPiScheduledTaskExecutor({ broker: broker as unknown as Broker });

    await expect(execute({
      projectPath: 'C:/project/piarium',
      task: task({ prompt: '/review src/components' }),
      title: 'Review',
    })).resolves.toEqual({ dispatchedAsCommand: true, sessionID: 'pi-session-2' });
    expect(broker.requestForSession).toHaveBeenLastCalledWith('pi-session-2', 'command.execute', {
      command: '/review src/components',
      sessionId: 'pi-session-2',
    });
  });

  it('starts a persisted Pi-native goal before dispatching the scheduled prompt', async () => {
    const calls: BrokerCall[] = [];
    const broker = {
      createSession: vi.fn(async () => ({ sessionId: 'pi-session-goal' })),
      requestForSession: vi.fn(async (sessionID: string, method: string, params: unknown) => {
        calls.push({ method, params, sessionID });
        return method === 'agent.prompt' ? { accepted: true } : {};
      }),
    };
    const execute = createPiScheduledTaskExecutor({ broker: broker as unknown as Broker });
    await execute({
      projectPath: 'C:/project/piarium',
      task: task({ goalTokenBudget: 25_000, runAsGoal: true }),
      title: 'Goal task',
    });
    expect(calls.map((call) => call.method)).toEqual([
      'model.select',
      'session.features.mutate',
      'agent.prompt',
    ]);
    const goalCall = calls[1];
    if (!goalCall) throw new Error('Expected goal mutation call');
    expect(goalCall.params).toEqual({
      mutation: {
        objective: 'Inspect the project',
        tokenBudget: 25_000,
        type: 'goal.start',
      },
      sessionId: 'pi-session-goal',
    });
  });

  it('keeps the created Pi session ID on dispatch failures', async () => {
    const broker = {
      createSession: vi.fn(async () => ({ sessionId: 'pi-session-failed' })),
      requestForSession: vi.fn(async (_sessionID: string, method: string) => {
        if (method === 'agent.prompt') return { accepted: false };
        return {};
      }),
    };
    const execute = createPiScheduledTaskExecutor({ broker: broker as unknown as Broker });

    await expect(execute({
      projectPath: 'C:/project/piarium',
      task: task(),
      title: 'Review',
    })).rejects.toMatchObject({ sessionID: 'pi-session-failed' });
  });

  it('reports success only after the dispatched run actually settles', async () => {
    let settle: ((outcome: SessionSettleOutcome) => void) | undefined;
    const broker = {
      createSession: vi.fn(async () => ({ sessionId: 'pi-session-settle' })),
      requestForSession: vi.fn(async (_sessionID: string, method: string) => (
        method === 'agent.prompt' ? { accepted: true } : {}
      )),
    };
    const execute = createPiScheduledTaskExecutor({
      awaitCompletion: vi.fn((): Promise<SessionSettleOutcome> => new Promise((resolve) => { settle = resolve; })),
      broker: broker as unknown as Broker,
    });

    let resolved = false;
    const run = execute({
      projectPath: 'C:/project/piarium',
      task: task(),
      title: 'Review',
    }).then((result) => { resolved = true; return result; });

    // agent.prompt was accepted — but that is only the receipt, not the result.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);

    settle?.({ settled: true });
    await expect(run).resolves.toEqual({ dispatchedAsCommand: false, sessionID: 'pi-session-settle' });
  });

  it('fails the task when the run aborts or the session dies mid-run', async () => {
    const broker = {
      createSession: vi.fn(async () => ({ sessionId: 'pi-session-doomed' })),
      requestForSession: vi.fn(async () => ({ accepted: true })),
    };
    const execute = createPiScheduledTaskExecutor({
      awaitCompletion: async () => ({ aborted: true, error: 'the run was aborted before completion', settled: true }),
      broker: broker as unknown as Broker,
    });
    await expect(execute({
      projectPath: 'C:/project/piarium',
      task: task(),
      title: 'Review',
    })).rejects.toMatchObject({ message: 'the run was aborted before completion', sessionID: 'pi-session-doomed' });

    const executeDead = createPiScheduledTaskExecutor({
      awaitCompletion: async () => ({ error: 'session ended before the run settled', settled: false }),
      broker: broker as unknown as Broker,
    });
    await expect(executeDead({
      projectPath: 'C:/project/piarium',
      task: task(),
      title: 'Review',
    })).rejects.toMatchObject({ sessionID: 'pi-session-doomed' });
  });

  it('reads the persisted goal outcome after the run settles', async () => {
    const broker = (goal: { status: string; statusReason?: string } | undefined) => ({
      createSession: vi.fn(async () => ({ sessionId: 'pi-session-goal' })),
      requestForSession: vi.fn(async (_sessionID: string, method: string) => {
        if (method === 'agent.prompt') return { accepted: true };
        if (method === 'session.features.get') return goal ? { goal } : {};
        return {};
      }),
    });
    const settled = { awaitCompletion: async () => ({ settled: true }) };

    const executeComplete = createPiScheduledTaskExecutor({
      ...settled,
      broker: broker({ status: 'complete' }) as unknown as Broker,
    });
    await expect(executeComplete({
      projectPath: 'C:/project/piarium',
      task: task({ runAsGoal: true }),
      title: 'Goal task',
    })).resolves.toMatchObject({ sessionID: 'pi-session-goal' });

    const executeBlocked = createPiScheduledTaskExecutor({
      ...settled,
      broker: broker({ status: 'blocked', statusReason: 'missing data' }) as unknown as Broker,
    });
    await expect(executeBlocked({
      projectPath: 'C:/project/piarium',
      task: task({ runAsGoal: true }),
      title: 'Goal task',
    })).rejects.toThrow(/blocked: missing data/);

    // A goal parked on a follow-up wait is a deliberate pause, not a failure.
    const executeWaiting = createPiScheduledTaskExecutor({
      ...settled,
      broker: broker({ status: 'paused', statusReason: 'waiting' }) as unknown as Broker,
    });
    await expect(executeWaiting({
      projectPath: 'C:/project/piarium',
      task: task({ runAsGoal: true }),
      title: 'Goal task',
    })).resolves.toMatchObject({ sessionID: 'pi-session-goal' });
  });

  it('keeps a multi-turn goal running until a real terminal state', async () => {
    const completions: Array<(outcome: SessionSettleOutcome) => void> = [];
    let goalStatus = 'active';
    const broker = {
      createSession: vi.fn(async () => ({ sessionId: 'pi-session-multi-turn' })),
      requestForSession: vi.fn(async (_sessionID: string, method: string) => {
        if (method === 'agent.prompt') return { accepted: true };
        if (method === 'session.features.get') return { goal: { status: goalStatus } };
        return {};
      }),
    };
    const forgetCompletion = vi.fn();
    const execute = createPiScheduledTaskExecutor({
      awaitCompletion: () => new Promise((resolve) => { completions.push(resolve); }),
      forgetCompletion,
      broker: broker as unknown as Broker,
    });
    const run = execute({
      projectPath: 'C:/project/piarium',
      task: task({ runAsGoal: true }),
      title: 'Multi-turn goal',
    });

    await vi.waitFor(() => expect(completions).toHaveLength(1));
    completions[0]?.({ settled: true });
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    expect(forgetCompletion).not.toHaveBeenCalled();

    goalStatus = 'complete';
    completions[1]?.({ settled: true });
    await expect(run).resolves.toMatchObject({ sessionID: 'pi-session-multi-turn' });
    expect(forgetCompletion).toHaveBeenCalledWith('pi-session-multi-turn');
  });

  it('keeps a slash-command goal active until its actual terminal state', async () => {
    const completions: Array<(outcome: SessionSettleOutcome) => void> = [];
    let goalStatus = 'active';
    const broker = {
      createSession: vi.fn(async () => ({ sessionId: 'pi-session-command-goal' })),
      requestForSession: vi.fn(async (_sessionID: string, method: string) => {
        if (method === 'session.features.get') return { goal: { status: goalStatus } };
        return {};
      }),
    };
    const execute = createPiScheduledTaskExecutor({
      awaitCompletion: () => new Promise((resolve) => { completions.push(resolve); }),
      broker: broker as unknown as Broker,
    });
    let resolved = false;
    const run = execute({
      projectPath: 'C:/project/piarium',
      task: task({ prompt: '/review src', runAsGoal: true }),
      title: 'Command goal',
    }).then((result) => { resolved = true; return result; });

    await vi.waitFor(() => expect(completions).toHaveLength(1));
    completions[0]?.({ settled: true });
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    expect(resolved).toBe(false);

    goalStatus = 'complete';
    completions[1]?.({ settled: true });
    await expect(run).resolves.toEqual({ dispatchedAsCommand: true, sessionID: 'pi-session-command-goal' });
  });
});
