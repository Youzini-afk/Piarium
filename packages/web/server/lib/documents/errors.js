export class DocumentAuthorityError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'DocumentAuthorityError';
    this.code = options.code || 'failed';
    this.statusCode = options.statusCode || 500;
    if (Number.isSafeInteger(options.currentEpoch) && options.currentEpoch > 0) {
      this.currentEpoch = options.currentEpoch;
    }
  }
}

export class DocumentUntrustedError extends DocumentAuthorityError {
  constructor(message = 'Workspace is not trusted') {
    super(message, { code: 'untrusted', statusCode: 403 });
    this.name = 'DocumentUntrustedError';
  }
}

export class DocumentPathError extends DocumentAuthorityError {
  constructor(message = 'Path is outside workspace', statusCode = 403) {
    super(message, { code: 'path-escape', statusCode });
    this.name = 'DocumentPathError';
  }
}

export const isDocumentAuthorityError = (error) => error instanceof DocumentAuthorityError;
