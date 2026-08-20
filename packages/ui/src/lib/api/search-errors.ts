export type WorkspaceSearchFailureReason =
  | 'failed'
  | 'untrusted'
  | 'path-escape'
  | 'stale-completion'
  | 'unsupported';

export class WorkspaceSearchError extends Error {
  readonly reason: WorkspaceSearchFailureReason;
  readonly status?: number;

  constructor(message: string, options: { reason?: WorkspaceSearchFailureReason; status?: number } = {}) {
    super(message);
    this.name = 'WorkspaceSearchError';
    this.reason = options.reason ?? 'failed';
    if (typeof options.status === 'number') this.status = options.status;
  }
}

export const parseWorkspaceSearchFailureReason = (value: unknown): WorkspaceSearchFailureReason => {
  switch (value) {
    case 'failed':
    case 'untrusted':
    case 'path-escape':
    case 'stale-completion':
    case 'unsupported':
      return value;
    default:
      return 'failed';
  }
};
