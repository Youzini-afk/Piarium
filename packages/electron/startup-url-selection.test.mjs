import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveStartupUrlProbePlan } from './startup-url-selection.mjs';

test('bundled development never probes HMR endpoints', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: true,
    packagedUi: true,
    skipLocalServer: false,
  }), {
    probeHmrApi: false,
    probeHmrUi: false,
  });
});

test('HMR development probes both API and UI endpoints', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: true,
    packagedUi: false,
    skipLocalServer: false,
  }), {
    probeHmrApi: true,
    probeHmrUi: true,
  });
});

test('serverless HMR development skips only the local API probe', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: true,
    packagedUi: false,
    skipLocalServer: true,
  }), {
    probeHmrApi: false,
    probeHmrUi: true,
  });
});

test('production does not probe HMR endpoints', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: false,
    packagedUi: false,
    skipLocalServer: false,
  }), {
    probeHmrApi: false,
    probeHmrUi: false,
  });
});
