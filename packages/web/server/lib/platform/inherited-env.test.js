import { describe, expect, it } from 'vitest';
import {
  clearAppImageArgv0FromProcessEnv,
  resolveLinuxPtyLaunch,
  stripAppImageArgv0Leak,
} from './inherited-env.js';

describe('AppImage child environment', () => {
  it('removes ARGV0 without changing other child variables', () => {
    const env = { ARGV0: '/tmp/Piarium.AppImage', PATH: '/usr/bin' };
    expect(stripAppImageArgv0Leak(env)).toEqual({ PATH: '/usr/bin' });
  });

  it('clears ARGV0 from the current process environment', () => {
    const previous = process.env.ARGV0;
    process.env.ARGV0 = '/tmp/Piarium.AppImage';
    try {
      clearAppImageArgv0FromProcessEnv();
      expect(process.env.ARGV0).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.ARGV0;
      else process.env.ARGV0 = previous;
    }
  });

  it('removes native ARGV0 before launching Linux PTYs', () => {
    const launch = resolveLinuxPtyLaunch('/bin/zsh', ['-l']);
    if (process.platform === 'linux') {
      expect(launch.executable).toMatch(/\/env$/);
      expect(launch.args).toEqual(['-u', 'ARGV0', '/bin/zsh', '-l']);
    } else {
      expect(launch).toEqual({ executable: '/bin/zsh', args: ['-l'] });
    }
  });
});
