import { describe, expect, it, vi } from 'vitest';
import { attachPiSessionExecutionAdmission } from './broker.js';

describe('Web Pi runtime broker admission wiring', () => {
  it('attaches admission to an injected broker before it is exposed', () => {
    const setSessionExecutionAdmission = vi.fn();
    const broker = { setSessionExecutionAdmission };
    const admit = vi.fn();

    expect(attachPiSessionExecutionAdmission(broker, admit)).toBe(broker);
    expect(setSessionExecutionAdmission).toHaveBeenCalledWith(admit);
  });

  it('rejects an injected broker that cannot enforce pre-execution admission', () => {
    expect(() => attachPiSessionExecutionAdmission({}, vi.fn())).toThrow(
      'Injected Pi runtime broker does not support session execution admission',
    );
  });
});
