export const createGracefulShutdownRuntime = (dependencies) => {
  const {
    process,
    shutdownTimeoutMs,
    getExitOnShutdown,
    getIsShuttingDown,
    setIsShuttingDown,
    sessionRuntime,
    scheduledTasksRuntime,
    getTerminalRuntime,
    setTerminalRuntime,
    getDocumentsAuthority,
    setDocumentsAuthority,
    getServer,
    getUiAuthController,
    setUiAuthController,
    getActiveTunnelController,
    setActiveTunnelController,
    tunnelAuthController,
  } = dependencies;
  let shutdownPromise = null;

  const runShutdown = async (options = {}) => {
    if (getIsShuttingDown()) return;
    setIsShuttingDown(true);
    console.log('Starting graceful shutdown...');
    const exitProcess = typeof options.exitProcess === 'boolean' ? options.exitProcess : getExitOnShutdown();

    sessionRuntime?.dispose?.();
    await scheduledTasksRuntime?.stop?.();

    const terminalRuntime = getTerminalRuntime();
    if (terminalRuntime) {
      try {
        await terminalRuntime.shutdown();
      } catch {
        // Continue closing the remaining server resources.
      } finally {
        setTerminalRuntime(null);
      }
    }

    const server = getServer();
    if (server && typeof server.close === 'function') {
      let closeTimeout = null;
      try {
        await Promise.race([
          new Promise((resolve) => server.close(resolve)),
          new Promise((resolve) => {
            closeTimeout = setTimeout(resolve, shutdownTimeoutMs);
          }),
        ]);
      } finally {
        if (closeTimeout) clearTimeout(closeTimeout);
      }
    }

    const documentsAuthority = getDocumentsAuthority?.();
    if (documentsAuthority) {
      try {
        await documentsAuthority.dispose();
      } catch (error) {
        // Continue closing process-owned resources after a failed authority cleanup.
        console.error('Document authority shutdown failed:', error?.message || error);
      } finally {
        setDocumentsAuthority?.(null);
      }
    }

    const uiAuthController = getUiAuthController();
    if (uiAuthController) {
      uiAuthController.dispose();
      setUiAuthController(null);
    }

    const tunnelController = getActiveTunnelController();
    if (tunnelController) {
      try {
        tunnelController.stop();
      } finally {
        setActiveTunnelController(null);
        tunnelAuthController.clearActiveTunnel();
      }
    }

    console.log('Graceful shutdown complete');
    if (exitProcess) process.exit(0);
  };

  const gracefulShutdown = (options = {}) => {
    shutdownPromise ??= runShutdown(options);
    return shutdownPromise;
  };

  return { gracefulShutdown };
};
