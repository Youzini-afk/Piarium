import net from 'net';
import { DEFAULT_PORT } from './cli-args.js';
import { fetchSystemInfoFromPort } from './cli-http.js';
import type { CliNotice } from './cli-types.js';

async function isPortAvailable(port: number, host?: string): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen({ port, host }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function resolveAvailablePort(
  desiredPort: unknown,
  explicitPort = false,
  onNotice?: (notice: CliNotice) => void,
): Promise<number> {
  const startPort = typeof desiredPort === 'number' && Number.isFinite(desiredPort)
    ? Math.trunc(desiredPort)
    : DEFAULT_PORT;
  if (explicitPort) {
    return startPort;
  }
  if (await isPortAvailable(startPort)) {
    return startPort;
  }

  const occupant = await fetchSystemInfoFromPort(startPort);
  let message;
  if (occupant?.runtime === 'desktop') {
    message = `Port ${startPort} is used by Piarium Desktop; using a free port`;
  } else if (occupant?.runtime) {
    message = `Port ${startPort} is used by an existing Piarium instance; using a free port`;
  } else {
    message = `Port ${startPort} in use; using a free port`;
  }
  if (typeof onNotice === 'function' && message) {
    onNotice({
      level: 'warning',
      code: 'PORT_REASSIGNED',
      message,
    });
  } else if (message) {
    console.warn(message);
  }
  return 0;
}


export { isPortAvailable, resolveAvailablePort };
