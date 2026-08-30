import React from 'react';
import type {
  PiAssistantMessage,
  PiSessionEntry,
} from '@piarium/protocol';
import {
  aggregateAssistantUsage,
  assistantMessagesForTurn,
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
  liveAssistant?: PiAssistantMessage;
}> = ({ entries, liveAssistant }) => {
  if (!isPiAssistantTurnComplete(entries, liveAssistant)) return null;
  const usage = aggregateAssistantUsage(entries, liveAssistant);
  return usage ? <PiAssistantUsageFooter usage={usage} /> : null;
};
