import React from 'react';
import type {
  PiAssistantMessage,
  PiSessionEntry,
} from '@varin/protocol';
import {
  aggregateAssistantUsage,
  assistantMessagesForTurn,
  assistantTokensPerSecond,
} from '@/lib/pi-runtime/usagePresentation';
import { PiAssistantUsageFooter } from './PiAssistantUsageFooter';

const isPiAssistantTurnComplete = (
  entries: readonly PiSessionEntry[],
  liveAssistant?: PiAssistantMessage,
): boolean => {
  const last = assistantMessagesForTurn(entries, liveAssistant).at(-1);
  return last !== undefined && last.stopReason !== 'pending' && last.stopReason !== 'toolUse';
};

export const PiTurnUsageFooter: React.FC<{
  entries: readonly PiSessionEntry[];
  startedAt?: number;
  liveAssistant?: PiAssistantMessage;
}> = ({ entries, liveAssistant, startedAt }) => {
  if (!isPiAssistantTurnComplete(entries, liveAssistant)) return null;
  const usage = aggregateAssistantUsage(entries, liveAssistant);
  if (!usage) return null;
  return (
    <PiAssistantUsageFooter
      tokensPerSecond={assistantTokensPerSecond(entries, startedAt, liveAssistant)}
      usage={usage}
    />
  );
};
