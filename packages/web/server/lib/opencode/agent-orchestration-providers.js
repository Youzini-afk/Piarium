const MODE_NATIVE = 'native';
const MODE_SLIM = 'slim';
const MODE_OMO = 'omo';

const PROVIDER_SLIM = 'oh-my-opencode-slim';
const PROVIDER_OMO = 'oh-my-openagent';

const AGENT_ORCHESTRATION_PROVIDER_DESCRIPTORS = Object.freeze([
  Object.freeze({
    id: PROVIDER_SLIM,
    legacyMode: MODE_SLIM,
    title: 'Oh My OpenCode Slim',
    description: 'Lightweight specialist routing for everyday tasks.',
    defaultSpec: 'oh-my-opencode-slim',
    packageNames: Object.freeze(['oh-my-opencode-slim']),
    aliases: Object.freeze([]),
    expectedAgentName: 'orchestrator',
    managementSurfaceId: 'slim-agent-provider-settings',
    tui: Object.freeze({
      enabledWhenActive: true,
      defaultSpec: 'oh-my-opencode-slim',
    }),
  }),
  Object.freeze({
    id: PROVIDER_OMO,
    legacyMode: MODE_OMO,
    title: 'Oh My OpenAgent',
    description: 'Multi-agent orchestration provider for complex tasks.',
    defaultSpec: 'oh-my-openagent',
    packageNames: Object.freeze(['oh-my-openagent']),
    aliases: Object.freeze(['oh-my-opencode']),
    expectedAgentName: 'sisyphus',
    managementSurfaceId: 'openagent-agent-provider-settings',
  }),
]);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getPluginBasename(spec) {
  const normalized = normalizeString(spec).replace(/\\/g, '/');
  return normalized.split('/').pop() ?? normalized;
}

function matchesPackageOrAlias(spec, descriptor) {
  const basename = getPluginBasename(spec);
  const names = [...descriptor.packageNames, ...(descriptor.aliases ?? [])];
  return names.some((name) => basename === name || basename.startsWith(`${name}@`));
}

function getAgentOrchestrationProviderForSpec(spec) {
  return AGENT_ORCHESTRATION_PROVIDER_DESCRIPTORS.find((descriptor) => matchesPackageOrAlias(spec, descriptor)) ?? null;
}

function getAgentOrchestrationProviderById(providerId) {
  return AGENT_ORCHESTRATION_PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.id === providerId) ?? null;
}

function getAgentOrchestrationProviderCandidateForDescriptor(descriptor) {
  if (!descriptor) return null;
  return {
    id: descriptor.id,
    legacyMode: descriptor.legacyMode,
    title: descriptor.title,
    description: descriptor.description ?? null,
    defaultSpec: descriptor.defaultSpec,
    packageNames: descriptor.packageNames,
    aliases: descriptor.aliases ?? Object.freeze([]),
    expectedAgentName: descriptor.expectedAgentName ?? null,
    managementSurfaceId: descriptor.managementSurfaceId ?? null,
    known: true,
    configurable: Boolean(descriptor.managementSurfaceId),
    panelKind: descriptor.legacyMode === MODE_SLIM ? 'slim-orchestration-config' : 'openagent-config',
  };
}

function getAgentOrchestrationProviderByLegacyMode(mode) {
  return AGENT_ORCHESTRATION_PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.legacyMode === mode) ?? null;
}

function getLegacyModeForProviderId(providerId) {
  return getAgentOrchestrationProviderById(providerId)?.legacyMode ?? null;
}

function getProviderIdForLegacyMode(mode) {
  if (mode === MODE_NATIVE) return null;
  return getAgentOrchestrationProviderByLegacyMode(mode)?.id ?? null;
}

function getDefaultSpecForLegacyMode(mode, { surface = 'opencode' } = {}) {
  const descriptor = getAgentOrchestrationProviderByLegacyMode(mode);
  if (!descriptor) return null;
  if (surface === 'tui') return descriptor.tui?.defaultSpec ?? null;
  return descriptor.defaultSpec ?? null;
}

