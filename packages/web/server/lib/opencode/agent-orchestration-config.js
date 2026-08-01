import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  applyEdits,
  modify as modifyJsonc,
  parse as parseJsonc,
  printParseErrorCode,
} from 'jsonc-parser';
import {
  readOpenAgentConfig,
} from './openagent-config.js';
import {
  readSlimConfig,
} from './slim-config.js';
import {
  AGENT_ORCHESTRATION_PROVIDER_DESCRIPTORS,
  MODE_NATIVE,
  MODE_OMO,
  MODE_SLIM,
  getAgentOrchestrationProviderById,
  getAgentOrchestrationProviderCandidate,
  getAgentOrchestrationProviderCandidateForDescriptor,
  getDefaultSpecForLegacyMode,
  getLegacyModeForProviderId,
  getProviderIdForLegacyMode,
  legacyModeUsesTui,
} from './agent-orchestration-providers.js';

const MODE_CONFLICT = 'conflict';

const JSONC_FORMATTING_OPTIONS = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
};

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getOpenCodeConfigDir() {
  const envConfigDir = normalizeString(process.env.OPENCODE_CONFIG_DIR);
  if (envConfigDir) return path.resolve(envConfigDir);
  return path.join(os.homedir(), '.config', 'opencode');
}

function getUserOpenCodeConfigCandidates() {
  const configDir = getOpenCodeConfigDir();
  return [
    path.join(configDir, 'opencode.jsonc'),
    path.join(configDir, 'opencode.json'),
  ];
}

function getLegacyUserOpenCodeConfigCandidates() {
  const configDir = getOpenCodeConfigDir();
  return [
    path.join(configDir, 'config.json'),
  ];
}

function getProjectOpenCodeConfigCandidates(directory) {
  if (!directory) return [];
  return [
    path.join(directory, '.opencode', 'opencode.jsonc'),
    path.join(directory, '.opencode', 'opencode.json'),
    path.join(directory, 'opencode.jsonc'),
    path.join(directory, 'opencode.json'),
  ];
}

function getProviderConfigFileCandidates(descriptor, directory) {
  if (!descriptor) return [];
  const basenames = Array.from(new Set([
    ...(descriptor.packageNames ?? []),
    ...(descriptor.aliases ?? []),
  ].map((name) => normalizeString(name)).filter(Boolean)));
  const directories = [
    getOpenCodeConfigDir(),
    ...(directory ? [path.join(directory, '.opencode'), directory] : []),
  ];
  return directories.flatMap((dir) => basenames.flatMap((basename) => [
    path.join(dir, `${basename}.jsonc`),
    path.join(dir, `${basename}.json`),
  ]));
}

function getOpenCodePackageCacheRoots() {
  const envConfigDir = normalizeString(process.env.OPENCODE_CONFIG_DIR);
  const derivedRoot = path.resolve(getOpenCodeConfigDir(), '..', '..', '.cache', 'opencode', 'packages');
  if (envConfigDir) return [derivedRoot];
  return Array.from(new Set([
    derivedRoot,
    path.join(os.homedir(), '.cache', 'opencode', 'packages'),
  ]));
}

function descriptorPackageCacheExists(descriptor) {
  const packageNames = Array.from(new Set([
    ...(descriptor?.packageNames ?? []),
    ...(descriptor?.aliases ?? []),
  ].map((name) => normalizeString(name)).filter(Boolean)));
  if (packageNames.length === 0) return false;

  for (const root of getOpenCodePackageCacheRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const packageName of packageNames) {
      const directCandidates = [
        path.join(root, `${packageName}@latest`, 'package.json'),
        path.join(root, 'node_modules', packageName, 'package.json'),
      ];
      if (directCandidates.some((candidate) => fs.existsSync(candidate))) return true;

      try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        if (entries.some((entry) => entry.isDirectory() && entry.name.startsWith(`${packageName}@`) && fs.existsSync(path.join(root, entry.name, 'package.json')))) {
          return true;
        }
      } catch {
      }
    }
  }
  return false;
}

function getKnownProviderLocalSignals(directory) {
  const signals = new Map();
  for (const descriptor of AGENT_ORCHESTRATION_PROVIDER_DESCRIPTORS) {
    signals.set(descriptor.id, {
      configFileConfigured: getProviderConfigFileCandidates(descriptor, directory).some((candidate) => fs.existsSync(candidate)),
      localPackageInstalled: descriptorPackageCacheExists(descriptor),
    });
  }
  return signals;
}

