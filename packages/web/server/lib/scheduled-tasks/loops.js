import crypto from 'node:crypto';
import fsPromisesDefault from 'node:fs/promises';
import osDefault from 'node:os';
import pathDefault from 'node:path';
import YAML from 'yaml';
import parser from 'cron-parser';
import { IANAZone } from 'luxon';
import { resolveWorktreeTopLevel } from '../git/service.js';

const LOOP_DIRECTORY = 'loops';
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const splitProviderModel = (value) => {
  const raw = asNonEmptyString(value);
  const separator = raw?.indexOf('/') ?? -1;
  if (!raw || separator <= 0 || separator === raw.length - 1) return null;
  const providerID = raw.slice(0, separator).trim();
  const modelID = raw.slice(separator + 1).trim();
  return providerID && modelID ? { providerID, modelID } : null;
};

const bestEffortFrontmatterName = (raw) => {
  const match = String(raw || '').match(/^\s*name\s*:\s*(.+?)\s*$/m);
  if (!match) return null;
  const value = match[1].trim();
  if (!value || value === '|' || value === '>') return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return asNonEmptyString(value.slice(1, -1));
  }
  return asNonEmptyString(value.replace(/\s+#.*$/, ''));
};

const splitMarkdown = (content) => {
  const raw = typeof content === 'string' ? content : '';
  const bom = raw.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
  const normalized = bom ? raw.slice(1) : raw;
  const match = normalized.match(/^---(\r?\n)([\s\S]*?)(\r?\n)---((?:\r?\n)?)([\s\S]*)$/);
  if (!match) {
    return { error: 'Loop file must start with YAML frontmatter', name: null };
  }
  return {
    bom,
    bodyRaw: match[5],
    eol: match[1],
    frontmatterRaw: match[2],
    separator: match[4],
  };
};

const parseFrontmatter = (raw) => {
  const document = YAML.parseDocument(raw, { keepSourceTokens: true });
  if (document.errors.length > 0) {
    throw document.errors[0];
  }
  const value = document.toJS();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Loop frontmatter must be a YAML object');
  }
  return { document, value };
};

export const parseLoopContent = (content) => {
  const parts = splitMarkdown(content);
  if (parts.error) return { definition: null, error: parts.error, name: null };

  let frontmatter;
  try {
    frontmatter = parseFrontmatter(parts.frontmatterRaw).value;
  } catch (error) {
    return {
      definition: null,
      error: error instanceof Error ? error.message : 'Invalid YAML frontmatter',
      name: bestEffortFrontmatterName(parts.frontmatterRaw),
    };
  }

  const name = asNonEmptyString(frontmatter.name);
  if (!name) return { definition: null, error: 'Frontmatter "name" is required', name: null };

  const cron = asNonEmptyString(frontmatter.schedule);
  if (!cron) return { definition: null, error: 'Frontmatter "schedule" is required', name };

  const prompt = asNonEmptyString(parts.bodyRaw);
  if (!prompt) return { definition: null, error: 'The markdown body is required', name };

  const model = splitProviderModel(frontmatter.model);
  if (!model) {
    return { definition: null, error: 'Frontmatter "model" must be "provider/model"', name };
  }

  if (frontmatter.enabled !== undefined && typeof frontmatter.enabled !== 'boolean') {
    return { definition: null, error: 'Frontmatter "enabled" must be a boolean', name };
  }

  const timezone = frontmatter.timezone === undefined ? null : asNonEmptyString(frontmatter.timezone);
  if (frontmatter.timezone !== undefined && !timezone) {
    return { definition: null, error: 'Frontmatter "timezone" must be a non-empty string', name };
  }
  if (timezone && !IANAZone.isValidZone(timezone)) {
    return { definition: null, error: 'Frontmatter "timezone" must be a valid IANA timezone', name };
  }
  try {
    parser.parseExpression(cron, { ...(timezone ? { tz: timezone } : {}), currentDate: new Date() }).next();
  } catch {
    return { definition: null, error: 'Frontmatter "schedule" must be a valid cron expression', name };
  }

  const agent = frontmatter.agent === undefined ? null : asNonEmptyString(frontmatter.agent);
  if (frontmatter.agent !== undefined && !agent) {
    return { definition: null, error: 'Frontmatter "agent" must be a non-empty string', name };
  }

  const thinking = frontmatter.thinking === undefined ? null : asNonEmptyString(frontmatter.thinking);
  if (thinking && !THINKING_LEVELS.has(thinking)) {
    return { definition: null, error: 'Frontmatter "thinking" is not supported by Pi', name };
  }
  if (frontmatter.thinking !== undefined && !thinking) {
    return { definition: null, error: 'Frontmatter "thinking" must be a non-empty string', name };
  }

  const runAsGoal = frontmatter.run_as_goal === true;
  if (frontmatter.run_as_goal !== undefined && typeof frontmatter.run_as_goal !== 'boolean') {
    return { definition: null, error: 'Frontmatter "run_as_goal" must be a boolean', name };
  }

  const goalTokenBudget = frontmatter.goal_token_budget;
  if (goalTokenBudget !== undefined) {
    if (!runAsGoal) {
      return { definition: null, error: 'Frontmatter "goal_token_budget" requires "run_as_goal: true"', name };
    }
    if (!Number.isSafeInteger(goalTokenBudget) || goalTokenBudget <= 0) {
      return { definition: null, error: 'Frontmatter "goal_token_budget" must be a positive integer', name };
    }
  }

  return {
    definition: {
      enabled: frontmatter.enabled === true,
      execution: {
        modelID: model.modelID,
        prompt,
        providerID: model.providerID,
        ...(agent ? { agent } : {}),
        ...(goalTokenBudget !== undefined ? { goalTokenBudget } : {}),
        ...(runAsGoal ? { runAsGoal: true } : {}),
        ...(thinking ? { thinkingLevel: thinking } : {}),
      },
      name,
      schedule: {
        cron,
        kind: 'cron',
        ...(timezone ? { timezone } : {}),
      },
    },
    error: null,
    name,
  };
};

