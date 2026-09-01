import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LoopRevisionConflictError,
  discoverLoops,
  parseLoopContent,
  readLoopFile,
  setLoopFileEnabled,
  writeLoopFile,
} from './loops.js';

const roots = [];
const tempRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'piarium-loops-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const validLoop = ({ name = 'digest', enabled = true } = {}) => `---\nname: ${name}\nschedule: "0 9 * * *"\nenabled: ${enabled}\nmodel: openai-codex/gpt-5.3-codex\nthinking: high\nrun_as_goal: true\ngoal_token_budget: 25000\n---\nReview the repository.\n`;

describe('Markdown scheduled task loops', () => {
  it('maps Pi-native fields without OpenCode permission or variant fields', () => {
    const parsed = parseLoopContent(validLoop());
    expect(parsed.error).toBeNull();
    expect(parsed.definition).toMatchObject({
      enabled: true,
      execution: {
        goalTokenBudget: 25_000,
        modelID: 'gpt-5.3-codex',
        providerID: 'openai-codex',
        runAsGoal: true,
        thinkingLevel: 'high',
      },
      name: 'digest',
      schedule: { cron: '0 9 * * *', kind: 'cron' },
    });
    expect(parsed.definition.execution.permissionAutoAccept).toBeUndefined();
    expect(parsed.definition.execution.variant).toBeUndefined();
  });

  it('does not impose small presentation caps on names or prompts', () => {
    const name = 'n'.repeat(500);
    const prompt = 'p'.repeat(25_000);
    const parsed = parseLoopContent(validLoop({ name }).replace('Review the repository.', prompt));
    expect(parsed.definition.name).toBe(name);
    expect(parsed.definition.execution.prompt).toBe(prompt);
  });

  it('recovers the name from malformed YAML for precedence safety', () => {
    const parsed = parseLoopContent('---\nname: shared\nschedule: [\n---\nRun.\n');
    expect(parsed.definition).toBeNull();
    expect(parsed.name).toBe('shared');
  });

  it('keeps CRLF and unknown keys when toggling a Windows-authored file', async () => {
    const root = await tempRoot();
    const filePath = path.join(root, 'crlf.md');
    const content = validLoop({ enabled: false })
      .replace('enabled: false', 'enabled: false\ncustom_key: keep-me')
      .replace(/\n/g, '\r\n');
    await writeFile(filePath, content);
    await setLoopFileEnabled(filePath, true);
    const next = await readFile(filePath, 'utf8');
    expect(next).toContain('\r\nenabled: true\r\n');
    expect(next).toContain('\r\ncustom_key: keep-me\r\n');
  });

  it('discovers nearest project loops before ancestors and user loops', async () => {
    const root = await tempRoot();
    const project = path.join(root, 'repo', 'packages', 'app');
    const home = path.join(root, 'home');
    await Promise.all([
      mkdir(path.join(root, 'repo', '.agents', 'loops'), { recursive: true }),
      mkdir(path.join(project, '.agents', 'loops'), { recursive: true }),
      mkdir(path.join(home, '.agents', 'loops'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(project, '.agents', 'loops', 'near.md'), validLoop({ name: 'shared' })),
      writeFile(path.join(root, 'repo', '.agents', 'loops', 'root.md'), validLoop({ name: 'shared' })),
      writeFile(path.join(home, '.agents', 'loops', 'user.md'), validLoop({ name: 'shared' })),
    ]);
    const loops = await discoverLoops(project, {
      homeDirectory: home,
      resolveWorktreeRoot: async () => path.join(root, 'repo'),
    });
    expect(loops.map((loop) => path.basename(loop.filePath))).toEqual(['near.md', 'root.md', 'user.md']);
  });

  it('preserves unknown frontmatter while toggling enabled', async () => {
    const root = await tempRoot();
    const filePath = path.join(root, 'loop.md');
    const content = validLoop({ enabled: false }).replace('enabled: false', 'enabled: false\ncustom_key: keep-me');
    await writeFile(filePath, content);
    const current = await readLoopFile(filePath);
    await setLoopFileEnabled(filePath, true, { expectedRevision: current.revision });
    const next = await readFile(filePath, 'utf8');
    expect(next).toContain('enabled: true');
    expect(next).toContain('custom_key: keep-me');
    expect(next).toContain('Review the repository.');
  });

  it('rejects stale writes instead of overwriting an external edit', async () => {
    const root = await tempRoot();
    const filePath = path.join(root, 'loop.md');
    await writeFile(filePath, validLoop());
    const current = await readLoopFile(filePath);
    await writeFile(filePath, validLoop({ name: 'changed' }));
    await expect(writeLoopFile(filePath, validLoop({ name: 'mine' }), {
      expectedRevision: current.revision,
    })).rejects.toBeInstanceOf(LoopRevisionConflictError);
  });
});
