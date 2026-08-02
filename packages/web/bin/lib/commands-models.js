import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { resolveTargetPort } from './cli-api-target.js';
import { requestPiariumApi, requestRuntimeMethod } from './cli-runtime.js';
import { isJsonMode, printJson } from '../cli-output.js';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const formatModelRef = (entry) => {
  const providerID = asNonEmptyString(entry?.provider) || asNonEmptyString(entry?.providerID) || asNonEmptyString(entry?.providerId);
  const modelID = asNonEmptyString(entry?.modelID) || asNonEmptyString(entry?.modelId) || asNonEmptyString(entry?.id);
  return providerID && modelID ? `${providerID}/${modelID}` : null;
};

const formatDefaultLine = ({ defaultModel, defaultAgent, defaultVariant }) => {
  const model = asNonEmptyString(defaultModel) || 'none';
  const agent = asNonEmptyString(defaultAgent) || 'none';
  const variant = asNonEmptyString(defaultVariant);
  return `Default: \`${model}${variant ? ` (${variant})` : ''}\` / \`${agent}\``;
};

const formatModelsOutput = (settings = {}) => {
  const favorites = Array.isArray(settings.favoriteModels)
    ? settings.favoriteModels.map(formatModelRef).filter(Boolean)
    : [];
  const recent = Array.isArray(settings.recentModels)
    ? settings.recentModels.map(formatModelRef).filter(Boolean)
    : [];
  const available = Array.isArray(settings.availableModels)
    ? settings.availableModels.map(formatModelRef).filter(Boolean)
    : [];
  const lines = [
    formatDefaultLine(settings),
    '',
    'Favorites:',
    ...(favorites.length > 0 ? favorites.map((model) => `- \`${model}\``) : ['- none']),
    '',
    'Recent:',
    ...(recent.length > 0 ? recent.map((model) => `- \`${model}\``) : ['- none']),
    ...(available.length > 0 ? ['', 'Available:', ...available.map((model) => `- \`${model}\``)] : []),
  ];
  return `${lines.join('\n')}\n`;
};

async function modelsCommand(options = {}, action = 'show') {
  if (action === 'help') {
    process.stdout.write(`Piarium Models Commands\n\nUSAGE:\n  piarium models [OPTIONS]\n\nOUTPUT OPTIONS:\n  -p, --port <port>       Piarium server port\n  --json                  Output machine-readable JSON\n`);
    return;
  }
  if (action !== 'show') {
    throw new TunnelCliError(`Unknown models command '${action}'.`, EXIT_CODE.USAGE_ERROR);
  }

  const port = await resolveTargetPort(options);
  const [settings, availableModels] = await Promise.all([
    requestPiariumApi(port, '/api/config/settings', options),
    requestRuntimeMethod(port, 'model.list', { cwd: process.cwd() }, options),
  ]);
  const result = { ...settings, availableModels: Array.isArray(availableModels) ? availableModels : [] };

  if (isJsonMode(options)) {
    printJson(result);
    return;
  }
  process.stdout.write(formatModelsOutput(result));
}

export { modelsCommand, formatModelsOutput, formatDefaultLine, formatModelRef };
