import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const resolvePiAgentDir = () => {
  const configured = process.env.PIARIUM_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
  return typeof configured === 'string' && configured.trim()
    ? path.resolve(configured.trim())
    : path.join(os.homedir(), '.pi', 'agent');
};

export const getPiAuthFilePath = () => path.join(resolvePiAgentDir(), 'auth.json');

const readJsonObject = (filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`Failed to read Pi configuration: ${filePath}`, { cause: error });
  }
};

const mergeObjects = (base, override) => {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return override;
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? mergeObjects(result[key], value) : value;
  }
  return result;
};

export const readPiAuthFile = () => readJsonObject(getPiAuthFilePath());

export const writePiAuthFile = (auth) => {
  const authFile = getPiAuthFilePath();
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  if (fs.existsSync(authFile)) fs.copyFileSync(authFile, `${authFile}.piarium.backup`);
  fs.writeFileSync(authFile, `${JSON.stringify(auth, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
};

export const savePiProviderAuth = (providerId, entry = {}) => {
  if (typeof providerId !== 'string' || !providerId.trim()) throw new Error('Provider ID is required');
  const key = typeof entry.key === 'string' ? entry.key.trim() : '';
  if (!key) throw new Error('API key is required');
  const auth = readPiAuthFile();
  auth[providerId.trim()] = { type: 'api_key', key };
  writePiAuthFile(auth);
  return auth[providerId.trim()];
};

export const removePiProviderAuth = (providerId) => {
  const id = typeof providerId === 'string' ? providerId.trim() : '';
  if (!id) throw new Error('Provider ID is required');
  const auth = readPiAuthFile();
  if (!auth[id]) return false;
  delete auth[id];
  writePiAuthFile(auth);
  return true;
};

export const readPiConfigLayers = (workingDirectory) => {
  const agentDir = resolvePiAgentDir();
  const userSettingsPath = path.join(agentDir, 'settings.json');
  const userModelsPath = path.join(agentDir, 'models.json');
  const projectRoot = typeof workingDirectory === 'string' && workingDirectory.trim()
    ? path.resolve(workingDirectory.trim(), '.pi')
    : null;
  const projectSettingsPath = projectRoot ? path.join(projectRoot, 'settings.json') : null;
  const projectModelsPath = projectRoot ? path.join(projectRoot, 'models.json') : null;
  const userConfig = mergeObjects(readJsonObject(userSettingsPath), readJsonObject(userModelsPath));
  const projectConfig = mergeObjects(readJsonObject(projectSettingsPath), readJsonObject(projectModelsPath));
  return {
    userConfig,
    projectConfig,
    mergedConfig: mergeObjects(userConfig, projectConfig),
    paths: { projectModelsPath, projectSettingsPath, userModelsPath, userSettingsPath },
  };
};

export const readPiConfiguration = (workingDirectory) => readPiConfigLayers(workingDirectory).mergedConfig;
