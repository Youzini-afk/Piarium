export type RunServicesFailureReason =
  | 'failed'
  | 'untrusted'
  | 'path-escape'
  | 'stale-completion'
  | 'unsupported';

export class RunServicesError extends Error {
  readonly reason: RunServicesFailureReason;
  readonly status?: number;

  constructor(message: string, options: { reason?: RunServicesFailureReason; status?: number } = {}) {
    super(message);
    this.name = 'RunServicesError';
    this.reason = options.reason ?? 'failed';
    if (typeof options.status === 'number') this.status = options.status;
  }
}

export const parseRunServicesFailureReason = (value: unknown): RunServicesFailureReason => {
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
