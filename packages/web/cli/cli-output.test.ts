import { describe, expect, it } from 'vitest';

async function withInteractiveTty(fn: () => Promise<void>): Promise<void> {
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

  try {
    return await fn();
  } finally {
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    } else {
      Reflect.deleteProperty(process.stdout, 'isTTY');
    }

    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    } else {
      Reflect.deleteProperty(process.stdin, 'isTTY');
    }
  }
}

describe('cli output', () => {
  it('creates interactive clack spinner and progress helpers', async () => {
    await withInteractiveTty(async () => {
      const moduleUrl = new URL('./cli-output.js', import.meta.url);
      moduleUrl.searchParams.set('test', 'interactive');
      const output: typeof import('./cli-output.js') = await import(moduleUrl.href);

      expect(output.createSpinner({})).toBeTruthy();
      await expect(output.createProgress({}, { max: 2 })).resolves.toBeTruthy();
    });
  });
});
