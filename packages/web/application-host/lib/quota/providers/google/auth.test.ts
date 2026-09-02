import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GOOGLE_OAUTH_CLIENT_ENV, resolveGoogleOAuthClient } from './auth.js';

const envNames = Object.values(GOOGLE_OAUTH_CLIENT_ENV).flatMap(({ clientId, clientSecret }) => [
  clientId,
  clientSecret
]);
const originalEnvironment = new Map(envNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  for (const name of envNames) delete process.env[name];
});

afterEach(() => {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('Google quota OAuth client resolution', () => {
  it('does not fall back to credentials embedded in source', () => {
    expect(resolveGoogleOAuthClient('gemini')).toBeNull();
    expect(resolveGoogleOAuthClient('antigravity')).toBeNull();
  });

  it('keeps Gemini and Antigravity runtime credentials isolated', () => {
    process.env.PIARIUM_GOOGLE_GEMINI_CLIENT_ID = 'gemini-client-id';
    process.env.PIARIUM_GOOGLE_GEMINI_CLIENT_SECRET = 'gemini-client-secret';
    process.env.PIARIUM_GOOGLE_ANTIGRAVITY_CLIENT_ID = 'antigravity-client-id';
    process.env.PIARIUM_GOOGLE_ANTIGRAVITY_CLIENT_SECRET = 'antigravity-client-secret';

    expect(resolveGoogleOAuthClient('gemini')).toEqual({
      clientId: 'gemini-client-id',
      clientSecret: 'gemini-client-secret'
    });
    expect(resolveGoogleOAuthClient('antigravity')).toEqual({
      clientId: 'antigravity-client-id',
      clientSecret: 'antigravity-client-secret'
    });
  });

  it('requires both client fields', () => {
    process.env.PIARIUM_GOOGLE_GEMINI_CLIENT_ID = 'gemini-client-id';
    expect(resolveGoogleOAuthClient('gemini')).toBeNull();
  });
});