function getUserTuiConfigCandidates() {
  const configDir = getOpenCodeConfigDir();
  return [
    path.join(configDir, 'tui.jsonc'),
    path.join(configDir, 'tui.json'),
  ];
}

function getPrimaryUserOpenCodeConfigPath() {
  const candidates = getUserOpenCodeConfigCandidates();
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? path.join(getOpenCodeConfigDir(), 'opencode.jsonc');
}

function getPrimaryUserTuiConfigPath() {
  const candidates = getUserTuiConfigCandidates();
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function parseJsoncObject(content, filePath) {
  const errors = [];
  const parsed = parseJsonc(content.replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const message = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(', ');
    throw new SyntaxError(`Failed to parse ${filePath}: ${message}`);
  }
  return isPlainObject(parsed) ? parsed : {};
}

function readJsoncFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.trim()) return {};
  return parseJsoncObject(content, filePath);
}

function getFileMtimeMs(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    if (typeof stat.mtimeNs === 'bigint') {
      return Number(stat.mtimeNs);
    }
  } catch {
  }
  return fs.statSync(filePath).mtimeMs;
}

function writeJsoncContent(filePath, content) {
  parseJsoncObject(content, filePath);
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, `${filePath}.openchamber.backup`);
    } catch {
      // Backup failure should not block the requested config change.
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

function updateJsoncRawProperty(content, key, value) {
  const edits = modifyJsonc(content, [key], value, {
    formattingOptions: JSONC_FORMATTING_OPTIONS,
  });
  return applyEdits(content, edits);
}

function getPluginSpec(entry) {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry) && typeof entry[0] === 'string') return entry[0];
  return '';
}

function getPluginOptions(entry) {
  return Array.isArray(entry) && isPlainObject(entry[1]) ? entry[1] : undefined;
}

function getPluginArray(config, key) {
  return Array.isArray(config?.[key]) ? config[key] : [];
}

function getPreferredPluginArrayKey(config) {
  if (Array.isArray(config?.plugin)) return 'plugin';
  if (Array.isArray(config?.plugins)) return 'plugins';
  return 'plugin';
}

function normalizeRememberedProviderRecord(value) {
  if (typeof value === 'string') {
    const id = normalizeString(value);
    return id ? { id } : null;
  }
  if (!isPlainObject(value)) return null;
  const id = normalizeString(value.id);
  if (!id) return null;
  return {
    id,
    title: normalizeString(value.title) || undefined,
    description: normalizeString(value.description) || undefined,
    expectedAgentName: normalizeString(value.expectedAgentName) || undefined,
    managementSurfaceId: normalizeString(value.managementSurfaceId) || undefined,
    rawEntry: value.rawEntry,
  };
}

function serializeRememberedProviderRecord(record) {
  if (getAgentOrchestrationProviderById(record.id)) return record.id;
  const value = { id: record.id };
  if (record.title) value.title = record.title;
  if (record.description) value.description = record.description;
  if (record.expectedAgentName) value.expectedAgentName = record.expectedAgentName;
  if (record.managementSurfaceId) value.managementSurfaceId = record.managementSurfaceId;
  if (record.rawEntry !== undefined) value.rawEntry = record.rawEntry;
  return value;
}

function getRememberedProviderRecordsFromConfig(config) {
  const remembered = config?.openchamber?.agentOrchestration?.rememberedProviders;
  if (!Array.isArray(remembered)) return [];
  const records = [];
  const seen = new Set();
  for (const item of remembered) {
    const record = normalizeRememberedProviderRecord(item);
    if (!record || seen.has(record.id)) continue;
    records.push(record);
    seen.add(record.id);
  }
  return records;
}

function getRememberedProviderIdsFromFile(filePath) {
  try {
    return getRememberedProviderRecordsFromConfig(readJsoncFile(filePath));
  } catch {
    return [];
  }
}

function getRememberedProviderRecords(paths) {
  const recordsById = new Map();
  for (const record of paths.flatMap((filePath) => getRememberedProviderIdsFromFile(filePath))) {
    recordsById.set(record.id, { ...recordsById.get(record.id), ...record });
  }
  return Array.from(recordsById.values());
}

