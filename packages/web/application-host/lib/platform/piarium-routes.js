const SYSTEMD_SERVICE_UNIT_PATTERN = /^[A-Za-z0-9:_.@-]+\.service$/;

export const resolveSystemdServiceUnit = (environment) => {
  if (!environment.INVOCATION_ID) return null;
  const configured = typeof environment.PIARIUM_SYSTEMD_UNIT === 'string'
    ? environment.PIARIUM_SYSTEMD_UNIT.trim()
    : '';
  const unit = configured || 'piarium.service';
  return SYSTEMD_SERVICE_UNIT_PATTERN.test(unit) ? unit : null;
};

const quotePosixShell = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

export const registerPiariumRoutes = (app, dependencies) => {
  const {
    fs,
    path,
    process,
    server,
    __dirname,
    piariumDataDir,
    modelsDevApiUrl,
    modelsMetadataCacheTtl,
  } = dependencies;

  app.get('/api/piarium/update-check', async (req, res) => {
    try {
      const { checkForUpdates } = await import('../package-manager.js');
      const parseString = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);

      const updateInfo = await checkForUpdates({
        appType: parseString(req.query.appType),
        platform: parseString(req.query.platform),
        arch: parseString(req.query.arch),
        currentVersion: parseString(req.query.currentVersion),
      });
      res.json(updateInfo);
    } catch (error) {
      console.error('Failed to check for updates:', error);
      res.status(500).json({
        available: false,
        error: error instanceof Error ? error.message : 'Failed to check for updates',
      });
    }
  });

  app.post('/api/piarium/update-install', async (_req, res) => {
    try {
      const { spawn: spawnChild, spawnSync } = await import('child_process');
      const {
        checkForUpdates,
        getUpdateCommand,
        detectPackageManagerDetails,
      } = await import('../package-manager.js');

      const updateInfo = await checkForUpdates();
      if (!updateInfo.available) {
        return res.status(400).json({ error: 'No update available' });
      }

      const pmDetails = detectPackageManagerDetails();
      const pm = pmDetails.packageManager;
      const updateCmd = getUpdateCommand(pm);
      const isContainer =
        fs.existsSync('/.dockerenv') ||
        Boolean(process.env.CONTAINER) ||
        process.env.container === 'docker';

      if (isContainer) {
        res.json({
          success: true,
          message: 'Update starting, server will stay online',
          version: updateInfo.version,
          packageManager: pm,
          autoRestart: false,
        });

        setTimeout(() => {
          console.log(`\nInstalling update using ${pm} (container mode)...`);
          console.log(`Running: ${updateCmd}`);

          const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'sh';
          const shellFlag = process.platform === 'win32' ? '/c' : '-c';
          const child = spawnChild(shell, [shellFlag, updateCmd], {
            detached: true,
            stdio: 'ignore',
            env: process.env,
          });
          child.unref();
        }, 500);

        return;
      }

      const currentPort = server.address()?.port || 3000;
      const instanceFilePath = path.join(piariumDataDir, 'run', `piarium-${currentPort}.json`);
      let storedOptions = { port: currentPort, daemon: true };
      try {
        const content = await fs.promises.readFile(instanceFilePath, 'utf8');
        storedOptions = JSON.parse(content);
      } catch {
      }
      const launchMode = storedOptions.launchMode === 'foreground' ? 'foreground' : 'daemon';
      const isForegroundService = launchMode === 'foreground';
      const systemdServiceUnit = isForegroundService && process.platform === 'linux'
        ? resolveSystemdServiceUnit(process.env)
        : null;

      if (isForegroundService) {
        if (!systemdServiceUnit) {
          return res.status(409).json({
            error: 'Foreground servers must be updated by their service manager. When using systemd, set PIARIUM_SYSTEMD_UNIT if the unit is not piarium.service.',
          });
        }

        const updateJobName = `piarium-update-${Date.now()}`;
        const updateScript = [
          'set -eu',
          updateCmd,
          `systemctl --user restart ${quotePosixShell(systemdServiceUnit)}`,
        ].join('\n');
        const queued = spawnSync('systemd-run', [
          '--user',
          `--unit=${updateJobName}`,
          '--collect',
          '--service-type=exec',
          `--setenv=PATH=${process.env.PATH || ''}`,
          '/bin/sh',
          '-c',
          updateScript,
        ], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        if (queued.status !== 0) {
          const detail = (queued.stderr || queued.stdout || queued.error?.message || '').trim();
          return res.status(409).json({
            error: detail || `Could not queue update job for ${systemdServiceUnit}`,
          });
        }

        return res.json({
          success: true,
          message: 'Update queued; Piarium will restart after installation completes',
          version: updateInfo.version,
          packageManager: pm,
          autoRestart: true,
          restartManager: 'systemd',
          jobId: updateJobName,
          logPath: `journalctl --user-unit ${updateJobName}.service`,
        });
      }

      const isWindows = process.platform === 'win32';
      const quotePosix = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
      const quoteCmd = (value) => {
        const stringValue = String(value);
        return `"${stringValue.replace(/"/g, '""')}"`;
      };

      const cliPath = path.resolve(__dirname, '..', 'bin', 'cli.js');
      const restartParts = [
        isWindows ? quoteCmd(process.execPath) : quotePosix(process.execPath),
        isWindows ? quoteCmd(cliPath) : quotePosix(cliPath),
        'serve',
        '--port',
        String(storedOptions.port),
      ];
      let restartCmdPrimary = restartParts.join(' ');
      let restartCmdFallback = `piarium serve --port ${storedOptions.port}`;
      if (storedOptions.host) {
        if (isWindows) {
          const escapedHost = storedOptions.host.replace(/"/g, '""');
          restartCmdPrimary += ` --host "${escapedHost}"`;
          restartCmdFallback += ` --host "${escapedHost}"`;
        } else {
          const escapedHost = storedOptions.host.replace(/'/g, "'\\''");
          restartCmdPrimary += ` --host '${escapedHost}'`;
          restartCmdFallback += ` --host '${escapedHost}'`;
        }
      }
      if (storedOptions.uiPassword) {
        if (isWindows) {
          const escapedPw = storedOptions.uiPassword.replace(/"/g, '""');
          restartCmdPrimary += ` --ui-password "${escapedPw}"`;
          restartCmdFallback += ` --ui-password "${escapedPw}"`;
        } else {
          const escapedPw = storedOptions.uiPassword.replace(/'/g, "'\\''");
          restartCmdPrimary += ` --ui-password '${escapedPw}'`;
          restartCmdFallback += ` --ui-password '${escapedPw}'`;
        }
      }
      if (storedOptions.apiOnly === true) {
        restartCmdPrimary += ' --api-only';
        restartCmdFallback += ' --api-only';
      }
      const restartCmd = `(${restartCmdPrimary}) || (${restartCmdFallback})`;
      const updateLogPath = path.join(piariumDataDir, 'update-install.log');
      const logPreamble = [
        '',
        `=== Piarium update ${new Date().toISOString()} ===`,
        `currentVersion=${updateInfo.currentVersion || 'unknown'}`,
        `targetVersion=${updateInfo.version || 'unknown'}`,
        `packageManager=${pm}`,
        `packageManagerReason=${pmDetails.reason || 'unknown'}`,
        `packageManagerCommand=${pmDetails.packageManagerCommand || 'unknown'}`,
        `packagePath=${pmDetails.packagePath || 'unknown'}`,
        `globalNodeModulesRoot=${pmDetails.globalNodeModulesRoot || 'unknown'}`,
        `mode=${isContainer ? 'container' : 'restart'}`,
        `launchMode=${launchMode}`,
        `updateCommand=${updateCmd}`,
        `restartCommand=${restartCmd || 'service-manager'}`,
        `logPath=${updateLogPath}`,
      ].join('\n');

      res.json({
        success: true,
        message: 'Update starting, server will restart shortly',
        version: updateInfo.version,
        packageManager: pm,
        autoRestart: true,
        restartManager: 'cli',
      });

        setTimeout(() => {
          console.log(`\nInstalling update using ${pm}...`);
          console.log(`Running: ${updateCmd}`);
          console.log(logPreamble);

          const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'sh';
          const shellFlag = isWindows ? '/c' : '-c';
          const script = isWindows
            ? `
            echo ${quoteCmd(logPreamble)}
            timeout /t 2 /nobreak >nul
            ${updateCmd}
            if %ERRORLEVEL% EQU 0 (
              echo Update successful, restarting Piarium...
              ${restartCmd || 'echo Service manager will restart Piarium.'}
            ) else (
              echo Update failed
              exit /b 1
            )
            `
          : `
            printf '%s\n' ${quotePosix(logPreamble)}
            sleep 2
            ${updateCmd}
            if [ $? -eq 0 ]; then
              echo "Update successful, restarting Piarium..."
              ${restartCmd || 'echo "Service manager will restart Piarium."'}
            else
              echo "Update failed"
              exit 1
            fi
          `;

        let logFd = null;
        try {
          fs.mkdirSync(path.dirname(updateLogPath), { recursive: true });
          logFd = fs.openSync(updateLogPath, 'a');
        } catch (logError) {
          console.warn('Failed to open update log file, continuing without log capture:', logError);
        }

        const child = spawnChild(shell, [shellFlag, script], {
          detached: true,
          stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
          env: process.env,
        });
        child.unref();

        if (logFd !== null) {
          try {
            fs.closeSync(logFd);
          } catch {
          }
        }

        console.log('Update process spawned, shutting down server...');

        setTimeout(() => {
          process.exit(0);
        }, 500);
      }, 500);
    } catch (error) {
      console.error('Failed to install update:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to install update',
      });
    }
  });

  app.get('/api/piarium/models-metadata', async (_req, res) => {
    try {
      const { getModelsMetadata } = await import('./models-metadata.js');
      const { metadata, fromCache, stale } = await getModelsMetadata({
        url: modelsDevApiUrl,
        ttlMs: modelsMetadataCacheTtl,
      });
      res.setHeader('Cache-Control', fromCache && !stale ? 'public, max-age=60' : 'public, max-age=300');
      res.json(metadata);
    } catch (error) {
      console.warn('Failed to fetch models.dev metadata via server:', error);
      const statusCode = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 504 : 502;
      res.status(statusCode).json({ error: 'Failed to retrieve model metadata' });
    }
  });

};
