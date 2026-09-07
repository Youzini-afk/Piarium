import type { LanguageSupportFailureReason } from './types.js';

export type { LanguageSupportFailureReason };

export class LanguageSupportError extends Error {
  readonly reason: LanguageSupportFailureReason;
  readonly status?: number;

  constructor(message: string, options: { reason?: LanguageSupportFailureReason; status?: number } = {}) {
    super(message);
    this.name = 'LanguageSupportError';
    this.reason = options.reason ?? 'failed';
    if (typeof options.status === 'number') this.status = options.status;
  }
}

export const parseLanguageSupportFailureReason = (value: unknown): LanguageSupportFailureReason => {
  switch (value) {
    case 'failed':
    case 'unsupported':
    case 'cancelled':
    case 'integrity':
    case 'absent':
      return value;
    default:
      return 'failed';
  }
};