function createRememberedProviderRecord(input) {
  if (!input) return null;
  if (typeof input === 'string') {
    const id = normalizeString(input);
    return id ? { id } : null;
  }
  const id = normalizeString(input.id);
  if (!id) return null;
  return {
    id,
    title: normalizeString(input.title) || undefined,
    description: normalizeString(input.description) || undefined,
    expectedAgentName: normalizeString(input.expectedAgentName) || undefined,
    managementSurfaceId: normalizeString(input.managementSurfaceId) || undefined,
    rawEntry: input.rawEntry,
  };
}

function providerEntryToRememberedRecord(entry) {
  if (!entry?.providerId || !entry.provider) return null;
  return createRememberedProviderRecord({
    id: entry.providerId,
    title: entry.provider.title,
    description: entry.provider.description,
    expectedAgentName: entry.provider.expectedAgentName,
    managementSurfaceId: entry.provider.managementSurfaceId,
    rawEntry: entry.rawEntry ?? entry.entry,
  });
}

function validateRememberedProviderRawEntry(record, providerId) {
  if (!record?.rawEntry) return false;
  const provider = getAgentOrchestrationProviderCandidate({
    spec: getPluginSpec(record.rawEntry),
    options: getPluginOptions(record.rawEntry),
  });
  return provider?.id === providerId;
}

function updateRememberedProviderRecords(filePath, records) {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '{\n}\n';
  if (!content.trim()) content = '{\n}\n';
  const config = parseJsoncObject(content, filePath);
  const recordsById = new Map(getRememberedProviderRecordsFromConfig(config).map((record) => [record.id, record]));
  for (const item of records) {
    const record = createRememberedProviderRecord(item);
    if (record) recordsById.set(record.id, { ...recordsById.get(record.id), ...record });
  }
  const nextRecords = Array.from(recordsById.values()).map(serializeRememberedProviderRecord);
  const nextContent = applyEdits(content, modifyJsonc(content, ['openchamber', 'agentOrchestration', 'rememberedProviders'], nextRecords.length > 0 ? nextRecords : undefined, {
    formattingOptions: JSONC_FORMATTING_OPTIONS,
  }));
  if (nextContent !== content || !fs.existsSync(filePath)) {
    writeJsoncContent(filePath, nextContent);
  }
}

function scanConfigPlugins(filePath, scope, surface = 'opencode') {
  if (!fs.existsSync(filePath)) return [];
  const result = [];
  try {
    const config = readJsoncFile(filePath);
    for (const key of ['plugin', 'plugins']) {
      const entries = getPluginArray(config, key);
      entries.forEach((entry, index) => {
        const spec = getPluginSpec(entry);
        const provider = getAgentOrchestrationProviderCandidate({ spec, options: getPluginOptions(entry) });
        if (provider) {
          result.push({ path: filePath, key, index, entry: spec, rawEntry: entry, mode: provider.legacyMode, providerId: provider.id, provider, scope, surface });
        }
      });
    }
  } catch {
    // The dedicated config routes surface malformed files.
  }
  return result;
}

function resolveMode(entries) {
  const hasSlim = entries.some((entry) => entry.mode === MODE_SLIM);
  const hasOmo = entries.some((entry) => entry.mode === MODE_OMO);
  if (hasSlim && hasOmo) return MODE_CONFLICT;
  if (hasSlim) return MODE_SLIM;
  if (hasOmo) return MODE_OMO;
  return MODE_NATIVE;
}

function getActiveProviderIds(entries) {
  return Array.from(new Set(entries.map((entry) => entry.providerId).filter(Boolean)));
}

