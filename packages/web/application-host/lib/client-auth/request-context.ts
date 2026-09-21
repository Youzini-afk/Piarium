export interface VarinAuthenticatedClient extends Record<string, unknown> {
  allowedDirectories?: string[];
  capabilities?: string[];
  id: string;
  label?: string;
  profile?: string;
}

export type VarinRequestAuthContext =
  | {
      client: VarinAuthenticatedClient;
      clientId: string;
      type: 'client';
    }
  | {
    client?: VarinAuthenticatedClient;
    clientId?: string;
    token?: string;
    type: 'session';
  };

declare global {
  // Express intentionally exposes this open namespace for application request metadata.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      __varinExternalAuditAttached?: boolean;
      varinAuth?: VarinRequestAuthContext;
    }
  }
}
