import fs from 'fs';
import path from 'path';
import os from 'os';

const resolveOpenCodeDataDir = () => {
  const envAuthDir = typeof process.env.OPENCODE_AUTH_DIR === 'string' ? process.env.OPENCODE_AUTH_DIR.trim() : '';
  if (envAuthDir) {
    return path.resolve(envAuthDir);
  }

  const envDataDir = typeof process.env.OPENCODE_DATA_DIR === 'string' ? process.env.OPENCODE_DATA_DIR.trim() : '';
  if (envDataDir) {
    return path.resolve(envDataDir);
  }

  return path.join(os.homedir(), '.local', 'share', 'opencode');
};
const OPENCODE_DATA_DIR = resolveOpenCodeDataDir();
const AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');

function getAuthFilePath() {
  return path.join(resolveOpenCodeDataDir(), 'auth.json');
}

function readAuthFile() {
  const authFile = getAuthFilePath();
  if (!fs.existsSync(authFile)) {
    return {};
  }
  try {
    const content = fs.readFileSync(authFile, 'utf8');
    const trimmed = content.trim();
    if (!trimmed) {
      return {};
    }
    return JSON.parse(trimmed);
  } catch (error) {
    console.error('Failed to read auth file:', error);
    throw new Error('Failed to read OpenCode auth configuration');
  }
}

function writeAuthFile(auth) {
  try {
    const authFile = getAuthFilePath();
    const dataDir = path.dirname(authFile);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    if (fs.existsSync(authFile)) {
      const backupFile = `${authFile}.openchamber.backup`;
      fs.copyFileSync(authFile, backupFile);
      console.log(`Created auth backup: ${backupFile}`);
    }

    fs.writeFileSync(authFile, JSON.stringify(auth, null, 2), 'utf8');
    console.log('Successfully wrote auth file');
  } catch (error) {
    console.error('Failed to write auth file:', error);
    throw new Error('Failed to write OpenCode auth configuration');
  }
}

function saveProviderAuth(providerId, entry = {}) {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('Provider ID is required');
  }

  const key = typeof entry.key === 'string' ? entry.key.trim() : '';
  if (!key) {
    throw new Error('API key is required');
  }

  const type = typeof entry.type === 'string' && entry.type.trim() ? entry.type.trim() : 'api';
  const auth = readAuthFile();
  auth[providerId] = { type, key };
  writeAuthFile(auth);
  console.log(`Saved provider auth: ${providerId}`);
  return auth[providerId];
}

function removeProviderAuth(providerId) {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('Provider ID is required');
  }

  const auth = readAuthFile();

  if (!auth[providerId]) {
    console.log(`Provider ${providerId} not found in auth file, nothing to remove`);
    return false;
  }

  delete auth[providerId];
  writeAuthFile(auth);
  console.log(`Removed provider auth: ${providerId}`);
  return true;
}

function getProviderAuth(providerId) {
  const auth = readAuthFile();
  return auth[providerId] || null;
}

function listProviderAuths() {
  const auth = readAuthFile();
  return Object.keys(auth);
}

export {
  readAuthFile,
  writeAuthFile,
  saveProviderAuth,
  removeProviderAuth,
  getProviderAuth,
  listProviderAuths,
  AUTH_FILE,
  OPENCODE_DATA_DIR,
  getAuthFilePath,
  resolveOpenCodeDataDir,
};
