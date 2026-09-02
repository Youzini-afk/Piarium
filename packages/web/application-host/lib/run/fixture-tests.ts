import { createJsonRpcServer } from '../lsp/jsonrpc.js';

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const tests = [{
  id: 'fixture.fails',
  label: 'fixture fails',
  resourceId: 'fail.test.js',
  line: 1,
}];

const server = createJsonRpcServer({
  input: process.stdin,
  output: process.stdout,
  async onRequest(method, params) {
    const request = asRecord(params);
    if (method === 'initialize') return { protocolVersion: 1 };
    if (method === 'discover') return { tests };
    if (method === 'run') {
      const testIds = Array.isArray(request.testIds)
        ? request.testIds.filter((value): value is string => typeof value === 'string')
        : [];
      const requested = testIds.length > 0
        ? tests.filter((item) => testIds.includes(item.id))
        : tests;
      for (const item of requested) {
        server.notify('test/started', { id: item.id });
        server.notify('test/failed', {
          id: item.id,
          label: item.label,
          resourceId: item.resourceId,
          line: item.line,
          message: 'fixture assertion failed',
          stack: 'Error: fixture assertion failed\n    at fixture (fail.test.js:1:1)',
        });
      }
      server.notify('test/finished', { status: 'failed' });
      return { status: 'started' };
    }
    if (method === 'cancel' || method === 'shutdown') {
      process.exit(0);
    }
    return {};
  },
  onNotification(method) {
    if (method === 'initialized' && process.env.PIARIUM_TEST_FIXTURE_CRASH === '1') {
      process.exit(17);
    }
  },
});