function getConfigScan(directory) {
  const userPaths = getUserOpenCodeConfigCandidates();
  const legacyUserPaths = getLegacyUserOpenCodeConfigCandidates();
  const projectPaths = getProjectOpenCodeConfigCandidates(directory);
  const tuiPaths = getUserTuiConfigCandidates();
  const userEntries = userPaths.flatMap((filePath) => scanConfigPlugins(filePath, 'user', 'opencode'));
  const legacyUserEntries = legacyUserPaths.flatMap((filePath) => scanConfigPlugins(filePath, 'user', 'opencode-legacy'));
  const projectEntries = projectPaths.flatMap((filePath) => scanConfigPlugins(filePath, 'project', 'opencode'));
  const tuiEntries = tuiPaths.flatMap((filePath) => scanConfigPlugins(filePath, 'user', 'tui'));
  const allEntries = [...userEntries, ...projectEntries, ...tuiEntries];
  const rememberedProviderRecords = getRememberedProviderRecords([...userPaths, ...legacyUserPaths, ...projectPaths]);
  const localProviderSignals = getKnownProviderLocalSignals(directory);
  const configPaths = Array.from(new Set([
    ...userPaths.filter((filePath) => fs.existsSync(filePath)),
    ...projectPaths.filter((filePath) => fs.existsSync(filePath)),
    getPrimaryUserOpenCodeConfigPath(),
  ]));
  const tuiConfigPath = getPrimaryUserTuiConfigPath();
  const mtimePaths = [
    ...userPaths,
    ...legacyUserPaths,
    ...projectPaths,
    ...tuiPaths,
    getPrimaryUserOpenCodeConfigPath(),
    tuiConfigPath,
  ];
  const mtimeMsByPath = {};
  for (const filePath of Array.from(new Set(mtimePaths.filter(Boolean)))) {
    mtimeMsByPath[filePath] = getFileMtimeMs(filePath);
  }
  return {
    userPaths,
    legacyUserPaths,
    projectPaths,
    tuiPaths,
    userEntries,
    legacyUserEntries,
    projectEntries,
    tuiEntries,
    allEntries,
    rememberedProviderRecords,
    localProviderSignals,
    configPaths,
    tuiConfigPath,
    mtimeMsByPath,
  };
}

function getModeInfo(directory) {
  const scan = getConfigScan(directory);
  return getModeInfoFromScan(scan);
}

function getModeInfoFromScan(scan) {
  const userMode = resolveMode(scan.userEntries);
  const projectMode = scan.projectEntries.length > 0 ? resolveMode(scan.projectEntries) : null;
  const allMode = resolveMode([...scan.userEntries, ...scan.projectEntries]);
  const providerIds = getActiveProviderIds([...scan.userEntries, ...scan.projectEntries]);
  const effective = allMode === MODE_CONFLICT ? MODE_CONFLICT : (projectMode && projectMode !== MODE_NATIVE ? projectMode : userMode);
  const conflicts = [];
  if (allMode === MODE_CONFLICT || providerIds.length > 1) {
    conflicts.push('OpenCode config contains multiple agent orchestration provider entries.');
  }
  if (scan.tuiEntries.some((entry) => entry.mode === MODE_SLIM) && effective !== MODE_SLIM) {
    conflicts.push('TUI config still contains oh-my-opencode-slim while Slim mode is not active.');
  }
  if (scan.legacyUserEntries.length > 0) {
    conflicts.push('Legacy config.json contains agent orchestration plugin entries that OpenCode may ignore. Save the mode again to move them to opencode.jsonc.');
  }
  return {
    effective,
    user: userMode,
    project: projectMode,
    conflicts,
    configPaths: scan.configPaths,
    tuiConfigPath: scan.tuiConfigPath,
    mtimeMsByPath: scan.mtimeMsByPath,
  };
}

function getProviderStateForMode(mode) {
  if (mode === MODE_CONFLICT) return 'conflict';
  if (mode === MODE_NATIVE) return 'native';
  return 'active';
}

