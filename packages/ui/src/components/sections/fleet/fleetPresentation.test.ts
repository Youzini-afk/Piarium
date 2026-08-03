import { describe, expect, test } from 'bun:test';
import { fleetProviderTone, formatFleetDuration } from './fleetPresentation';

describe('Fleet presentation', () => {
  test('formats elapsed time without showing negative durations', () => {
    expect(formatFleetDuration(10_000, 9_000)).toBe('0s');
    expect(formatFleetDuration(0, 59_999)).toBe('59s');
    expect(formatFleetDuration(0, 65_000)).toBe('1m 05s');
    expect(formatFleetDuration(0, 3_725_000)).toBe('1h 02m');
  });

  test('maps provider health to stable visual tones', () => {
    expect(fleetProviderTone('active')).toBe('success');
    expect(fleetProviderTone('degraded')).toBe('warning');
    expect(fleetProviderTone('incompatible')).toBe('error');
    expect(fleetProviderTone('unavailable')).toBe('muted');
  });
});
