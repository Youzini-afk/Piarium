export type LanguageServicesFailureReason =
  | 'failed'
  | 'untrusted'
  | 'path-escape'
  | 'stale-completion'
  | 'unsupported';

export class LanguageServicesError extends Error {
  readonly reason: LanguageServicesFailureReason;
  readonly status?: number;

  constructor(message: string, options: { reason?: LanguageServicesFailureReason; status?: number } = {}) {
    super(message);
    this.name = 'LanguageServicesError';
    this.reason = options.reason ?? 'failed';
    if (typeof options.status === 'number') this.status = options.status;
  }
}

export const parseLanguageServicesFailureReason = (value: unknown): LanguageServicesFailureReason => {
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
