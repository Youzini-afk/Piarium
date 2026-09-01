export class RecoveryPrimitiveError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'RecoveryPrimitiveError';
    this.code = code;
    this.retryable = options.retryable === true;
    this.details = options.details;
    this.operationId = options.operationId;
    this.origin = options.origin;
  }
}

export const recoveryFailure = (error, fallbackCode = 'internal') => {
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
  if (error?.code === 'untrusted') {
    return { code: 'workspace-untrusted', message: error.message, retryable: false };
  }
  if (error?.statusCode === 404) {
    return { code: 'workspace-not-found', message: error.message, retryable: false };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
};

export const failedRecoveryResult = (error, fallbackCode) => ({
  failure: recoveryFailure(error, fallbackCode),
  status: 'failed',
});
