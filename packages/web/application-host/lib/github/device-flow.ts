const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

type FormParams = Record<string, string | number | null | undefined>;

export class GitHubDeviceFlowError extends Error {
  readonly payload: Record<string, unknown> | null;
  readonly status: number;

  constructor(message: string, status: number, payload: Record<string, unknown> | null) {
    super(message);
    this.name = 'GitHubDeviceFlowError';
    this.status = status;
    this.payload = payload;
  }
}

const encodeForm = (params: FormParams): string => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    body.set(key, String(value));
  }
  return body.toString();
};

async function postForm(url: string, params: FormParams): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: encodeForm(params),
  });

  const rawPayload: unknown = await response.json().catch(() => null);
  const payload = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
    ? rawPayload as Record<string, unknown>
    : null;
  if (!response.ok) {
    const message = typeof payload?.error_description === 'string'
      ? payload.error_description
      : (typeof payload?.error === 'string' ? payload.error : response.statusText);
    throw new GitHubDeviceFlowError(message || 'GitHub request failed', response.status, payload);
  }
  return payload ?? {};
}

export async function startDeviceFlow({ clientId, scope }: { clientId: string; scope: string }) {
  return postForm(DEVICE_CODE_URL, {
    client_id: clientId,
    scope,
  });
}

export async function exchangeDeviceCode({ clientId, deviceCode }: { clientId: string; deviceCode: string }) {
  // GitHub returns 200 with {error: 'authorization_pending'|...} for non-success states.
  const payload = await postForm(ACCESS_TOKEN_URL, {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: DEVICE_GRANT_TYPE,
  });
  return payload;
}
