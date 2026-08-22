/**
 * Maps the `bun:test` surface these tests import onto Vitest.
 *
 * The suites are written for per-file isolation, which Vitest provides and `bun test` does not:
 * `bun test` shares one process across files, so module-level store and registry state leaks
 * between suites. Running them under Vitest keeps the isolation the assertions assume.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
  vi,
} from 'vitest';

const mock = Object.assign(
  <T extends (...args: never[]) => unknown>(implementation?: T) => vi.fn(implementation),
  {
    module: vi.mock,
  },
);

export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  test,
  vi,
};
