import { describe, expect, it, vi } from 'vitest';
import { buildScheduledPiPrompt, createPiScheduledTaskExecutor } from './pi-executor.js';

const task = (overrides = {}) => ({
  execution: {
    modelID: 'gpt-5',
    prompt: 'Inspect the project',
    providerID: 'openai',
    ...overrides,
  },
});

describe('Pi scheduled task executor', () => {
  it('creates a Pi session, selects the model and dispatches a prompt', async () => {
    const calls = [];
    const broker = {
      createSession: vi.fn(async () => ({ sessionId: 'pi-session-1' })),
      requestForSession: vi.fn(async (sessionID, method, params) => {
        calls.push({ method, params, sessionID });
        return method === 'agent.prompt' ? { accepted: true } : {};
      }),
    };
    const onSessionCreated = vi.fn();
    const execute = createPiScheduledTaskExecutor({ broker });

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
    const execute = createPiScheduledTaskExecutor({ broker });

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

  it('adds explicit completion instructions in goal mode', () => {
    const prompt = buildScheduledPiPrompt(task({ runAsGoal: true }));
    expect(prompt).toContain('Inspect the project');
    expect(prompt).toContain('Treat this scheduled task as an end-to-end goal');
  });

  it('keeps the created Pi session ID on dispatch failures', async () => {
    const broker = {
      createSession: vi.fn(async () => ({ sessionId: 'pi-session-failed' })),
      requestForSession: vi.fn(async (_sessionID, method) => {
        if (method === 'agent.prompt') return { accepted: false };
        return {};
      }),
    };
    const execute = createPiScheduledTaskExecutor({ broker });

    await expect(execute({
      projectPath: 'C:/project/piarium',
      task: task(),
      title: 'Review',
    })).rejects.toMatchObject({ sessionID: 'pi-session-failed' });
  });
});
