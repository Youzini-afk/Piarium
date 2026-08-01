import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync as defaultSpawnSync } from 'node:child_process';
import YAML from 'yaml';

const GITHUB_HOST = 'github.com';

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const chmodBestEffort = (filePath, mode) => {
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // best-effort on platforms/filesystems that do not support chmod
  }
};

const normalizeHomeDir = (homeDir = os.homedir()) => path.resolve(homeDir || os.homedir());

const getPaths = ({ homeDir = os.homedir(), authFilePath } = {}) => {
  const home = normalizeHomeDir(homeDir);
  const dataDir = authFilePath
    ? path.dirname(path.resolve(authFilePath))
    : path.join(home, '.config', 'openchamber');

  return {
    ghConfigPath: path.join(home, '.config', 'gh', 'hosts.yml'),
    helperPath: path.join(dataDir, 'bin', 'git-credential-openchamber-github.cjs'),
  };
};

const readYamlObject = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const parsed = YAML.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const getActiveToken = (auth) => {
  const token = typeof auth?.accessToken === 'string' ? auth.accessToken.trim() : '';
  if (!token) {
    throw new Error('GitHub is not connected');
  }
  return token;
};

const getLogin = (auth) => {
  const login = typeof auth?.user?.login === 'string' ? auth.user.login.trim() : '';
  return login || 'x-access-token';
};

const writeGhHosts = ({ auth, ghConfigPath }) => {
  const token = getActiveToken(auth);
  const login = getLogin(auth);
  const hosts = readYamlObject(ghConfigPath);

  hosts[GITHUB_HOST] = {
    ...(hosts[GITHUB_HOST] && typeof hosts[GITHUB_HOST] === 'object' ? hosts[GITHUB_HOST] : {}),
    git_protocol: 'https',
    oauth_token: token,
    user: login,
  };

  ensureDir(path.dirname(ghConfigPath));
  fs.writeFileSync(ghConfigPath, YAML.stringify(hosts), 'utf8');
  chmodBestEffort(ghConfigPath, 0o600);
};

const buildCredentialHelperScript = (authFilePath) => `#!/usr/bin/env node
const fs = require('node:fs');

const AUTH_FILE = ${JSON.stringify(path.resolve(authFilePath))};
const HOST = 'github.com';

function readAuth() {
  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.find((entry) => entry && entry.current && entry.accessToken) || list.find((entry) => entry && entry.accessToken) || null;
  } catch {
    return null;
  }
}

function parseCredentialInput(input) {
  const result = {};
  for (const line of input.split(/\\r?\\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

const action = process.argv[2] || 'get';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (action !== 'get') {
    process.exit(0);
  }

  const credential = parseCredentialInput(input);
  if (credential.protocol && credential.protocol !== 'https') {
    process.exit(0);
  }
  if (credential.host && credential.host !== HOST) {
    process.exit(0);
  }

  const auth = readAuth();
  const token = typeof auth?.accessToken === 'string' ? auth.accessToken.trim() : '';
  if (!token) {
    process.exit(0);
  }

  const login = typeof auth?.user?.login === 'string' && auth.user.login.trim()
    ? auth.user.login.trim()
    : 'x-access-token';

  process.stdout.write([
    'protocol=https',
    'host=' + HOST,
    'username=' + login,
    'password=' + token,
    '',
  ].join('\\n'));
});
`;

const quoteGitHelperPath = (helperPath) => `"${helperPath.replace(/(["\\$`])/g, '\\$1')}"`;

const writeCredentialHelper = ({ helperPath, authFilePath }) => {
  ensureDir(path.dirname(helperPath));
  fs.writeFileSync(helperPath, buildCredentialHelperScript(authFilePath), 'utf8');
  chmodBestEffort(helperPath, 0o700);
};

