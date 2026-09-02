import type {
  JsonObject,
  WorkspaceRecoveryFailure,
  WorkspaceRecoveryFailureCode,
  WorkspaceRecoveryFailureOrigin,
} from '@piarium/extension-contract';

export interface RecoveryErrorOptions {
  cause?: unknown;
  retryable?: boolean | undefined;
  details?: JsonObject | undefined;
  operationId?: string | undefined;
  origin?: WorkspaceRecoveryFailureOrigin | undefined;
}

export type RecoveryFailure = WorkspaceRecoveryFailure;

export class RecoveryPrimitiveError extends Error {
  code: WorkspaceRecoveryFailureCode;
  retryable: boolean;
  details: JsonObject | undefined;
  operationId: string | undefined;
  origin: WorkspaceRecoveryFailureOrigin | undefined;
  constructor(code: WorkspaceRecoveryFailureCode, message: string, options: RecoveryErrorOptions = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'RecoveryPrimitiveError';
    this.code = code;
    this.retryable = options.retryable === true;
    this.details = options.details;
    this.operationId = options.operationId;
    this.origin = options.origin;
  }
}

export const recoveryFailure = (
  error: unknown,
  fallbackCode: WorkspaceRecoveryFailureCode = 'internal',
): RecoveryFailure => {
  if (error instanceof RecoveryPrimitiveError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: structuredClone(error.details) } : {}),
      ...(error.operationId ? { operationId: error.operationId } : {}),
      ...(error.origin ? { origin: error.origin } : {}),
    };
  }
  if ((error as NodeJS.ErrnoException)?.code === 'untrusted') {
    return { code: 'workspace-untrusted', message: (error as Error).message, retryable: false };
  }
  if ((error as { statusCode?: number })?.statusCode === 404) {
    return { code: 'workspace-not-found', message: (error as Error).message, retryable: false };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
};

export const failedRecoveryResult = (
  error: unknown,
  fallbackCode?: WorkspaceRecoveryFailureCode,
): { failure: RecoveryFailure; status: 'failed' } => ({
  failure: recoveryFailure(error, fallbackCode),
  status: 'failed',
});
