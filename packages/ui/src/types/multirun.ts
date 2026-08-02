import type { PiAgentInvocationDescriptor } from '@piarium/protocol';

interface MultiRunModelSelection {
  providerID: string;
  modelID: string;
  displayName?: string;
  variant?: string;
}

export interface MultiRunAgentSelection {
  id: string;
  invocation: PiAgentInvocationDescriptor;
  name: string;
  providerId: string;
}

export interface MultiRunFileAttachment {
  mime: string;
  filename: string;
  url: string;
}

export interface MultiRunGroup {
  prompt: string;
  models: MultiRunModelSelection[];
}

export interface CreateMultiRunParams {
  name: string;
  groups: MultiRunGroup[];
  agent?: MultiRunAgentSelection;
  worktreeBaseBranch?: string;
  isolateRuns?: boolean;
  files?: MultiRunFileAttachment[];
  setupCommands?: string[];
}

export interface CreateMultiRunResult {
  failures: Array<{
    message: string;
    modelID: string;
    providerID: string;
    stage: 'create' | 'start';
  }>;
  groupSlug: string;
  sessionIds: string[];
  firstSessionId: string | null;
}