function legacyModeUsesTui(mode) {
  return getAgentOrchestrationProviderByLegacyMode(mode)?.tui?.enabledWhenActive === true;
}

function getExpectedAgentNameForLegacyMode(mode) {
  if (mode === MODE_NATIVE) return 'build';
  return getAgentOrchestrationProviderByLegacyMode(mode)?.expectedAgentName ?? null;
}

function getProviderIdForSpec(spec) {
  return getAgentOrchestrationProviderForSpec(spec)?.id ?? null;
}

function stripNpmVersion(spec) {
  const normalized = normalizeString(spec).replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;
  if (normalized.startsWith('@')) {
    const parts = normalized.split('/');
    if (parts.length >= 2) {
      const packageName = `${parts[0]}/${parts[1]}`;
      return packageName.replace(/@[^/@]+$/, '');
    }
  }
  return basename.replace(/@[^/@]+$/, '');
}

function titleFromPluginSpec(spec) {
  const normalized = stripNpmVersion(spec);
  if (!normalized) return 'Agent provider plugin';
  return normalized
    .replace(/^@/, '')
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function getDeclaredAgentProviderCapability(options) {
  if (!isPlainObject(options)) return null;
  const openchamber = isPlainObject(options.openchamber) ? options.openchamber : null;
  const capabilities = isPlainObject(openchamber?.capabilities) ? openchamber.capabilities : null;
  const capability = capabilities?.agentOrchestrationProvider
    ?? capabilities?.agentProvider
    ?? openchamber?.agentOrchestrationProvider
    ?? options.agentOrchestrationProvider;
  if (capability === true) return {};
  return isPlainObject(capability) ? capability : null;
}

function buildGenericProviderId(spec, capability) {
  const declaredId = normalizeString(capability?.id);
  const reservedIds = new Set([
    MODE_NATIVE,
    'conflict',
    ...AGENT_ORCHESTRATION_PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.id),
  ]);
  if (declaredId && !reservedIds.has(declaredId)) return declaredId;
  return `plugin:${encodeURIComponent(normalizeString(spec).toLowerCase())}`;
}

function getAgentOrchestrationProviderCandidate(input = {}) {
  const spec = normalizeString(input.spec);
  if (!spec) return null;
  const descriptor = getAgentOrchestrationProviderForSpec(spec);
  if (descriptor) {
    return getAgentOrchestrationProviderCandidateForDescriptor(descriptor);
  }

  const capability = getDeclaredAgentProviderCapability(input.options);
  if (!capability) return null;
  const providerId = buildGenericProviderId(spec, capability);
  return {
    id: providerId,
    legacyMode: null,
    title: normalizeString(capability.title) || titleFromPluginSpec(spec),
    description: normalizeString(capability.description) || null,
    defaultSpec: spec,
    packageNames: Object.freeze([spec]),
    aliases: Object.freeze([]),
    expectedAgentName: normalizeString(capability.expectedAgentName) || null,
    managementSurfaceId: normalizeString(capability.managementSurfaceId) || `generic-agent-provider:${providerId}`,
    known: false,
    configurable: false,
    panelKind: 'generic-provider-config',
  };
}

export {
  AGENT_ORCHESTRATION_PROVIDER_DESCRIPTORS,
  MODE_NATIVE,
  MODE_SLIM,
  MODE_OMO,
  PROVIDER_OMO,
  PROVIDER_SLIM,
  getAgentOrchestrationProviderById,
  getAgentOrchestrationProviderCandidateForDescriptor,
  getAgentOrchestrationProviderByLegacyMode,
  getAgentOrchestrationProviderCandidate,
  getAgentOrchestrationProviderForSpec,
  getDefaultSpecForLegacyMode,
  getExpectedAgentNameForLegacyMode,
  getLegacyModeForProviderId,
  getProviderIdForSpec,
  getProviderIdForLegacyMode,
  legacyModeUsesTui,
};
