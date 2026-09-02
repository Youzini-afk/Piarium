export interface PiariumAuthenticatedClient extends Record<string, unknown> {
  allowedDirectories?: string[];
  capabilities?: string[];
  id: string;
  label?: string;
  profile?: string;
}

export type PiariumRequestAuthContext =
  | {
      client: PiariumAuthenticatedClient;
      clientId: string;
      type: 'client';
    }
  | {
      client?: PiariumAuthenticatedClient;
      clientId?: string;
      type: 'session';
    };

declare global {
  // Express intentionally exposes this open namespace for application request metadata.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      __piariumExternalAuditAttached?: boolean;
      piariumAuth?: PiariumRequestAuthContext;
    }
  }
}
