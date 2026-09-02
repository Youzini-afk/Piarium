import { describe, expect, it } from 'vitest';

import { resolveSystemdServiceUnit } from './piarium-routes.js';

describe('Piarium systemd update ownership', () => {
  it('uses the Piarium user service only inside a systemd invocation', () => {
    expect(resolveSystemdServiceUnit({})).toBeNull();
    expect(resolveSystemdServiceUnit({ INVOCATION_ID: 'invocation' })).toBe('piarium.service');
  });

  it('accepts service units without allowing shell syntax', () => {
    expect(resolveSystemdServiceUnit({
      INVOCATION_ID: 'invocation',
      PIARIUM_SYSTEMD_UNIT: 'piarium-work@desktop.service',
    })).toBe('piarium-work@desktop.service');
    expect(resolveSystemdServiceUnit({
      INVOCATION_ID: 'invocation',
      PIARIUM_SYSTEMD_UNIT: 'piarium.service; reboot',
    })).toBeNull();
  });
});
