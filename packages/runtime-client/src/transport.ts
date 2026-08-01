export interface RuntimeTransportHandlers {
  close(error?: Error): void;
  message(frame: string): void;
}

/** Message-oriented transport; it never owns runtime request semantics. */
export interface RuntimeTransport {
  close(): Promise<void> | void;
  send(frame: string): Promise<void> | void;
  start(handlers: RuntimeTransportHandlers): Promise<void> | void;
}
