import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalOpenCodeConfigDir = process.env.OPENCODE_CONFIG_DIR;

let tempHome;

async function loadModule() {
  return import(/* @vite-ignore */ `./slim-config.js?test=${Date.now()}-${Math.random()}`);
}

function readJsoncObject(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const withoutComments = content.replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(withoutComments);
}

describe('oh-my-opencode-slim config helpers', () => {
  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-slim-config-test-'));
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

  it('resolves the user global JSONC path and reads project overrides as read-only hints', async () => {
    const projectDir = path.join(tempHome, 'project');
    const projectConfigDir = path.join(projectDir, '.opencode');
    const projectConfigPath = path.join(projectConfigDir, 'oh-my-opencode-slim.jsonc');
    fs.mkdirSync(projectConfigDir, { recursive: true });
    fs.writeFileSync(projectConfigPath, JSON.stringify({
      preset: 'project',
      disabled_agents: ['observer'],
      presets: { project: { oracle: { model: 'project/oracle' } } },
    }, null, 2));

    const { readSlimConfig } = await loadModule();
    const result = readSlimConfig({ directory: projectDir });

    expect(result.target).toMatchObject({
      scope: 'user',
      path: path.join(process.env.OPENCODE_CONFIG_DIR, 'oh-my-opencode-slim.jsonc'),
      exists: false,
      format: 'jsonc',
    });
    expect(result.project).toEqual({
      path: projectConfigPath,
      exists: true,
      overriddenKeys: ['disabled_agents', 'preset', 'presets'],
    });
    expect(result.effective.preset).toBe('project');
  });

  it('writes only managed Slim keys while preserving comments and unknown top-level fields', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const configPath = path.join(configDir, 'oh-my-opencode-slim.jsonc');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, [
      '{',
      '  // keep this comment',
      '  "customTopLevel": { "keep": true },',
      '  "preset": "openai",',
      '  "disabled_agents": ["observer"],',
      '  "presets": {',
      '    "openai": {',
      '      "oracle": { "model": "openai/old", "temperature": 1 }',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n'));

    const { readSlimConfig, saveSlimConfig } = await loadModule();
    const before = readSlimConfig();

    saveSlimConfig({
      expectedMtimeMs: before.target.mtimeMs,
      config: {
        preset: 'openai',
        disabled_agents: ['observer', 'orchestrator'],
        presets: {
          openai: {
            oracle: { model: '', variant: 'high', temperature: 3 },
            fixer: { model: 'openai/gpt-5.4-mini', temperature: 0.2 },
          },
        },
      },
    });

    const content = fs.readFileSync(configPath, 'utf8');
    const parsed = readJsoncObject(configPath);

    expect(content).toContain('// keep this comment');
    expect(parsed.customTopLevel).toEqual({ keep: true });
    expect(parsed.disabled_agents).toEqual(['observer']);
    expect(parsed.presets).toEqual({
      openai: {
        oracle: { variant: 'high' },
        fixer: { model: 'openai/gpt-5.4-mini', temperature: 0.2 },
      },
    });
  });

  it('creates the starter config when installing Slim', async () => {
    const { ensureSlimStarterConfig, STARTER_CONFIG } = await loadModule();

    const result = ensureSlimStarterConfig();
    const configPath = path.join(process.env.OPENCODE_CONFIG_DIR, 'oh-my-opencode-slim.jsonc');

    expect(result.target.exists).toBe(true);
    expect(readJsoncObject(configPath)).toEqual(STARTER_CONFIG);
  });

  it('rejects saves when the config was modified after it was read', async () => {
    const configDir = process.env.OPENCODE_CONFIG_DIR;
    const configPath = path.join(configDir, 'oh-my-opencode-slim.jsonc');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, '{ "preset": "openai" }\n');

    const { readSlimConfig, saveSlimConfig } = await loadModule();
    const before = readSlimConfig();
    fs.writeFileSync(configPath, '{ "preset": "external" }\n');
    const externalMtime = (before.target.mtimeMs ?? Date.now()) + 5000;
    fs.utimesSync(configPath, externalMtime / 1000, externalMtime / 1000);

    expect(() => saveSlimConfig({
      expectedMtimeMs: before.target.mtimeMs,
      config: { preset: 'openai' },
    })).toThrow(/modified outside OpenChamber/);

    expect(readJsoncObject(configPath).preset).toBe('external');
  });
});
