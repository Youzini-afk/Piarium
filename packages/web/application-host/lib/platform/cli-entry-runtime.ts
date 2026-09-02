import type {
  ParsedServeCliArgs,
  ParseServeCliOptionsInput,
  StartWebUiServerOptions,
} from '../../public-contract.js';

export interface CliEntryDependencies {
  cloudflareProvider: string;
  currentFilename: string;
  defaultPort: number;
  managedLocalMode: string;
  parseServeCliOptions(input: ParseServeCliOptionsInput): ParsedServeCliArgs;
  process: Pick<NodeJS.Process, 'argv' | 'env' | 'exit'>;
  setExitOnShutdown(value: boolean): void;
  startServer(options: StartWebUiServerOptions): Promise<unknown>;
}

export const runCliEntryIfMain = (dependencies: CliEntryDependencies): void => {
  const {
    process,
    currentFilename,
    parseServeCliOptions,
    defaultPort,
    cloudflareProvider,
    managedLocalMode,
    setExitOnShutdown,
    startServer,
  } = dependencies;

  const isCliExecution = process.argv[1] === currentFilename;
  if (!isCliExecution) {
    return;
  }

  const cliOptions = parseServeCliOptions({
    argv: process.argv.slice(2),
    env: process.env,
    defaultPort,
    cloudflareProvider,
    managedLocalMode,
  });

  setExitOnShutdown(true);
  startServer({
    port: cliOptions.port,
    host: cliOptions.host,
    tryCfTunnel: cliOptions.tryCfTunnel,
    tunnelProvider: cliOptions.tunnelProvider,
    tunnelMode: cliOptions.tunnelMode,
    tunnelConfigPath: cliOptions.tunnelConfigPath,
    tunnelToken: cliOptions.tunnelToken,
    tunnelHostname: cliOptions.tunnelHostname,
    attachSignals: true,
    exitOnShutdown: true,
    uiPassword: cliOptions.uiPassword,
    apiOnly: cliOptions.apiOnly,
  }).catch((error: unknown) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
};
