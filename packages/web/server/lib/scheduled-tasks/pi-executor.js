const buildScheduledInstructions = (execution) => [
  ...(typeof execution?.agent === 'string' && execution.agent.trim()
    ? [`Use the Pi agent role or profile named "${execution.agent.trim()}" for this turn when it is available.`]
    : []),
  ...(execution?.runAsGoal === true ? [
  '<system-reminder>',
  'Treat this scheduled task as an end-to-end goal. Continue using tools until the requested outcome is complete,',
  'verify the result before finishing, and report clearly what was completed and what remains.',
  ...(Number.isSafeInteger(execution.goalTokenBudget)
    ? [`The requested goal token budget is ${execution.goalTokenBudget}.`]
    : []),
  '</system-reminder>',
  ] : []),
].join('\n');

export const buildScheduledPiPrompt = (task) => {
  const prompt = typeof task?.execution?.prompt === 'string'
    ? task.execution.prompt.trim()
    : '';
  const instructions = buildScheduledInstructions(task?.execution);
  return prompt && instructions ? `${prompt}\n\n${instructions}` : prompt;
};

export const createPiScheduledTaskExecutor = ({ broker }) => {
  if (!broker || typeof broker.createSession !== 'function' || typeof broker.requestForSession !== 'function') {
    throw new Error('A Pi runtime broker is required for scheduled tasks');
  }

  return async ({ projectPath, task, title, onSessionCreated }) => {
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
          level: task.execution.thinkingLevel,
          sessionId: sessionID,
        });
      }

      const prompt = buildScheduledPiPrompt(task);
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