const configureGitCredentialHelper = ({ helperPath, spawnSync = defaultSpawnSync }) => {
  const helperCommand = `!${quoteGitHelperPath(helperPath)}`;
  const result = spawnSync(
    'git',
    [
      'config',
      '--global',
      '--replace-all',
      'credential.https://github.com.helper',
      helperCommand,
    ],
    { encoding: 'utf8' },
  );

  return {
    configured: result.status === 0 && !result.error,
    error: result.error?.message || (result.status === 0 ? '' : String(result.stderr || '').trim()),
    helperCommand,
  };
};

export function installTerminalGitHubAuth({
  auth,
  homeDir = os.homedir(),
  authFilePath,
  configureGit = true,
  spawnSync = defaultSpawnSync,
} = {}) {
  getActiveToken(auth);

  const resolvedAuthFilePath = authFilePath || path.join(normalizeHomeDir(homeDir), '.config', 'openchamber', 'github-auth.json');
  const { ghConfigPath, helperPath } = getPaths({ homeDir, authFilePath: resolvedAuthFilePath });

  writeGhHosts({ auth, ghConfigPath });
  writeCredentialHelper({ helperPath, authFilePath: resolvedAuthFilePath });

  const git = configureGit
    ? configureGitCredentialHelper({ helperPath, spawnSync })
    : { configured: false, error: '', helperCommand: '' };

  return {
    success: true,
    ghConfigPath,
    helperPath,
    gitCredentialHelperConfigured: git.configured,
    gitCredentialHelperError: git.error,
    gitCredentialHelper: git.helperCommand,
  };
}

export function isTerminalGitHubAuthConfigured({
  auth,
  homeDir = os.homedir(),
  authFilePath,
} = {}) {
  const token = typeof auth?.accessToken === 'string' ? auth.accessToken.trim() : '';
  const { ghConfigPath, helperPath } = getPaths({ homeDir, authFilePath });
  const hosts = readYamlObject(ghConfigPath);
  const hostEntry = hosts[GITHUB_HOST] && typeof hosts[GITHUB_HOST] === 'object' ? hosts[GITHUB_HOST] : {};
  const ghConfigured = Boolean(token && hostEntry.oauth_token === token);

  return {
    configured: ghConfigured && fs.existsSync(helperPath),
    ghConfigured,
    credentialHelperInstalled: fs.existsSync(helperPath),
    ghConfigPath,
    helperPath,
  };
}

const getGitHubAuthor = (auth) => {
  getActiveToken(auth);

  const user = auth?.user && typeof auth.user === 'object' ? auth.user : {};
  const login = typeof user.login === 'string' ? user.login.trim() : '';
  const name = typeof user.name === 'string' ? user.name.trim() : '';
  const email = typeof user.email === 'string' ? user.email.trim() : '';
  const id = typeof user.id === 'number' || typeof user.id === 'string' ? String(user.id).trim() : '';

  const userName = name || login;
  const userEmail = email || (id && login ? `${id}+${login}@users.noreply.github.com` : '');

  if (!userName) {
    throw new Error('GitHub user name is unavailable');
  }
  if (!userEmail) {
    throw new Error('GitHub user email is unavailable');
  }

  return { userName, userEmail };
};

const getSpawnError = (result) => {
  if (result?.error?.message) {
    return result.error.message;
  }
  const stderr = result?.stderr == null ? '' : String(result.stderr).trim();
  return stderr || 'git config failed';
};

const setGlobalGitConfig = ({ key, value, spawnSync }) => {
  const result = spawnSync(
    'git',
    ['config', '--global', '--replace-all', key, value],
    { encoding: 'utf8' },
  );

  if (result?.error || result?.status !== 0) {
    throw new Error(`Failed to set ${key}: ${getSpawnError(result)}`);
  }
};

export function configureGitHubGitAuthor({
  auth,
  spawnSync = defaultSpawnSync,
} = {}) {
  const { userName, userEmail } = getGitHubAuthor(auth);

  setGlobalGitConfig({ key: 'user.name', value: userName, spawnSync });
  setGlobalGitConfig({ key: 'user.email', value: userEmail, spawnSync });

  return {
    success: true,
    userName,
    userEmail,
  };
}