function getProviderInfo(mode, entries, rememberedProviderRecords = [], localProviderSignals = new Map()) {
  const rememberedProviderIds = rememberedProviderRecords.map((record) => record.id);
  const providerIds = getActiveProviderIds(entries.filter((entry) => entry.surface !== 'tui'));
  const providerState = mode.effective === MODE_CONFLICT || providerIds.length > 1
    ? 'conflict'
    : providerIds.length === 1 ? 'active' : getProviderStateForMode(mode.effective);
  const activeProviderId = providerState === 'active'
    ? providerIds[0] ?? getProviderIdForLegacyMode(mode.effective)
    : null;
  const providersById = new Map();
  for (const descriptor of AGENT_ORCHESTRATION_PROVIDER_DESCRIPTORS) {
    const remembered = rememberedProviderIds.includes(descriptor.id);
    const localSignals = localProviderSignals.get(descriptor.id) ?? {};
    providersById.set(descriptor.id, {
      id: descriptor.id,
      legacyMode: descriptor.legacyMode,
      title: descriptor.title,
      description: descriptor.description ?? null,
      active: activeProviderId === descriptor.id,
      installed: false,
      configured: false,
      configFileConfigured: localSignals.configFileConfigured === true,
      localPackageInstalled: localSignals.localPackageInstalled === true,
      managementSurfaceId: descriptor.managementSurfaceId,
      expectedAgentName: descriptor.expectedAgentName ?? null,
      known: true,
      configurable: Boolean(descriptor.managementSurfaceId),
      remembered,
    });
  }
  for (const entry of entries.filter((item) => item.surface !== 'tui')) {
    if (!entry.providerId || !entry.provider) continue;
    const previous = providersById.get(entry.providerId) ?? {};
    providersById.set(entry.providerId, {
      id: entry.provider.id,
      legacyMode: entry.provider.legacyMode,
      title: entry.provider.title,
      description: entry.provider.description ?? null,
      active: activeProviderId === entry.provider.id,
      installed: true,
      configured: true,
      configFileConfigured: previous.configFileConfigured === true,
      localPackageInstalled: previous.localPackageInstalled === true,
      managementSurfaceId: entry.provider.managementSurfaceId,
      expectedAgentName: entry.provider.expectedAgentName ?? null,
      known: entry.provider.known === true,
      configurable: entry.provider.configurable === true,
      remembered: rememberedProviderIds.includes(entry.provider.id),
    });
  }
  for (const record of rememberedProviderRecords) {
    const providerId = record.id;
    if (providersById.has(providerId)) continue;
    const descriptor = getAgentOrchestrationProviderById(providerId);
    const provider = getAgentOrchestrationProviderCandidateForDescriptor(descriptor);
    if (!provider && !record.rawEntry) continue;
    providersById.set(providerId, {
      id: provider?.id ?? record.id,
      legacyMode: provider?.legacyMode ?? null,
      title: provider?.title ?? record.title ?? 'Agent provider plugin',
      description: provider?.description ?? record.description ?? null,
      active: false,
      installed: false,
      configured: false,
      configFileConfigured: false,
      localPackageInstalled: false,
      managementSurfaceId: provider?.managementSurfaceId ?? record.managementSurfaceId ?? `generic-agent-provider:${record.id}`,
      expectedAgentName: provider?.expectedAgentName ?? record.expectedAgentName ?? null,
      known: provider ? true : false,
      configurable: provider?.configurable === true,
      remembered: true,
    });
  }
  const providers = Array.from(providersById.values()).map((provider) => {
    const matchingEntries = entries.filter((entry) => entry.providerId === provider.id);
    const configured = matchingEntries.length > 0 || provider.configured === true;
    const configFileConfigured = provider.configFileConfigured === true;
    const localPackageInstalled = provider.localPackageInstalled === true;
    return {
      ...provider,
      active: activeProviderId === provider.id,
      configured,
      configFileConfigured,
      localPackageInstalled,
      installed: configured || configFileConfigured || localPackageInstalled,
      remembered: provider.remembered === true,
    };
  });
  return {
    activeProviderId,
    providerState,
    providers,
    diagnostics: {
      conflicts: mode.conflicts,
      configPaths: mode.configPaths,
      tuiConfigPath: mode.tuiConfigPath,
      mtimeMsByPath: mode.mtimeMsByPath,
    },
  };
}

function createConfigModifiedError() {
  const error = new Error('Config was modified outside OpenChamber. Reload before saving again.');
  error.code = 'CONFIG_MODIFIED';
  return error;
}

function hasMtimeMismatch(filePath, expectedMtimeMs) {
  const currentMtimeMs = getFileMtimeMs(filePath);
  if (expectedMtimeMs == null) return currentMtimeMs != null;
  if (currentMtimeMs == null) return true;
  return Math.abs(currentMtimeMs - expectedMtimeMs) > 1;
}

function shouldCheckMtime(filePath, expectedMtimeMsByPath) {
  return isPlainObject(expectedMtimeMsByPath) && Object.prototype.hasOwnProperty.call(expectedMtimeMsByPath, filePath);
}

