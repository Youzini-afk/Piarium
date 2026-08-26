import type {
  ModelDescriptor,
  SessionSnapshot,
  ThinkingLevel,
} from '@piarium/protocol';

export interface PiComposerModelSelection {
  id: string;
  provider: string;
}

export interface PiComposerSessionConfig {
  model?: PiComposerModelSelection;
  thinkingLevel?: ThinkingLevel;
}

interface PiComposerSessionConfigActions {
  selectModel(
    sessionId: string,
    model: Pick<ModelDescriptor, 'id' | 'provider'>,
  ): Promise<SessionSnapshot>;
  selectThinking(sessionId: string, level: ThinkingLevel): Promise<SessionSnapshot>;
}

export const configurePiComposerSession = async (
  initialSnapshot: SessionSnapshot,
  config: PiComposerSessionConfig,
  fallbackModel: PiComposerModelSelection | undefined,
  actions: PiComposerSessionConfigActions,
): Promise<SessionSnapshot> => {
  let snapshot = initialSnapshot;
  const model = config.model ?? fallbackModel;
  if (model) {
    snapshot = await actions.selectModel(snapshot.sessionId, model);
  }
  if (!config.thinkingLevel) return snapshot;

  const supported = snapshot.model?.supportedThinkingLevels ?? [];
  if (supported.length > 0 && !supported.includes(config.thinkingLevel)) {
    throw new Error(
      `${snapshot.model?.name ?? snapshot.model?.id ?? 'Selected model'} does not support ${config.thinkingLevel} thinking`,
    );
  }
  return actions.selectThinking(snapshot.sessionId, config.thinkingLevel);
};
