import { describe, expect, test } from 'bun:test';

import {
  BUILT_IN_SKILL_LOCATION,
  fetchProviderModels,
  getSkillSources,
  mergeDiscoveredSkills,
} from './opencodeConfig';

describe('VS Code skill discovery parity', () => {
  test('merges OpenCode API skills with locally discovered fallback skills', () => {
    const merged = mergeDiscoveredSkills(
      [
        { name: 'built-in', path: BUILT_IN_SKILL_LOCATION, scope: 'user', source: 'opencode' },
        { name: 'local-first', path: '/tmp/local-first/SKILL.md', scope: 'user', source: 'agents' },
      ],
      [
        { name: 'local-first', path: '/tmp/local-first/SKILL.md', scope: 'user', source: 'agents' },
        { name: 'local-only', path: '/tmp/local-only/SKILL.md', scope: 'project', source: 'claude' },
      ],
    );

    expect(merged.map((skill) => skill.name)).toEqual(['built-in', 'local-first', 'local-only']);
  });

  test('resolves built-in skills without treating the virtual location as a file', () => {
    const discoveredSkill = {
      name: 'customize-opencode',
      path: BUILT_IN_SKILL_LOCATION,
      scope: 'user',
      source: 'opencode',
      description: 'Customize opencode',
      content: '# Customize opencode\n\nUse for config work.',
    };

    const sources = getSkillSources('customize-opencode', '/tmp/openchamber-vscode-skills-test', discoveredSkill);

    expect(sources.md.exists).toBe(true);
    expect(sources.md.path).toBeNull();
    expect(sources.md.dir).toBeNull();
    expect(sources.md.scope).toBe('user');
    expect(sources.md.source).toBe('opencode');
    expect(sources.md.description).toBe('Customize opencode');
    expect(sources.md.instructions).toBe('# Customize opencode\n\nUse for config work.');
    expect(sources.md.fields).toEqual(['description', 'instructions']);
  });
});

describe('VS Code custom provider model fetch parity', () => {
  test('preserves fetched model token limit aliases', async () => {
    const fetchMock = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'context-only', context_window: 128000 },
          { id: 'complete-limit', context_window: '256,000', max_output_tokens: '16,384' },
        ],
      }),
    });

    const result = await fetchProviderModels({
      type: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-test',
    }, fetchMock);

    expect(result.models).toEqual([
      {
        id: 'context-only',
        name: 'context-only',
        limit: {
          context: 128000,
          output: 8192,
        },
      },
      {
        id: 'complete-limit',
        name: 'complete-limit',
        limit: {
          context: 256000,
          output: 16384,
        },
      },
    ]);
  });
});
