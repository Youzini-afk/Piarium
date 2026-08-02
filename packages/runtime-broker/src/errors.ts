import type { JsonValue } from "@piarium/protocol";

export class PiRuntimeBrokerError extends Error {
  readonly code: string;
  readonly details: JsonValue | undefined;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { details?: JsonValue; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "PiRuntimeBrokerError";
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}
