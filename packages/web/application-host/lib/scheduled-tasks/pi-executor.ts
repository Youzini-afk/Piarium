import type { HostMethodParams } from '@piarium/protocol';
import type { PiRuntimeBroker } from '@piarium/runtime-broker';
import type { ScheduledTask, ScheduledTaskExecution } from '../projects/project-config.js';

const buildScheduledInstructions = (execution: ScheduledTaskExecution): string => [
  ...(typeof execution?.agent === 'string' && execution.agent.trim()
    ? [`Use the Pi agent role or profile named "${execution.agent.trim()}" for this turn when it is available.`]
    : []),
].join('\n');

type ScheduledExecutionTask = Pick<ScheduledTask, 'execution'>;

export const buildScheduledPiPrompt = (task: ScheduledExecutionTask): string => {
  const prompt = typeof task?.execution?.prompt === 'string'
    ? task.execution.prompt.trim()
    : '';
  const instructions = buildScheduledInstructions(task?.execution);
  return prompt && instructions ? `${prompt}\n\n${instructions}` : prompt;
};

export const createPiScheduledTaskExecutor = ({ broker }: {
  broker: Pick<PiRuntimeBroker, 'createSession' | 'requestForSession'>;
}) => {
  if (!broker || typeof broker.createSession !== 'function' || typeof broker.requestForSession !== 'function') {
    throw new Error('A Pi runtime broker is required for scheduled tasks');
  }

  return async ({ projectPath, task, title, onSessionCreated }: {
    onSessionCreated?: (sessionId: string) => void;
    projectPath: string;
    task: ScheduledExecutionTask;
    title: string;
  }) => {
    const snapshot = await broker.createSession(projectPath, title);
    const sessionID = snapshot.sessionId;
    try {
      onSessionCreated?.(sessionID);
      await broker.requestForSession(sessionID, 'model.select', {
        modelId: task.execution.modelID,
        provider: task.execution.providerID,
        sessionId: sessionID,
      });
      if (task.execution.thinkingLevel) {
        await broker.requestForSession(sessionID, 'thinking.select', {
          level: task.execution.thinkingLevel as HostMethodParams<'thinking.select'>['level'],
          sessionId: sessionID,
        });
      }

      const prompt = buildScheduledPiPrompt(task);
      if (task.execution.runAsGoal === true) {
        await broker.requestForSession(sessionID, 'session.features.mutate', {
          mutation: {
            objective: typeof task.execution.prompt === 'string' ? task.execution.prompt.trim() : prompt,
            ...(typeof task.execution.goalTokenBudget === 'number'
              && Number.isSafeInteger(task.execution.goalTokenBudget)
              && task.execution.goalTokenBudget > 0
              ? { tokenBudget: task.execution.goalTokenBudget }
              : {}),
            type: 'goal.start',
          },
          sessionId: sessionID,
        });
      }
      const dispatchedAsCommand = prompt.startsWith('/');
      if (dispatchedAsCommand) {
        await broker.requestForSession(sessionID, 'command.execute', {
          command: prompt,
          sessionId: sessionID,
        });
      } else {
        const result = await broker.requestForSession(sessionID, 'agent.prompt', {
          sessionId: sessionID,
          text: prompt,
        });
        if (result.accepted !== true) {
          throw new Error('Pi did not accept the scheduled task prompt');
        }
      }

      return { dispatchedAsCommand, sessionID };
    } catch (error) {
      if (error && typeof error === 'object' && !('sessionID' in error)) {
        Object.defineProperty(error, 'sessionID', {
          configurable: true,
          enumerable: false,
          value: sessionID,
        });
      }
      throw error;
    }
  };
};

export { buildScheduledInstructions };