export const loopContentRevision = (content) => (
  crypto.createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex')
);

export const readLoopFile = async (filePath, { fsPromises = fsPromisesDefault } = {}) => {
  const content = await fsPromises.readFile(filePath, 'utf8');
  return { content, revision: loopContentRevision(content) };
};

export class LoopRevisionConflictError extends Error {
  constructor() {
    super('Loop file changed since it was opened');
    this.name = 'LoopRevisionConflictError';
  }
}

export const writeLoopFile = async (
  filePath,
  content,
  { expectedRevision, fsPromises = fsPromisesDefault, path = pathDefault } = {},
) => {
  const current = await readLoopFile(filePath, { fsPromises });
  if (expectedRevision && current.revision !== expectedRevision) {
    throw new LoopRevisionConflictError();
  }

  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  await fsPromises.writeFile(temporaryPath, content, 'utf8');
  try {
    const latest = await readLoopFile(filePath, { fsPromises });
    if (latest.revision !== current.revision) {
      throw new LoopRevisionConflictError();
    }
    try {
      await fsPromises.rename(temporaryPath, filePath);
    } catch (error) {
      const code = error?.code;
      const windowsReplaceFailure = process.platform === 'win32'
        && (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' || code === 'EEXIST');
      if (!windowsReplaceFailure) throw error;
      // Windows may deny replacing an open file even after the revision check.
      // Copying the fully written temp file avoids truncating the target first.
      await fsPromises.copyFile(temporaryPath, filePath);
      await fsPromises.unlink(temporaryPath).catch(() => {});
    }
  } catch (error) {
    await fsPromises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return { content, path: path.resolve(filePath), revision: loopContentRevision(content) };
};

export const setLoopFileEnabled = async (
  filePath,
  enabled,
  { expectedRevision, fsPromises = fsPromisesDefault, path = pathDefault } = {},
) => {
  const current = await readLoopFile(filePath, { fsPromises });
  const parsed = parseLoopContent(current.content);
  if (!parsed.definition) throw new Error(parsed.error || 'Loop file is invalid');

  const parts = splitMarkdown(current.content);
  const { document } = parseFrontmatter(parts.frontmatterRaw);
  document.set('enabled', Boolean(enabled));
  const nextFrontmatter = document.toString({ lineWidth: 0 }).replace(/\r?\n$/, '').replace(/\r?\n/g, parts.eol);
  const nextContent = `${parts.bom}---${parts.eol}${nextFrontmatter}${parts.eol}---${parts.separator}${parts.bodyRaw}`;
  return writeLoopFile(filePath, nextContent, {
    expectedRevision: expectedRevision || current.revision,
    fsPromises,
    path,
  });
};

const walkLoopFiles = async (directory, { fsPromises, path }) => {
  let entries;
  try {
    entries = await fsPromises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(files.map(async (filePath) => fsPromises.realpath(filePath).catch(() => path.resolve(filePath))));
};

const ancestorDirectories = (startDirectory, stopDirectory, path) => {
  const start = path.resolve(startDirectory);
  const stop = path.resolve(stopDirectory || startDirectory);
  const relative = path.relative(stop, start);
  const boundedStop = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) ? stop : start;
  const result = [];
  let current = start;
  while (true) {
    result.push(current);
    if (current === boundedStop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
};

export const discoverLoopFiles = async (
  projectPath,
  {
    fsPromises = fsPromisesDefault,
    homeDirectory = osDefault.homedir(),
    path = pathDefault,
    resolveWorktreeRoot = async (directory) => (await resolveWorktreeTopLevel(directory)).root,
  } = {},
) => {
  const files = [];
  if (projectPath) {
    const projectDirectory = await fsPromises.realpath(projectPath).catch(() => path.resolve(projectPath));
    const worktreeRoot = await resolveWorktreeRoot(projectDirectory).catch(() => projectDirectory);
    for (const ancestor of ancestorDirectories(projectDirectory, worktreeRoot || projectDirectory, path)) {
      for (const filePath of await walkLoopFiles(path.join(ancestor, '.agents', LOOP_DIRECTORY), { fsPromises, path })) {
        files.push({ filePath, scope: 'project' });
      }
    }
  }
  for (const filePath of await walkLoopFiles(path.join(homeDirectory, '.agents', LOOP_DIRECTORY), { fsPromises, path })) {
    files.push({ filePath, scope: 'user' });
  }
  return files;
};

export const discoverLoops = async (projectPath, options = {}) => {
  const fsPromises = options.fsPromises || fsPromisesDefault;
  const logger = options.logger || console;
  const loops = [];
  for (const entry of await discoverLoopFiles(projectPath, options)) {
    let content;
    try {
      content = await fsPromises.readFile(entry.filePath, 'utf8');
    } catch (error) {
      logger.warn?.(`[ScheduledTasks] failed to read loop ${entry.filePath}:`, error);
      loops.push({ ...entry, definition: null, error: 'Failed to read loop file', name: null });
      continue;
    }
    const parsed = parseLoopContent(content);
    if (!parsed.definition) {
      logger.warn?.(`[ScheduledTasks] ignored invalid loop ${entry.filePath}: ${parsed.error}`);
    }
    loops.push({
      ...entry,
      definition: parsed.definition,
      error: parsed.error,
      name: parsed.name,
      revision: loopContentRevision(content),
    });
  }
  return loops;
};
