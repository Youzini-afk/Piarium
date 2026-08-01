import { createRequire } from 'node:module';
import { buildSmartSearchConfigResponse, normalizeSmartSearchPatch, redactSmartSearchPayload, redactSmartSearchSecrets, resolveSmartSearchBinary, resolveSmartSearchBinaryLabel } from './config.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;

const makeEndpointError = (message, status = 500, details = undefined) => {
  const error = new Error(message);
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
};

const appendWithLimit = (current, chunk, limitBytes) => {
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') <= limitBytes) {
    return { value: next, truncated: false };
  }
  const buffer = Buffer.from(next, 'utf8').subarray(0, limitBytes);
  return { value: buffer.toString('utf8'), truncated: true };
};

const parseJsonOutput = (stdout) => {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch {
        throw makeEndpointError('Smart Search returned invalid JSON output.', 502);
      }
    }
    throw makeEndpointError('Smart Search returned non-JSON output.', 502);
  }
};

export const createSmartSearchRuntime = (dependencies = {}) => {
  const {
    fsPromises,
    path,
    spawn,
    env = process.env,
    resolvePackageRoot,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
  } = dependencies;

  if (!fsPromises || !path || !spawn) {
    throw new Error('createSmartSearchRuntime requires fsPromises, path, and spawn dependencies.');
  }

  let doctorInFlight = null;
  let writeQueue = Promise.resolve();

  const hasFile = async (filePath) => {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  };

  const prependPathValue = (base, addition) => {
    if (!base) return addition;
    return `${addition}${process.platform === 'win32' ? ';' : ':'}${base}`;
  };

  const resolveInstalledPackageRoot = () => {
    if (typeof resolvePackageRoot === 'function') return resolvePackageRoot();
    try {
      const requireFromHere = createRequire(import.meta.url);
      return path.dirname(requireFromHere.resolve('@konbakuyomu/smart-search/package.json'));
    } catch {
      return '';
    }
  };

  const getConfiguredSourceDir = async () => {
    const configured = typeof env.SMART_SEARCH_SOURCE_DIR === 'string' ? env.SMART_SEARCH_SOURCE_DIR.trim() : '';
    if (!configured) return '';
    const directCli = path.join(configured, 'smart_search', 'cli.py');
    if (await hasFile(directCli)) return configured;
    const nestedSrc = path.join(configured, 'src');
    const nestedCli = path.join(nestedSrc, 'smart_search', 'cli.py');
    if (await hasFile(nestedCli)) return nestedSrc;
    return configured;
  };

  const buildSmartSearchCandidates = async (args) => {
    const candidates = [];

    if (env.SMART_SEARCH_BIN) {
      const binary = resolveSmartSearchBinary(env);
      if (process.platform === 'win32' && /\.cmd$|\.bat$/i.test(binary)) {
        candidates.push({ label: binary, command: 'cmd.exe', args: ['/d', '/s', '/c', binary, ...args] });
      } else {
        candidates.push({ label: binary, command: binary, args });
      }
      return candidates;
    }

    const packageRoot = resolveInstalledPackageRoot();
    const packageWrapper = packageRoot ? path.join(packageRoot, 'npm', 'bin', 'smart-search.js') : '';
    if (packageWrapper && await hasFile(packageWrapper)) {
      candidates.push({ label: '@konbakuyomu/smart-search package', command: process.execPath, args: [packageWrapper, ...args] });
    }

    const sourceDir = await getConfiguredSourceDir();
    if (sourceDir) {
      candidates.push({
        label: `${sourceDir} via python -m smart_search.cli`,
        command: env.PYTHON || env.PYTHON_BIN || (process.platform === 'win32' ? 'python.exe' : 'python3'),
        args: ['-m', 'smart_search.cli', ...args],
        env: { PYTHONPATH: prependPathValue(env.PYTHONPATH || '', sourceDir) },
      });
    }

    const binary = resolveSmartSearchBinary(env);
    if (process.platform === 'win32' && /\.cmd$|\.bat$/i.test(binary)) {
      candidates.push({ label: binary, command: 'cmd.exe', args: ['/d', '/s', '/c', binary, ...args] });
    } else {
      candidates.push({ label: binary, command: binary, args });
    }

    return candidates;
  };

  const killProcessTree = (child) => {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => undefined);
      return;
    }
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  };

  const runCliCandidate = (candidate, options = {}) => new Promise((resolve, reject) => {
    const childEnv = {
      ...env,
      ...(candidate.env ?? {}),
      PYTHONIOENCODING: env.PYTHONIOENCODING || 'utf-8',
      PYTHONUTF8: env.PYTHONUTF8 || '1',
    };
    const child = spawn(candidate.command, candidate.args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const limitBytes = options.outputLimitBytes ?? outputLimitBytes;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child);
      reject(makeEndpointError('Smart Search command timed out.', 504));
    }, options.timeoutMs ?? timeoutMs);

    child.stdout?.on('data', (chunk) => {
      const result = appendWithLimit(stdout, chunk.toString('utf8'), limitBytes);
      stdout = result.value;
      stdoutTruncated = stdoutTruncated || result.truncated;
      if (stdoutTruncated) killProcessTree(child);
    });
    child.stderr?.on('data', (chunk) => {
      const result = appendWithLimit(stderr, chunk.toString('utf8'), limitBytes);
      stderr = result.value;
      stderrTruncated = stderrTruncated || result.truncated;
      if (stderrTruncated) killProcessTree(child);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(makeEndpointError(`Smart Search candidate failed to start: ${candidate.label}`, 503, redactSmartSearchSecrets(error.message)));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutTruncated || stderrTruncated) {
        reject(makeEndpointError('Smart Search command output exceeded the safety limit.', 502));
        return;
      }
      resolve({ code, signal, stdout, stderr, label: candidate.label });
    });
  });

  const runCli = async (args, options = {}) => {
    const candidates = await buildSmartSearchCandidates(args);
    const failures = [];
    for (const candidate of candidates) {
      try {
        const result = await runCliCandidate(candidate, options);
        if (options.allowNonZero || result.code === 0) {
          return result;
        }
        failures.push(`${candidate.label}: exit ${result.code}${result.stderr ? `, ${redactSmartSearchSecrets(result.stderr.trim())}` : ''}`);
      } catch (error) {
        failures.push(`${candidate.label}: ${redactSmartSearchSecrets(error?.details || error?.message || 'failed')}`);
      }
    }
    throw makeEndpointError(
      `Smart Search CLI is not available. Tried ${candidates.length} candidate(s). ${failures.join(' | ')}`,
      503,
    );
  };

  const getPathInfo = async () => {
    const result = await runCli(['config', 'path', '--format', 'json'], { timeoutMs: 20_000, outputLimitBytes: 256 * 1024 });
    const parsed = parseJsonOutput(result.stdout);
    if (!parsed || typeof parsed !== 'object' || !parsed.config_file) {
      throw makeEndpointError('Smart Search config path response was invalid.', 502);
    }
    return parsed;
  };

  const readRawConfig = async (configFile) => {
    try {
      const raw = await fsPromises.readFile(configFile, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error && error.code === 'ENOENT') return {};
      if (error instanceof SyntaxError) {
        throw makeEndpointError('Smart Search config file contains invalid JSON. Fix it before saving from OpenChamber.', 409);
      }
      throw error;
    }
  };

  const writeRawConfig = async (configFile, data) => {
    await fsPromises.mkdir(path.dirname(configFile), { recursive: true });
    const tempFile = `${configFile}.openchamber-${process.pid}-${Date.now()}.tmp`;
    let mode = 0o600;
    try {
      const stat = await fsPromises.stat(configFile);
      mode = stat.mode & 0o777;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    try {
      await fsPromises.writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode });
      await fsPromises.rename(tempFile, configFile);
      if (fsPromises.chmod) {
        await Promise.resolve(fsPromises.chmod(configFile, mode)).catch(() => undefined);
      }
    } catch (error) {
      if (fsPromises.rm) {
        await Promise.resolve(fsPromises.rm(tempFile, { force: true })).catch(() => undefined);
      }
      throw error;
    }
  };

  const loadConfig = async () => {
    const pathInfo = await getPathInfo();
    const raw = await readRawConfig(pathInfo.config_file);
    return buildSmartSearchConfigResponse({ pathInfo, fileValues: raw, env });
  };

  const patchConfig = async (payload) => {
    const run = async () => {
      const patch = normalizeSmartSearchPatch(payload);
      const envControlled = [...Object.keys(patch.set), ...patch.unset].filter((key) => env[key] !== undefined);
      if (envControlled.length > 0) {
        throw makeEndpointError(`Cannot edit Smart Search keys controlled by environment variables: ${envControlled.join(', ')}`, 409);
      }
      const pathInfo = await getPathInfo();
      const raw = await readRawConfig(pathInfo.config_file);
      for (const key of patch.unset) {
        delete raw[key];
      }
      for (const [key, value] of Object.entries(patch.set)) {
        raw[key] = value;
      }
      await writeRawConfig(pathInfo.config_file, raw);
      return loadConfig();
    };
    writeQueue = writeQueue.then(run, run);
    return writeQueue;
  };

  const getStatus = async () => {
    try {
      const [pathInfo, versionResult] = await Promise.all([
        getPathInfo(),
        runCli(['--version'], { timeoutMs: 10_000, outputLimitBytes: 64 * 1024 }).catch((error) => ({ error })),
      ]);
      const version = versionResult && !versionResult.error ? versionResult.stdout.trim() : '';
      return {
        ok: true,
        available: true,
        binary: versionResult?.label || pathInfo?.binary || resolveSmartSearchBinaryLabel(env),
        version,
        path: pathInfo,
      };
    } catch (error) {
      return {
        ok: false,
        available: false,
        binary: resolveSmartSearchBinaryLabel(env),
        error: redactSmartSearchSecrets(error?.message || 'Smart Search is not available.'),
      };
    }
  };

  const runDoctor = async () => {
    if (doctorInFlight) return doctorInFlight;
    doctorInFlight = (async () => {
      const result = await runCli(['doctor', '--format', 'json'], { timeoutMs, outputLimitBytes, allowNonZero: true });
      const parsed = parseJsonOutput(result.stdout);
      return {
        ok: Boolean(parsed?.ok),
        exitCode: result.code,
        signal: result.signal,
        result: redactSmartSearchPayload(parsed),
        stderr: result.stderr ? redactSmartSearchSecrets(result.stderr).slice(0, 4000) : '',
      };
    })().finally(() => {
      doctorInFlight = null;
    });
    return doctorInFlight;
  };

  return {
    getStatus,
    loadConfig,
    patchConfig,
    runDoctor,
  };
};
