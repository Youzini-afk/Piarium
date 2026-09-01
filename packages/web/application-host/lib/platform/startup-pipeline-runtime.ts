// @ts-nocheck
import { recordStartupPerformance } from './startup-performance.js';

export const createStartupPipelineRuntime = (dependencies) => {
  const {
    createTerminalRuntime,
    createDictationRuntime,
    createServerStartupRuntime,
  } = dependencies;

  const run = async (options) => {
    const pipelineStartedAt = performance.now();
    recordStartupPerformance('web.pipeline.start');
    const {
      app,
      server,
      express,
      fs,
      path,
      uiAuthController,
      buildAugmentedPath,
      searchPathFor,
      isExecutable,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      terminalHeartbeatIntervalMs,
      terminalRebindWindowMs,
      terminalMaxRebindsPerWindow,
      staticRoutesRuntime,
      process,
      crypto,
      normalizeTunnelBootstrapTtlMs,
      readSettingsFromDisk,
      tunnelAuthController,
      startTunnelWithNormalizedRequest,
      gracefulShutdown,
      getSignalsAttached,
      setSignalsAttached,
      TUNNEL_MODE_QUICK,
      TUNNEL_MODE_MANAGED_LOCAL,
      TUNNEL_MODE_MANAGED_REMOTE,
      host,
      port,
      startupTunnelRequest,
      onTunnelReady,
      tunnelRuntimeContext,
      attachSignals,
      apiOnly,
      dictationModelsDir,
      documents,
    } = options;

    const terminalRuntime = createTerminalRuntime({
      app,
      server,
      express,
      fs,
      path,
      uiAuthController,
      buildAugmentedPath,
      searchPathFor,
      isExecutable,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: terminalHeartbeatIntervalMs,
      TERMINAL_INPUT_WS_REBIND_WINDOW_MS: terminalRebindWindowMs,
      TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: terminalMaxRebindsPerWindow,
      documents,
    });

    const dictationRuntime = createDictationRuntime({
      app,
      server,
      express,
      uiAuthController,
      isRequestOriginAllowed,
      rejectWebSocketUpgrade,
      modelsDir: dictationModelsDir,
    });

    if (apiOnly) {
      staticRoutesRuntime.registerApiOnlyFallbackRoutes(app);
    } else {
      staticRoutesRuntime.registerStaticRoutes(app);
    }

    const serverStartupRuntime = createServerStartupRuntime({
      process,
      crypto,
      server,
      normalizeTunnelBootstrapTtlMs,
      readSettingsFromDisk,
      tunnelAuthController,
      startTunnelWithNormalizedRequest,
      gracefulShutdown,
      getSignalsAttached,
      setSignalsAttached,
      TUNNEL_MODE_QUICK,
      TUNNEL_MODE_MANAGED_LOCAL,
      TUNNEL_MODE_MANAGED_REMOTE,
    });

    const bindHost = serverStartupRuntime.resolveBindHost(host);
    const startupResult = await serverStartupRuntime.startListeningAndMaybeTunnel({
      port,
      bindHost,
      startupTunnelRequest,
      onTunnelReady,
    });
    recordStartupPerformance('web.listener.ready', {
      durationMs: performance.now() - pipelineStartedAt,
    });
    tunnelRuntimeContext.setActivePort(startupResult.activePort);

    serverStartupRuntime.attachProcessHandlers({ attachSignals });

    return {
      terminalRuntime,
      dictationRuntime,
    };
  };

  return {
    run,
  };
};
