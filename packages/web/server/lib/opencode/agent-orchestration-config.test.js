import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;

let tempHome;

async function loadModule() {
  return import(/* @vite-ignore */ `./agent-orchestration-config.js?test=${Date.now()}-${Math.random()}`);
}

function readJsoncObject(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const withoutComments = content.replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(withoutComments);
}

describe('agent orchestration config helpers', () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-agent-orchestration-test-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.OPENCODE_CONFIG_DIR = path.join(tempHome, '.config', 'opencode');
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    if (originalOpenCodeConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = originalOpenCodeConfigDir;
    fs.rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  });

  it('detects native, Slim, OMO, and conflict modes', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const opencodePath = path.join(configDir, 'opencode.jsonc');
    fs.mkdirSync(configDir, { recursive: true });

    const { readAgentOrchestrationConfig } = await loadModule();

    expect(readAgentOrchestrationConfig().mode.effective).toBe('native');

    fs.writeFileSync(opencodePath, '{ "plugin": ["oh-my-opencode-slim"] }\n');
    expect(readAgentOrchestrationConfig().mode.effective).toBe('slim');

    fs.writeFileSync(opencodePath, '{ "plugin": ["oh-my-openagent"] }\n');
    expect(readAgentOrchestrationConfig().mode.effective).toBe('omo');

    fs.writeFileSync(opencodePath, '{ "plugin": ["oh-my-openagent", "oh-my-opencode-slim"] }\n');
    expect(readAgentOrchestrationConfig().mode.effective).toBe('conflict');
  });

  it('exposes provider state alongside the legacy mode response', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const opencodePath = path.join(configDir, 'opencode.jsonc');
    fs.mkdirSync(configDir, { recursive: true });

    const { readAgentOrchestrationConfig } = await loadModule();

    const nativeConfig = readAgentOrchestrationConfig();
    expect(nativeConfig.mode.effective).toBe('native');
    expect(nativeConfig.activeProviderId).toBeNull();
    expect(nativeConfig.providerState).toBe('native');
    expect(nativeConfig.providers.every((provider) => !provider.active)).toBe(true);

    fs.writeFileSync(opencodePath, '{ "plugin": ["oh-my-opencode-slim"] }\n');
    const slimConfig = readAgentOrchestrationConfig();
    expect(slimConfig.mode.effective).toBe('slim');
    expect(slimConfig.activeProviderId).toBe('oh-my-opencode-slim');
    expect(slimConfig.providerState).toBe('active');
    expect(slimConfig.providers.find((provider) => provider.id === 'oh-my-opencode-slim')).toMatchObject({
      active: true,
      installed: true,
      configured: true,
      legacyMode: 'slim',
      expectedAgentName: 'orchestrator',
    });

    fs.writeFileSync(opencodePath, '{ "plugin": ["oh-my-openagent", "oh-my-opencode-slim"] }\n');
    const conflictConfig = readAgentOrchestrationConfig();
    expect(conflictConfig.mode.effective).toBe('conflict');
    expect(conflictConfig.activeProviderId).toBeNull();
    expect(conflictConfig.providerState).toBe('conflict');
    expect(conflictConfig.diagnostics.conflicts).toBe(conflictConfig.mode.conflicts);
    expect(conflictConfig.diagnostics.mtimeMsByPath).toBe(conflictConfig.mode.mtimeMsByPath);
  });

  it('exposes known providers installed in OpenCode package cache without showing unknown candidates', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const cacheDir = path.join(tempHome, '.cache', 'opencode', 'packages');
    const opencodePath = path.join(configDir, 'opencode.jsonc');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(cacheDir, 'oh-my-openagent@latest'), { recursive: true });
    fs.mkdirSync(path.join(cacheDir, 'unrelated-agent-plugin@latest'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'oh-my-openagent@latest', 'package.json'), '{ "name": "oh-my-openagent" }\n');
    fs.writeFileSync(path.join(cacheDir, 'unrelated-agent-plugin@latest', 'package.json'), '{ "name": "unrelated-agent-plugin" }\n');
    fs.writeFileSync(opencodePath, '{ "plugin": ["oh-my-opencode-slim"] }\n');

    const { readAgentOrchestrationConfig } = await loadModule();
    const config = readAgentOrchestrationConfig();

    expect(config.providers.find((provider) => provider.id === 'oh-my-openagent')).toMatchObject({
      active: false,
      configured: false,
      localPackageInstalled: true,
      installed: true,
      remembered: false,
    });
    expect(config.providers.some((provider) => provider.id.includes('unrelated-agent-plugin'))).toBe(false);
  });

  it('exposes known providers with existing provider config files even when inactive', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const opencodePath = path.join(configDir, 'opencode.jsonc');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(opencodePath, '{ "plugin": ["oh-my-opencode-slim"] }\n');
    fs.writeFileSync(path.join(configDir, 'oh-my-openagent.json'), '{ "agents": { "sisyphus": {} } }\n');

    const { readAgentOrchestrationConfig } = await loadModule();
    const config = readAgentOrchestrationConfig();

    expect(config.providers.find((provider) => provider.id === 'oh-my-openagent')).toMatchObject({
      active: false,
      configured: false,
      configFileConfigured: true,
      installed: true,
    });
  });

  it('exposes explicitly declared third-party agent provider plugins without hardcoding their package names', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const opencodePath = path.join(configDir, 'opencode.jsonc');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(opencodePath, JSON.stringify({
      plugin: [
        ['third-party-agent-provider', {
          openchamber: {
            capabilities: {
              agentOrchestrationProvider: {
                id: 'third-party-agent-provider',
                title: 'Third Party Agent Provider',
                description: 'Custom routing provider.',
                expectedAgentName: 'third-agent',
              },
            },
          },
        }],
      ],
    }, null, 2));

    const { readAgentOrchestrationConfig } = await loadModule();
    const config = readAgentOrchestrationConfig();

    expect(config.mode.effective).toBe('native');
    expect(config.activeProviderId).toBe('third-party-agent-provider');
    expect(config.providerState).toBe('active');
    expect(config.providers.find((provider) => provider.id === 'third-party-agent-provider')).toMatchObject({
      active: true,
      installed: true,
      known: false,
      configurable: false,
      legacyMode: null,
      title: 'Third Party Agent Provider',
      description: 'Custom routing provider.',
      expectedAgentName: 'third-agent',
    });
  });

  it('namespaces generic provider IDs that collide with reserved provider identifiers', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const opencodePath = path.join(configDir, 'opencode.jsonc');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(opencodePath, JSON.stringify({
      plugin: [[
        'third-party-agent-provider',
        { openchamber: { capabilities: { agentOrchestrationProvider: { id: 'native', title: 'Colliding Provider' } } } },
      ]],
    }, null, 2));

    const { readAgentOrchestrationConfig } = await loadModule();
    const config = readAgentOrchestrationConfig();

    expect(config.activeProviderId).toBe('plugin:third-party-agent-provider');
    expect(config.providers.find((provider) => provider.id === 'plugin:third-party-agent-provider')).toMatchObject({
      known: false,
      title: 'Colliding Provider',
      installed: true,
    });
  });

  it('switches to a generic provider while removing stale Slim OpenCode and TUI entries', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const opencodePath = path.join(configDir, 'opencode.jsonc');
    const tuiPath = path.join(configDir, 'tui.jsonc');
    fs.mkdirSync(configDir, { recursive: true });
    const genericEntry = [
      'third-party-agent-provider',
      { openchamber: { capabilities: { agentOrchestrationProvider: { id: 'third-party-agent-provider', title: 'Third Party Agent Provider' } } } },
    ];
    fs.writeFileSync(opencodePath, JSON.stringify({ plugin: ['oh-my-opencode-slim', genericEntry] }, null, 2));
    fs.writeFileSync(tuiPath, JSON.stringify({ plugin: ['oh-my-opencode-slim'] }, null, 2));

    const { readAgentOrchestrationConfig, setAgentOrchestrationProvider } = await loadModule();
    const before = readAgentOrchestrationConfig();
    expect(before.providerState).toBe('conflict');

    const after = setAgentOrchestrationProvider({
      providerId: 'third-party-agent-provider',
      expectedMtimeMsByPath: before.mode.mtimeMsByPath,
    });

    expect(after.providerState).toBe('active');
    expect(after.activeProviderId).toBe('third-party-agent-provider');
    expect(readJsoncObject(opencodePath).plugin).toEqual([genericEntry]);
    expect(readJsoncObject(tuiPath).plugin).toBeUndefined();

    const nativeConfig = setAgentOrchestrationProvider({
      providerId: null,
      expectedMtimeMsByPath: after.mode.mtimeMsByPath,
    });
    expect(nativeConfig.providerState).toBe('native');
    expect(readJsoncObject(opencodePath).plugin).toBeUndefined();
    expect(nativeConfig.providers.find((provider) => provider.id === 'third-party-agent-provider')).toMatchObject({
      remembered: true,
      installed: false,
    });

    const restored = setAgentOrchestrationProvider({
      providerId: 'third-party-agent-provider',
      expectedMtimeMsByPath: nativeConfig.mode.mtimeMsByPath,
    });
    expect(restored.activeProviderId).toBe('third-party-agent-provider');
    expect(readJsoncObject(opencodePath).plugin).toEqual([genericEntry]);
  });

  it('detects versioned and path-based orchestration plugin specs and removes them in native mode', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const opencodePath = path.join(configDir, 'opencode.jsonc');
    fs.mkdirSync(configDir, { recursive: true });

    const { readAgentOrchestrationConfig, setAgentOrchestrationMode } = await loadModule();

    fs.writeFileSync(opencodePath, '{ "plugin": ["oh-my-opencode-slim@latest"] }\n');
    expect(readAgentOrchestrationConfig().mode.effective).toBe('slim');

    fs.writeFileSync(opencodePath, '{ "plugin": ["/tmp/plugins/oh-my-openagent@0.1.0"] }\n');
    expect(readAgentOrchestrationConfig().mode.effective).toBe('omo');

    fs.writeFileSync(opencodePath, JSON.stringify({
      plugin: [
        'other-plugin',
        'oh-my-opencode-slim@latest',
        '/tmp/plugins/oh-my-openagent@0.1.0',
        ['./vendor/oh-my-opencode@legacy', { enabled: true }],
      ],
    }, null, 2));
    const before = readAgentOrchestrationConfig();

    expect(before.mode.effective).toBe('conflict');

    const after = setAgentOrchestrationMode({
      mode: 'native',
      expectedMtimeMsByPath: before.mode.mtimeMsByPath,
    });

    expect(after.mode.effective).toBe('native');
    expect(readJsoncObject(opencodePath).plugin).toEqual(['other-plugin']);
  });

  it('switches Slim mode by removing OMO entries and writing OpenCode plus TUI configs', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const opencodePath = path.join(configDir, 'opencode.jsonc');
    const tuiPath = path.join(configDir, 'tui.jsonc');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(opencodePath, [
      '{',
      '  // keep opencode comment',
      '  "plugin": ["other-plugin", "oh-my-openagent"]',
      '}',
      '',
    ].join('\n'));
    fs.writeFileSync(tuiPath, '{ "plugin": ["other-tui-plugin"] }\n');

    const { readAgentOrchestrationConfig, setAgentOrchestrationMode } = await loadModule();
    const before = readAgentOrchestrationConfig();

    const after = setAgentOrchestrationMode({
      mode: 'slim',
      expectedMtimeMsByPath: before.mode.mtimeMsByPath,
    });

    expect(after.mode.effective).toBe('slim');
    expect(fs.readFileSync(opencodePath, 'utf8')).toContain('// keep opencode comment');
    expect(readJsoncObject(opencodePath).plugin).toEqual(['other-plugin', 'oh-my-opencode-slim']);
    expect(readJsoncObject(opencodePath).openchamber.agentOrchestration.rememberedProviders).toEqual([
      'oh-my-openagent',
      'oh-my-opencode-slim',
    ]);
    expect(after.providers.find((provider) => provider.id === 'oh-my-openagent')).toMatchObject({
      active: false,
      installed: false,
      remembered: true,
    });
    expect(readJsoncObject(tuiPath).plugin).toEqual(['other-tui-plugin', 'oh-my-opencode-slim']);
  });

  it('switches OMO mode by removing Slim from OpenCode and TUI configs', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const opencodePath = path.join(configDir, 'opencode.jsonc');
    const tuiPath = path.join(configDir, 'tui.jsonc');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(opencodePath, '{ "plugin": ["oh-my-opencode-slim", "other-plugin"] }\n');
    fs.writeFileSync(tuiPath, '{ "plugin": ["oh-my-opencode-slim", "other-tui-plugin"] }\n');

    const { readAgentOrchestrationConfig, setAgentOrchestrationMode } = await loadModule();
    const before = readAgentOrchestrationConfig();

    const after = setAgentOrchestrationMode({
      mode: 'omo',
      expectedMtimeMsByPath: before.mode.mtimeMsByPath,
    });

    expect(after.mode.effective).toBe('omo');
    expect(readJsoncObject(opencodePath).plugin).toEqual(['other-plugin', 'oh-my-openagent']);
    expect(readJsoncObject(tuiPath).plugin).toEqual(['other-tui-plugin']);
  });

  it('switches native mode by removing user, project, legacy, and TUI orchestration entries', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const opencodePath = path.join(configDir, 'opencode.jsonc');
    const legacyPath = path.join(configDir, 'config.json');
    const tuiPath = path.join(configDir, 'tui.jsonc');
    const projectDir = path.join(tempHome, 'project');
    const projectConfigPath = path.join(projectDir, '.opencode', 'opencode.jsonc');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(opencodePath, '{ "plugin": ["user-helper", "oh-my-openagent"] }\n');
    fs.writeFileSync(projectConfigPath, '{ "plugin": ["project-helper", "oh-my-opencode-slim"] }\n');
    fs.writeFileSync(legacyPath, '{ "plugin": ["legacy-helper", "oh-my-opencode"] }\n');
    fs.writeFileSync(tuiPath, '{ "plugin": ["tui-helper", "oh-my-opencode-slim"] }\n');

    const { readAgentOrchestrationConfig, setAgentOrchestrationMode } = await loadModule();
    const before = readAgentOrchestrationConfig({ directory: projectDir });

    expect(before.mode.effective).toBe('conflict');

    const after = setAgentOrchestrationMode({
      directory: projectDir,
      mode: 'native',
      expectedMtimeMsByPath: before.mode.mtimeMsByPath,
    });

    expect(after.mode.effective).toBe('native');
    expect(readJsoncObject(opencodePath).plugin).toEqual(['user-helper']);
    expect(readJsoncObject(projectConfigPath).plugin).toEqual(['project-helper']);
    expect(readJsoncObject(legacyPath).plugin).toEqual(['legacy-helper']);
    expect(readJsoncObject(tuiPath).plugin).toEqual(['tui-helper']);
  });

  it('ignores stale legacy config.json entries and moves orchestration plugins to opencode.jsonc', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const legacyPath = path.join(configDir, 'config.json');
    const opencodePath = path.join(configDir, 'opencode.jsonc');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(legacyPath, '{ "plugin": ["oh-my-openagent", "legacy-helper"] }\n');

    const { readAgentOrchestrationConfig, setAgentOrchestrationMode } = await loadModule();
    const before = readAgentOrchestrationConfig();

    expect(before.mode.effective).toBe('native');
    expect(before.mode.conflicts.join('\n')).toContain('Legacy config.json');

    const after = setAgentOrchestrationMode({
      mode: 'omo',
      expectedMtimeMsByPath: before.mode.mtimeMsByPath,
    });

    expect(after.mode.effective).toBe('omo');
    expect(readJsoncObject(legacyPath).plugin).toEqual(['legacy-helper']);
    expect(readJsoncObject(opencodePath).plugin).toEqual(['oh-my-openagent']);
  });

  it('rejects mode switches when a written config changed after it was read', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const opencodePath = path.join(configDir, 'opencode.jsonc');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(opencodePath, '{ "plugin": ["oh-my-openagent"] }\n');

    const { readAgentOrchestrationConfig, setAgentOrchestrationMode } = await loadModule();
    const before = readAgentOrchestrationConfig();
    fs.writeFileSync(opencodePath, '{ "plugin": ["oh-my-openagent", "external-plugin"] }\n');

    expect(() => setAgentOrchestrationMode({
      mode: 'native',
      expectedMtimeMsByPath: before.mode.mtimeMsByPath,
    })).toThrow(/modified outside OpenChamber/);

    expect(readJsoncObject(opencodePath).plugin).toEqual(['oh-my-openagent', 'external-plugin']);
  });

  it('rejects mode switches when a target config was created after it was read', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const opencodePath = path.join(configDir, 'opencode.jsonc');

    const { readAgentOrchestrationConfig, setAgentOrchestrationMode } = await loadModule();
    const before = readAgentOrchestrationConfig();
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(opencodePath, '{ "plugin": ["external-plugin"] }\n');

    expect(before.mode.mtimeMsByPath[opencodePath]).toBeNull();
    expect(() => setAgentOrchestrationMode({
      mode: 'slim',
      expectedMtimeMsByPath: before.mode.mtimeMsByPath,
    })).toThrow(/modified outside OpenChamber/);

    expect(readJsoncObject(opencodePath).plugin).toEqual(['external-plugin']);
  });

  it('switches orchestration providers through the provider API wrapper', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const opencodePath = path.join(configDir, 'opencode.jsonc');
    const tuiPath = path.join(configDir, 'tui.jsonc');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(opencodePath, '{ "plugin": ["other-plugin", "oh-my-openagent"] }\n');
    fs.writeFileSync(tuiPath, '{ "plugin": ["other-tui-plugin"] }\n');

    const { readAgentOrchestrationConfig, setAgentOrchestrationProvider } = await loadModule();
    const before = readAgentOrchestrationConfig();
    const after = setAgentOrchestrationProvider({
      providerId: 'oh-my-opencode-slim',
      expectedMtimeMsByPath: before.mode.mtimeMsByPath,
    });

    expect(after.mode.effective).toBe('slim');
    expect(after.activeProviderId).toBe('oh-my-opencode-slim');
    expect(readJsoncObject(opencodePath).plugin).toEqual(['other-plugin', 'oh-my-opencode-slim']);
    expect(readJsoncObject(tuiPath).plugin).toEqual(['other-tui-plugin', 'oh-my-opencode-slim']);
  });
});
