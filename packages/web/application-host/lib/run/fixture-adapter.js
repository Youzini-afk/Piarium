import { createDapServer } from './dap.js';

const threads = [{ id: 1, name: 'fixture' }];
let breakpoints = [];
let program = '';
let paused = false;
let generation = 0;
let seq = 1;

const server = createDapServer({
  input: process.stdin,
  output: process.stdout,
  async onRequest(method, params) {
    if (method === 'initialize') {
      generation += 1;
      if (process.env.PIARIUM_DAP_FIXTURE_CRASH === '1') {
        setImmediate(() => process.exit(17));
      }
      return {
        supportsConfigurationDoneRequest: true,
        supportsEvaluateForHovers: true,
      };
    }
    if (method === 'launch') {
      program = typeof params?.program === 'string' ? params.program : '';
      return {};
    }
    if (method === 'setBreakpoints') {
      const lines = Array.isArray(params?.breakpoints)
        ? params.breakpoints.map((item) => Number(item?.line)).filter((line) => Number.isFinite(line) && line >= 1)
        : [];
      breakpoints = lines.map((line) => ({ line, verified: true }));
      return { breakpoints };
    }
    if (method === 'configurationDone') {
      paused = true;
      server.notify('stopped', {
        reason: 'entry',
        threadId: 1,
        allThreadsStopped: true,
      });
      return {};
    }
    if (method === 'threads') return { threads };
    if (method === 'stackTrace') {
      return {
        stackFrames: [{
          id: 1,
          name: 'fixtureMain',
          line: breakpoints[0]?.line ?? 1,
          column: 1,
          source: { path: program || 'fixture.js' },
        }],
        totalFrames: 1,
      };
    }
    if (method === 'scopes') {
      return {
        scopes: [{ name: 'Locals', variablesReference: 1, expensive: false }],
      };
    }
    if (method === 'variables') {
      return {
        variables: [{ name: 'value', value: '1', variablesReference: 0, type: 'number' }],
      };
    }
    if (method === 'continue' || method === 'next' || method === 'stepIn' || method === 'stepOut') {
      paused = false;
      server.notify('terminated', { seq: seq++ });
      server.notify('exited', { exitCode: 0 });
      return { allThreadsContinued: true };
    }
    if (method === 'pause') {
      paused = true;
      server.notify('stopped', { reason: 'pause', threadId: 1, allThreadsStopped: true });
      return {};
    }
    if (method === 'evaluate') {
      const expression = typeof params?.expression === 'string' ? params.expression : '';
      return { result: expression || 'undefined', variablesReference: 0 };
    }
    if (method === 'disconnect' || method === 'terminate') {
      process.exit(0);
    }
    return {};
  },
});

void paused;
void generation;
