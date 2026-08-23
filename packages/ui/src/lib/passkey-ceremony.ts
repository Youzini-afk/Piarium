import {
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';
import {
  getPasskeySupportState,
  passkeyErrorMessage,
  postPasskeyJson,
} from './passkeys-api';

const PASSKEY_AUTH_OPTIONS_ENDPOINT = '/auth/passkey/authenticate/options';
const PASSKEY_AUTH_VERIFY_ENDPOINT = '/auth/passkey/authenticate/verify';
const PASSKEY_REGISTER_OPTIONS_ENDPOINT = '/auth/passkey/register/options';
const PASSKEY_REGISTER_VERIFY_ENDPOINT = '/auth/passkey/register/verify';

export type PasskeyAuthenticationOptions = {
  issueClientToken?: boolean;
  clientLabel?: string;
  clientKind?: string;
  dedupeKey?: string;
};

export const cancelPasskeyCeremony = (): void => {
  WebAuthnAbortService.cancelCeremony();
};

export const registerCurrentDevicePasskey = async () => {
  const support = getPasskeySupportState();
  if (!support.supported) throw new Error(support.reason);
  const label = typeof navigator.userAgent === 'string' && navigator.userAgent.trim()
    ? navigator.userAgent
    : 'This device';
  const optionsResponse = await postPasskeyJson(PASSKEY_REGISTER_OPTIONS_ENDPOINT, { label });
  if (!optionsResponse.ok) {
    throw new Error(await passkeyErrorMessage(optionsResponse, 'Could not start passkey setup.'));
  }
  const { requestId, optionsJSON } = await optionsResponse.json();
  const registrationResponse = await startRegistration({ optionsJSON });
  const verifyResponse = await postPasskeyJson(PASSKEY_REGISTER_VERIFY_ENDPOINT, {
    requestId,
    response: registrationResponse,
  });
  if (!verifyResponse.ok) {
    throw new Error(await passkeyErrorMessage(verifyResponse, 'Could not finish passkey setup.'));
  }
  return verifyResponse.json().catch(() => null);
};

export const authenticateWithPasskey = async (
  trustDevice: boolean,
  options: PasskeyAuthenticationOptions = {},
) => {
  const support = getPasskeySupportState();
  if (!support.supported) throw new Error(support.reason);
  const optionsResponse = await postPasskeyJson(PASSKEY_AUTH_OPTIONS_ENDPOINT);
  if (!optionsResponse.ok) {
    throw new Error(await passkeyErrorMessage(optionsResponse, 'Passkey sign-in is not available right now.'));
  }
  const { requestId, optionsJSON } = await optionsResponse.json();
  const authResponse = await startAuthentication({ optionsJSON });
  const verifyResponse = await postPasskeyJson(PASSKEY_AUTH_VERIFY_ENDPOINT, {
    requestId,
    response: authResponse,
    trustDevice,
    issueClientToken: options.issueClientToken === true,
    clientLabel: options.clientLabel,
    clientKind: options.clientKind,
    dedupeKey: options.dedupeKey,
  });
  if (!verifyResponse.ok) {
    throw new Error(await passkeyErrorMessage(verifyResponse, 'Passkey sign-in failed.'));
  }
  return verifyResponse.json().catch(() => null);
};