function assertNoMtimeMismatches(filePaths, expectedMtimeMsByPath) {
  for (const filePath of filePaths) {
    if (shouldCheckMtime(filePath, expectedMtimeMsByPath) && hasMtimeMismatch(filePath, expectedMtimeMsByPath[filePath])) {
      throw createConfigModifiedError();
    }
  }
}

function assertNoExpectedMtimeMismatches(expectedMtimeMsByPath) {
  if (!isPlainObject(expectedMtimeMsByPath)) return;
  assertNoMtimeMismatches(Object.keys(expectedMtimeMsByPath), expectedMtimeMsByPath);
}

function removeKnownOrchestrationEntries(entries) {
  return entries.filter((entry) => {
    const provider = getAgentOrchestrationProviderCandidate({ spec: getPluginSpec(entry), options: getPluginOptions(entry) });
    return provider == null;
  });
}

function updateConfigPluginEntries(filePath, desiredMode, { allowAdd = false, surface = 'opencode', addEntry } = {}) {
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '{\n}\n';
  if (!content.trim()) content = '{\n}\n';
  const config = parseJsoncObject(content, filePath);
  const preferredKey = getPreferredPluginArrayKey(config);
  const keys = Array.from(new Set([preferredKey, 'plugin', 'plugins']));
  let nextContent = content;
  let changed = false;

  for (const key of keys) {
    const existing = getPluginArray(config, key);
    if (existing.length === 0 && key !== preferredKey) continue;
    const filtered = removeKnownOrchestrationEntries(existing);
    let nextEntries = filtered;
    if (allowAdd && key === preferredKey) {
      const defaultEntry = addEntry ?? getDefaultSpecForLegacyMode(desiredMode, { surface });
      if (defaultEntry) {
        nextEntries = [...filtered, defaultEntry];
      }
    }
    const equal = existing.length === nextEntries.length && existing.every((entry, index) => entry === nextEntries[index]);
    if (equal && Array.isArray(config?.[key])) continue;
    nextContent = updateJsoncRawProperty(nextContent, key, nextEntries.length > 0 ? nextEntries : undefined);
    changed = true;
  }

  if (changed || (allowAdd && !fs.existsSync(filePath))) {
    writeJsoncContent(filePath, nextContent);
  }
  return changed;
}

function getPathsWithKnownEntries(paths) {
  return paths.filter((filePath) => scanConfigPlugins(filePath, 'unknown').length > 0);
}

function setAgentOrchestrationMode(input = {}) {
  const directory = normalizeString(input.directory);
  const mode = normalizeString(input.mode);
  if (![MODE_NATIVE, MODE_SLIM, MODE_OMO].includes(mode)) {
    const error = new Error('Invalid agent orchestration mode.');
    error.code = 'INVALID_MODE';
    throw error;
  }

  const userTarget = getPrimaryUserOpenCodeConfigPath();
  const tuiTarget = getPrimaryUserTuiConfigPath();
  const scan = getConfigScan(directory);
  const existingPathsToClean = Array.from(new Set([
    ...getPathsWithKnownEntries(getUserOpenCodeConfigCandidates()),
    ...getPathsWithKnownEntries(getLegacyUserOpenCodeConfigCandidates()),
    ...getPathsWithKnownEntries(getProjectOpenCodeConfigCandidates(directory)),
  ]));
  const existingTuiPathsToClean = Array.from(new Set(getPathsWithKnownEntries(getUserTuiConfigCandidates())));
  const pathsToWrite = Array.from(new Set([
    ...existingPathsToClean,
    userTarget,
    ...(mode === MODE_NATIVE ? [] : [userTarget]),
    ...existingTuiPathsToClean,
    ...(legacyModeUsesTui(mode) ? [tuiTarget] : []),
  ]));

  assertNoExpectedMtimeMismatches(input.expectedMtimeMsByPath);
  assertNoMtimeMismatches(pathsToWrite, input.expectedMtimeMsByPath);

  const activeProviderRecords = [
    ...scan.userEntries,
    ...scan.projectEntries,
  ].map(providerEntryToRememberedRecord).filter(Boolean);
  const targetProviderId = getProviderIdForLegacyMode(mode);

  for (const filePath of existingPathsToClean) {
    updateConfigPluginEntries(filePath, MODE_NATIVE, { allowAdd: false, surface: 'opencode' });
  }
  if (mode !== MODE_NATIVE) {
    updateConfigPluginEntries(userTarget, mode, { allowAdd: true, surface: 'opencode' });
  }

  for (const filePath of existingTuiPathsToClean) {
    updateConfigPluginEntries(filePath, MODE_NATIVE, { allowAdd: false, surface: 'tui' });
  }
  if (legacyModeUsesTui(mode)) {
    updateConfigPluginEntries(tuiTarget, mode, { allowAdd: true, surface: 'tui' });
  }

  updateRememberedProviderRecords(userTarget, [...activeProviderRecords, targetProviderId].filter(Boolean));

  return readAgentOrchestrationConfig({ directory });
}

