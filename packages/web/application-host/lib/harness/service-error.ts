import type { HarnessError } from "@piarium/protocol";

/** A typed service failure that the router can preserve on the wire. */
export class HarnessServiceError extends Error {
  readonly harnessCode: HarnessError["code"];
  readonly harnessRetryable: boolean;

  constructor(code: HarnessError["code"], message: string, retryable = false) {
    super(message);
    this.name = "HarnessServiceError";
    this.harnessCode = code;
    this.harnessRetryable = retryable;
  }
}
