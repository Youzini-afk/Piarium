import { describe, expect, it } from 'vitest';

import { resolveSystemdServiceUnit } from './varin-routes.js';

describe('Varin systemd update ownership', () => {
  it('uses the Varin user service only inside a systemd invocation', () => {
    expect(resolveSystemdServiceUnit({})).toBeNull();
    expect(resolveSystemdServiceUnit({ INVOCATION_ID: 'invocation' })).toBe('varin.service');
  });

  it('accepts service units without allowing shell syntax', () => {
    expect(resolveSystemdServiceUnit({
      INVOCATION_ID: 'invocation',
      VARIN_SYSTEMD_UNIT: 'varin-work@desktop.service',
    })).toBe('varin-work@desktop.service');
    expect(resolveSystemdServiceUnit({
      INVOCATION_ID: 'invocation',
      VARIN_SYSTEMD_UNIT: 'varin.service; reboot',
    })).toBeNull();
  });
});