function normalizeProviderId(value) {
  const providerId = normalizeString(value);
  if (!providerId || providerId === MODE_NATIVE) return null;
  return providerId;
}

function setAgentOrchestrationProvider(input = {}) {
  const providerId = normalizeProviderId(input.providerId);
  const mode = providerId == null ? MODE_NATIVE : getLegacyModeForProviderId(providerId);
  if (!mode) {
    const directory = normalizeString(input.directory);
    const scan = getConfigScan(directory);
    const existingEntry = [...scan.userEntries, ...scan.projectEntries].find((entry) => entry.providerId === providerId);
    const rememberedRecord = scan.rememberedProviderRecords.find((record) => record.id === providerId && validateRememberedProviderRawEntry(record, providerId)) ?? null;
    if (!existingEntry && !rememberedRecord) {
      const error = new Error('Invalid agent orchestration provider.');
      error.code = 'INVALID_PROVIDER';
      throw error;
    }
    const userTarget = getPrimaryUserOpenCodeConfigPath();
    const pathsToClean = Array.from(new Set([
      ...getPathsWithKnownEntries(getUserOpenCodeConfigCandidates()),
      ...getPathsWithKnownEntries(getLegacyUserOpenCodeConfigCandidates()),
      ...getPathsWithKnownEntries(getProjectOpenCodeConfigCandidates(directory)),
    ]));
    const tuiPathsToClean = Array.from(new Set(getPathsWithKnownEntries(getUserTuiConfigCandidates())));
    assertNoExpectedMtimeMismatches(input.expectedMtimeMsByPath);
    assertNoMtimeMismatches([...pathsToClean, ...tuiPathsToClean, userTarget], input.expectedMtimeMsByPath);
    for (const filePath of pathsToClean) {
      updateConfigPluginEntries(filePath, MODE_NATIVE, { allowAdd: false, surface: 'opencode' });
    }
    for (const filePath of tuiPathsToClean) {
      updateConfigPluginEntries(filePath, MODE_NATIVE, { allowAdd: false, surface: 'tui' });
    }
    updateConfigPluginEntries(userTarget, MODE_NATIVE, { allowAdd: true, surface: 'opencode', addEntry: existingEntry?.rawEntry ?? existingEntry?.entry ?? rememberedRecord.rawEntry });
    updateRememberedProviderRecords(userTarget, [
      ...[...scan.userEntries, ...scan.projectEntries].map(providerEntryToRememberedRecord).filter(Boolean),
      providerEntryToRememberedRecord(existingEntry) ?? rememberedRecord ?? providerId,
    ]);
    return readAgentOrchestrationConfig({ directory });
  }
  return setAgentOrchestrationMode({
    directory: input.directory,
    mode,
    expectedMtimeMsByPath: input.expectedMtimeMsByPath,
  });
}

function readAgentOrchestrationConfig(options = {}) {
  const directory = normalizeString(options.directory);
  const scan = getConfigScan(directory);
  const mode = getModeInfoFromScan(scan);
  return {
    mode,
    ...getProviderInfo(mode, [...scan.userEntries, ...scan.projectEntries, ...scan.tuiEntries], scan.rememberedProviderRecords, scan.localProviderSignals),
    omo: readOpenAgentConfig({ directory }),
    slim: readSlimConfig({ directory }),
  };
}

export {
  MODE_NATIVE,
  MODE_SLIM,
  MODE_OMO,
  MODE_CONFLICT,
  readAgentOrchestrationConfig,
  setAgentOrchestrationMode,
  setAgentOrchestrationProvider,
};
