import path from 'node:path';
import type { RuntimeMethodResult } from '@piarium/protocol';
import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import { resolveTargetPort } from './cli-api-target.js';
import { parseGoalTokenBudget } from './cli-goal.js';
import {
  requestPiariumApi,
  requestRuntimeMethod,
  waitForSessionIdle,
} from './cli-runtime.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  printJson,
  logStatus,
} from '../cli-output.js';
import { recordOf, type CliOptions } from './cli-types.js';

const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];
const isPiThinkingLevel = (value: unknown): value is PiThinkingLevel => (
  typeof value === 'string' && (PI_THINKING_LEVELS as readonly string[]).includes(value)
);

type SessionSnapshot = RuntimeMethodResult<'session.snapshot'>;
type MessageRole = 'all' | 'assistant' | 'user';

interface TextMessage {
  createdAt: number | null;
  id: string;
  model: string | null;
  role: 'assistant' | 'user';
  text: string;
}

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const validateModel = (model: unknown): string | null => {
  const normalized = asNonEmptyString(model);
  if (!normalized) return null;
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
    throw new TunnelCliError('--model must be in provider/model format.', EXIT_CODE.USAGE_ERROR);
  }
  return normalized;
};

const splitModel = (model: unknown): { modelId: string; provider: string } | null => {
  const normalized = validateModel(model);
  if (!normalized) return null;
  const slashIndex = normalized.indexOf('/');
  return { provider: normalized.slice(0, slashIndex), modelId: normalized.slice(slashIndex + 1) };
};

const normalizeLimit = (value: unknown, fallback = 10): number => {
  if (value === undefined || value === null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TunnelCliError('Invalid limit value. Provide a positive integer.', EXIT_CODE.USAGE_ERROR);
  }
  return parsed;
};

const assertSessionID = (options: CliOptions = {}): string => {
  const sessionId = asNonEmptyString(options.session);
  if (!sessionId) throw new TunnelCliError('Missing required --session.', EXIT_CODE.USAGE_ERROR);
  return sessionId;
};

const normalizeMessageRole = (value: unknown): MessageRole => {
  const role = asNonEmptyString(value) || 'all';
  if (role === 'all' || role === 'user' || role === 'assistant') return role;
  throw new TunnelCliError('--role must be one of: all, user, assistant.', EXIT_CODE.USAGE_ERROR);
};

const messageText = (content: unknown): string => {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map(recordOf)
    .filter((part): part is Record<string, unknown> & { text: string; type: 'text' } => (
      part.type === 'text' && typeof part.text === 'string'
    ))
    .map((part) => part.text)
    .join('')
    .trim();
};

const extractTextMessages = (entries: unknown, role: MessageRole = 'all'): TextMessage[] => {
  const result: TextMessage[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const entryRecord = recordOf(entry);
    const message = entryRecord.type === 'message' ? recordOf(entryRecord.message) : null;
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const messageRole = message.role;
    if (role !== 'all' && role !== messageRole) continue;
    const text = messageText(message.content);
    if (!text) continue;
    const createdAt = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
      ? message.timestamp
      : Date.parse(String(entryRecord.timestamp ?? ''));
    result.push({
      id: asNonEmptyString(entryRecord.id) || '',
      role: messageRole,
      createdAt: Number.isFinite(createdAt) ? createdAt : null,
      model: message.role === 'assistant' && asNonEmptyString(message.provider) && asNonEmptyString(message.model)
        ? `${message.provider}/${message.model}`
        : null,
      text,
    });
  }
  return result.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
};

const formatTextMessage = (message: TextMessage): string => {
  const label = message.role === 'user' ? 'User' : 'Assistant';
  const timestamp = message.createdAt ? new Date(message.createdAt).toISOString() : '';
  const details = [timestamp, message.model].filter(Boolean).join(' ');
  return `**${label}**${details ? `\n\n*${details}*` : ''}\n\n${message.text}`;
};

const formatSessionModel = (session: unknown): string | null => {
  const model = recordOf(recordOf(session).model);
  const providerID = asNonEmptyString(model.provider) || asNonEmptyString(model.providerID) || asNonEmptyString(model.providerId);
  const modelID = asNonEmptyString(model.id) || asNonEmptyString(model.modelID) || asNonEmptyString(model.modelId);
  return providerID && modelID ? `${providerID}/${modelID}` : null;
};

const sessionStatus = (snapshot: SessionSnapshot): { attempt?: number; type: 'busy' | 'idle' | 'retry' } => {
  if ((snapshot?.retryAttempt || 0) > 0) return { type: 'retry', attempt: snapshot.retryAttempt };
  if (snapshot?.busy || snapshot?.isStreaming || snapshot?.isCompacting) return { type: 'busy' };
  return { type: 'idle' };
};

const formatSessionLine = (session: unknown): string => {
  const value = recordOf(session);
  const title = asNonEmptyString(value.name) || asNonEmptyString(value.title) || asNonEmptyString(value.id) || 'untitled';
  const model = formatSessionModel(session);
  const directory = asNonEmptyString(value.cwd) || asNonEmptyString(value.directory) || 'unknown-directory';
  const details: string[] = [];
  if (model) details.push(`\`${model}\``);
  if (typeof value.messageCount === 'number' && Number.isFinite(value.messageCount)) details.push(`${value.messageCount} message(s)`);
  const status = asNonEmptyString(recordOf(value.status).type);
  if (status) details.push(`status:${status}`);
  return `- \`${title}\`${details.length > 0 ? ` — ${details.join(', ')}` : ''} — \`${directory}\``;
};

const buildSessionCreatePayload = (options: CliOptions = {}) => {
  const directory = asNonEmptyString(options.directory);
  const projectId = asNonEmptyString(options.project);
  if (!directory && !projectId) {
    throw new TunnelCliError('Missing required --dir or --project.', EXIT_CODE.USAGE_ERROR);
  }
  if (directory && projectId) {
    throw new TunnelCliError('Provide only one of --dir or --project.', EXIT_CODE.USAGE_ERROR);
  }

  const prompt = asNonEmptyString(options.prompt);
  const model = validateModel(options.model);
  const goalEnabled = options.goal === true;
  const goalTokenBudget = parseGoalTokenBudget(options);
  if (goalEnabled && !prompt) throw new TunnelCliError('--goal requires --prompt.', EXIT_CODE.USAGE_ERROR);

  const title = asNonEmptyString(options.title) || asNonEmptyString(options.name);
  const agent = asNonEmptyString(options.agent);
  const thinkingLevel = asNonEmptyString(options.thinking) || asNonEmptyString(options.variant);
  const worktree = asNonEmptyString(options.worktree);
  const branch = asNonEmptyString(options.branch);
  const startRef = asNonEmptyString(options.startRef);

  return {
    ...(directory ? { directory } : {}),
    ...(projectId ? { projectId } : {}),
    ...(title ? { title } : {}),
    ...(worktree ? { worktree: { name: worktree, ...(branch ? { branchName: branch } : {}), ...(startRef ? { startRef } : {}) } } : {}),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(goalEnabled ? { goal: true } : {}),
    ...(goalTokenBudget !== undefined ? { goalTokenBudget } : {}),
    ...(typeof options.setUpstream === 'boolean' ? { setUpstream: options.setUpstream } : {}),
  };
};

const buildSessionPromptPayload = (options: CliOptions = {}, action: string) => {
  const prompt = asNonEmptyString(options.prompt);
  if (!prompt) throw new TunnelCliError('Missing required --prompt.', EXIT_CODE.USAGE_ERROR);
  const model = validateModel(options.model);
  const agent = asNonEmptyString(options.agent);
  const thinkingLevel = asNonEmptyString(options.thinking) || asNonEmptyString(options.variant);
  const messageId = asNonEmptyString(options.message);
  if (messageId && action !== 'fork') {
    throw new TunnelCliError('--message is only valid for session fork.', EXIT_CODE.USAGE_ERROR);
  }
  const goalEnabled = options.goal === true;
  const goalTokenBudget = parseGoalTokenBudget(options);
  return {
    prompt,
    ...(messageId ? { messageId } : {}),
    ...(model ? { model } : {}),
    ...(agent ? { agent } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(goalEnabled ? { goal: true } : {}),
    ...(goalTokenBudget !== undefined ? { goalTokenBudget } : {}),
  };
};

const validateActionWaitOptions = (options: CliOptions, action: string): void => {
  if (options.timeout !== undefined && !options.wait) {
    throw new TunnelCliError('--timeout requires --wait.', EXIT_CODE.USAGE_ERROR);
  }
  if (options.lastAssistant && !options.wait) {
    throw new TunnelCliError(`--last-assistant requires --wait for session ${action}.`, EXIT_CODE.USAGE_ERROR);
  }
};

type SessionCreatePayload = ReturnType<typeof buildSessionCreatePayload>;
type SessionPromptPayload = ReturnType<typeof buildSessionPromptPayload>;
type PromptPayload = SessionCreatePayload | SessionPromptPayload;

const resolveSessionDirectory = async (
  port: number,
  payload: SessionCreatePayload,
  options: CliOptions,
): Promise<string> => {
  if (payload.directory) return path.resolve(payload.directory);
  const settings = await requestPiariumApi(port, '/api/config/settings', options);
  const project = (Array.isArray(settings?.projects) ? settings.projects : [])
    .map(recordOf)
    .find((entry) => entry.id === payload.projectId);
  const projectPath = asNonEmptyString(project?.path);
  if (!projectPath) {
    throw new TunnelCliError(`Piarium project not found: ${payload.projectId}`, EXIT_CODE.USAGE_ERROR);
  }
  return path.resolve(projectPath);
};

const createWorktree = async (
  port: number,
  directory: string,
  worktree: SessionCreatePayload['worktree'],
  setUpstream: boolean | undefined,
  options: CliOptions,
) => {
  if (!worktree) return { directory, worktree: null };
  // Worktree creation runs Git plus repository bootstrap and can legitimately
  // exceed the four-second default used by instant CLI API calls. The server
  // cannot cancel that filesystem mutation when the HTTP client gives up, so
  // use a window that lets this explicit operation report its real outcome.
  const WORKTREE_CREATION_TIMEOUT_MS = 120_000;
  const body = await requestPiariumApi(
    port,
    `/api/git/worktrees?directory=${encodeURIComponent(directory)}`,
    {
      ...options,
      timeoutMs: typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : WORKTREE_CREATION_TIMEOUT_MS,
      method: 'POST',
      body: JSON.stringify({
        mode: 'new',
        worktreeName: worktree.name,
        branchName: worktree.branchName || worktree.name,
        ...(worktree.startRef ? { startRef: worktree.startRef } : {}),
        ...(typeof setUpstream === 'boolean' ? { setUpstream } : {}),
      }),
    },
  );
  const worktreePath = asNonEmptyString(body.path);
  if (!worktreePath) {
    throw new TunnelCliError('Piarium did not return the created worktree path.', EXIT_CODE.GENERAL_ERROR);
  }
  return { directory: path.resolve(worktreePath), worktree: body };
};

const selectModelAndThinking = async (
  port: number,
  sessionId: string,
  payload: PromptPayload,
  options: CliOptions,
): Promise<void> => {
  const model = splitModel(payload.model);
  if (model) await requestRuntimeMethod(port, 'model.select', { ...model, sessionId }, options);
  if (payload.thinkingLevel) {
    if (!isPiThinkingLevel(payload.thinkingLevel)) {
      throw new TunnelCliError(
        `--thinking must be one of: ${PI_THINKING_LEVELS.join(', ')}.`,
        EXIT_CODE.USAGE_ERROR,
      );
    }
    await requestRuntimeMethod(port, 'thinking.select', { level: payload.thinkingLevel, sessionId }, options);
  }
};

const buildPromptInstructions = (payload: PromptPayload): string | undefined => {
  const lines: string[] = [];
  if (payload.agent) lines.push(`Use the Pi agent role or profile named "${payload.agent}" for this turn when it is available.`);
  if (payload.goal) {
    lines.push('Treat this prompt as an end-to-end goal. Continue using tools until the requested outcome is complete and verify the result before finishing.');
    if (payload.goalTokenBudget !== undefined) lines.push(`The requested goal token budget is ${payload.goalTokenBudget}.`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
};

const dispatchPrompt = async (
  port: number,
  sessionId: string,
  payload: PromptPayload,
  options: CliOptions,
): Promise<{ dispatchedAsCommand: boolean; promptDispatched: boolean }> => {
  if (!payload.prompt) return { dispatchedAsCommand: false, promptDispatched: false };
  if (payload.prompt.startsWith('/')) {
    await requestRuntimeMethod(port, 'command.execute', { command: payload.prompt, sessionId }, options);
    return { dispatchedAsCommand: true, promptDispatched: true };
  }
  const instructions = buildPromptInstructions(payload);
  const result = await requestRuntimeMethod(port, 'agent.prompt', {
    sessionId,
    text: payload.prompt,
    ...(instructions ? { instructions } : {}),
  }, options);
  if (result?.accepted !== true) {
    throw new TunnelCliError('Pi did not accept the prompt.', EXIT_CODE.GENERAL_ERROR);
  }
  return { dispatchedAsCommand: false, promptDispatched: true };
};

const readMessages = async (
  port: number,
  sessionId: string,
  role: MessageRole,
  options: CliOptions,
): Promise<TextMessage[]> => {
  const result = await requestRuntimeMethod(port, 'session.entries', { sessionId, scope: 'all' }, options);
  return extractTextMessages(result?.entries, role);
};

const maybeWait = async (port: number, sessionId: string, options: CliOptions): Promise<SessionSnapshot> => (
  options.wait ? waitForSessionIdle(port, sessionId, options) : requestRuntimeMethod(port, 'session.snapshot', { sessionId }, options)
);

const lastAssistantMessage = async (port: number, sessionId: string, options: CliOptions): Promise<TextMessage | null> => {
  const messages = await readMessages(port, sessionId, 'assistant', options);
  return messages.at(-1) || null;
};

async function sessionCommand(options: CliOptions = {}, action = 'help'): Promise<void> {
  if (action === 'help') {
    process.stdout.write(`Piarium Session Commands\n\nUSAGE:\n  piarium session list [--dir <path>] [--limit <count>] [--with-status] [OPTIONS]\n  piarium session create (--dir <path> | --project <projectId>) [--title <title>] [--wait] [OPTIONS]\n  piarium session send --session <id> --prompt <text> [--wait] [OPTIONS]\n  piarium session fork --session <id> --prompt <text> [--message <entryId>] [--wait] [OPTIONS]\n  piarium session status --session <id> [OPTIONS]\n  piarium session messages --session <id> [--wait] [OPTIONS]\n\nLIST OPTIONS:\n  --dir <path>            Filter sessions by directory\n  --limit <count>         Maximum sessions to show (default: 10)\n  --all                   Include archived sessions\n  --with-status           Include authoritative idle/busy/retry status\n\nACTION OPTIONS:\n  --session <id>          Source or target Pi session id\n  --prompt <text>         Prompt or slash command to run\n  --message <entryId>     Fork before this Pi session entry (fork only; default: current leaf)\n  --model <provider/model>  Model for the prompt\n  --thinking <level>      Pi thinking level: off, minimal, low, medium, high, xhigh, max\n  --agent <id>            Pi agent role/profile instruction for the turn\n  --goal                  Treat the prompt as an end-to-end goal\n  --goal-token-budget <n> Goal token budget (1000-100000000; requires --goal)\n  --wait                  Wait until the Pi session becomes idle\n  --last-assistant        Include the last assistant text after waiting\n  --timeout <seconds>     Wait timeout in seconds (default: 600)\n\nCREATE OPTIONS:\n  --worktree <name>       Create a git worktree before creating the Pi session\n  --branch <name>         Branch name for --worktree\n  --start-ref, --base <ref>  Start ref for --worktree\n  --upstream              Set upstream for the worktree branch\n  --no-upstream           Do not set upstream for the worktree branch\n  --name <title>          Alias for --title\n\nMESSAGES OPTIONS:\n  --last                  Return only the latest text-bearing message\n  --last-assistant        Shorthand for --last --role assistant\n  --limit <count>         Maximum text messages to return (default: 10)\n  --all                   Return all text-bearing messages\n  --role <role>           Filter messages: all, user, assistant\n\nOUTPUT OPTIONS:\n  -p, --port <port>       Piarium server port\n  --json                  Output machine-readable JSON\n  -q, --quiet             Print compact output\n`);
    return;
  }

  if (action === 'list') {
    const limit = normalizeLimit(options.limit);
    const port = await resolveTargetPort(options);
    const directory = asNonEmptyString(options.directory);
    let sessions = await requestRuntimeMethod(port, 'session.list', {
      ...(directory ? { cwd: path.resolve(directory) } : {}),
    }, options);
    sessions = Array.isArray(sessions) ? sessions : [];
    if (options.all !== true) sessions = sessions.filter((session) => !session?.archivedAt);
    sessions = sessions.slice(0, limit);
    if (options.withStatus) {
      sessions = await Promise.all(sessions.map(async (session) => {
        try {
          const snapshot = await requestRuntimeMethod(port, 'session.snapshot', { sessionId: session.id }, options);
          return { ...session, model: snapshot?.model, status: sessionStatus(snapshot) };
        } catch {
          return { ...session, status: { type: 'unknown' } };
        }
      }));
    }
    const body = { sessions, limit, ...(directory ? { directory: path.resolve(directory) } : {}), archived: options.all === true ? 'included' : 'excluded' };
    if (isJsonMode(options)) return printJson(body);
    process.stdout.write(sessions.length > 0 ? `${sessions.map(formatSessionLine).join('\n')}\n` : 'No sessions found.\n');
    return;
  }

  if (action === 'status') {
    const sessionId = assertSessionID(options);
    const port = await resolveTargetPort(options);
    const snapshot = await requestRuntimeMethod(port, 'session.snapshot', { sessionId }, options);
    const status = sessionStatus(snapshot);
    const result = { sessionId, directory: snapshot.cwd, sessionStatus: status, snapshot };
    if (isJsonMode(options)) return printJson(result);
    if (isQuietMode(options)) {
      process.stdout.write(`${status.type}\n`);
      return;
    }
    process.stdout.write(`${sessionId} status:${status.type} directory:${snapshot.cwd}\n`);
    return;
  }

  if (action === 'messages') {
    const sessionId = assertSessionID(options);
    if (options.timeout !== undefined && !options.wait) throw new TunnelCliError('--timeout requires --wait.', EXIT_CODE.USAGE_ERROR);
    if (options.lastAssistant && options.role && options.role !== 'assistant') {
      throw new TunnelCliError('--last-assistant cannot be combined with a non-assistant --role.', EXIT_CODE.USAGE_ERROR);
    }
    const role = options.lastAssistant ? 'assistant' : normalizeMessageRole(options.role);
    const last = options.last || options.lastAssistant;
    if (options.all && (last || options.limit !== undefined)) throw new TunnelCliError('--all cannot be combined with --last or --limit.', EXIT_CODE.USAGE_ERROR);
    if (last && options.limit !== undefined) throw new TunnelCliError('--last cannot be combined with --limit.', EXIT_CODE.USAGE_ERROR);
    const limit = options.all ? undefined : (last ? 1 : normalizeLimit(options.limit));
    const port = await resolveTargetPort(options);
    const snapshot = await maybeWait(port, sessionId, options);
    let messages = await readMessages(port, sessionId, role, options);
    if (limit !== undefined) messages = messages.slice(-limit);
    const result = { sessionId, directory: snapshot.cwd, role, sessionStatus: sessionStatus(snapshot), messages };
    if (isJsonMode(options)) return printJson(result);
    if (messages.length === 0) {
      process.stdout.write('No text messages found.\n');
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${messages.map((message) => message.text).join('\n\n')}\n`);
      return;
    }
    process.stdout.write(`${messages.map(formatTextMessage).join('\n\n---\n\n')}\n`);
    return;
  }

  if (action === 'send' || action === 'fork') {
    const sessionId = assertSessionID(options);
    const payload = buildSessionPromptPayload(options, action);
    validateActionWaitOptions(options, action);
    const port = await resolveTargetPort(options);
    let targetSnapshot = await requestRuntimeMethod(port, 'session.snapshot', { sessionId }, options);
    let targetSessionId = sessionId;
    if (action === 'fork') {
      const entryId = payload.messageId || targetSnapshot.leafId;
      if (!entryId) throw new TunnelCliError('Cannot fork an empty Pi session.', EXIT_CODE.USAGE_ERROR);
      const forked = await requestRuntimeMethod(port, 'session.fork', { entryId, position: 'before', sessionId }, options);
      if (forked?.cancelled) throw new TunnelCliError('Pi session fork was cancelled.', EXIT_CODE.GENERAL_ERROR);
      targetSnapshot = forked.snapshot;
      targetSessionId = targetSnapshot.sessionId;
    }
    await selectModelAndThinking(port, targetSessionId, payload, options);
    const dispatch = await dispatchPrompt(port, targetSessionId, payload, options);
    targetSnapshot = await maybeWait(port, targetSessionId, options);
    const assistant = options.lastAssistant ? await lastAssistantMessage(port, targetSessionId, options) : null;
    const result = {
      sessionId: targetSessionId,
      directory: targetSnapshot.cwd,
      ...dispatch,
      ...(payload.goal ? { goalEnabled: true } : {}),
      ...(payload.goalTokenBudget !== undefined ? { goalTokenBudget: payload.goalTokenBudget } : {}),
      sessionStatus: sessionStatus(targetSnapshot),
      ...(assistant ? { lastAssistantMessage: assistant } : {}),
    };
    if (isJsonMode(options)) return printJson(result);
    if (isQuietMode(options)) {
      process.stdout.write(`${targetSessionId}\n`);
      if (assistant?.text) process.stdout.write(`${assistant.text}\n`);
      return;
    }
    clackIntro(action === 'fork' ? 'Session Forked' : 'Session Prompt Sent');
    logStatus('success', targetSessionId, `directory: ${targetSnapshot.cwd}`);
    logStatus('info', dispatch.dispatchedAsCommand ? 'command dispatched' : 'prompt dispatched');
    if (payload.goal) logStatus('info', 'goal instructions applied', payload.goalTokenBudget ? `budget: ${payload.goalTokenBudget}` : undefined);
    logStatus('info', `session status: ${result.sessionStatus.type}`);
    clackOutro(action === 'fork' ? 'forked' : 'sent');
    if (assistant) process.stdout.write(`\n${formatTextMessage(assistant)}\n`);
    return;
  }

  if (action !== 'create') throw new TunnelCliError(`Unknown session command '${action}'.`, EXIT_CODE.USAGE_ERROR);

  const payload = buildSessionCreatePayload(options);
  validateActionWaitOptions(options, 'create');
  const port = await resolveTargetPort(options);
  const projectDirectory = await resolveSessionDirectory(port, payload, options);
  const worktreeResult = await createWorktree(port, projectDirectory, payload.worktree, payload.setUpstream, options);
  let snapshot;
  try {
    snapshot = await requestRuntimeMethod(port, 'session.create', {
      cwd: worktreeResult.directory,
      ...(payload.title ? { name: payload.title } : {}),
    }, options);
  } catch (error) {
    if (worktreeResult.worktree) {
      try {
        await requestPiariumApi(port, `/api/git/worktrees?directory=${encodeURIComponent(projectDirectory)}`, {
          ...options,
          method: 'DELETE',
          body: JSON.stringify({ directory: worktreeResult.directory, deleteLocalBranch: true }),
        });
      } catch {
    // Best-effort operation; continue when it is unavailable.
  }
    }
    throw error;
  }
  await selectModelAndThinking(port, snapshot.sessionId, payload, options);
  const dispatch = await dispatchPrompt(port, snapshot.sessionId, payload, options);
  snapshot = await maybeWait(port, snapshot.sessionId, options);
  const assistant = options.lastAssistant ? await lastAssistantMessage(port, snapshot.sessionId, options) : null;
  const result = {
    sessionId: snapshot.sessionId,
    directory: snapshot.cwd,
    ...(worktreeResult.worktree ? { worktree: worktreeResult.worktree } : {}),
    ...dispatch,
    ...(payload.goal ? { goalEnabled: true } : {}),
    ...(payload.goalTokenBudget !== undefined ? { goalTokenBudget: payload.goalTokenBudget } : {}),
    sessionStatus: sessionStatus(snapshot),
    ...(assistant ? { lastAssistantMessage: assistant } : {}),
  };
  if (isJsonMode(options)) return printJson(result);
  if (isQuietMode(options)) {
    process.stdout.write(`${snapshot.sessionId}\n`);
    if (assistant?.text) process.stdout.write(`${assistant.text}\n`);
    return;
  }
  clackIntro('Session Created');
  logStatus('success', snapshot.sessionId, `directory: ${snapshot.cwd}`);
  const createdWorktree = recordOf(worktreeResult.worktree);
  const createdWorktreePath = asNonEmptyString(createdWorktree.path);
  if (createdWorktreePath) {
    logStatus('info', `worktree: ${String(createdWorktree.branch || createdWorktree.name || 'created')}`, createdWorktreePath);
  }
  if (dispatch.promptDispatched) logStatus('info', dispatch.dispatchedAsCommand ? 'initial command dispatched' : 'initial prompt dispatched');
  if (payload.goal) logStatus('info', 'goal instructions applied', payload.goalTokenBudget ? `budget: ${payload.goalTokenBudget}` : undefined);
  logStatus('info', `session status: ${result.sessionStatus.type}`);
  clackOutro('created');
  if (assistant) process.stdout.write(`\n${formatTextMessage(assistant)}\n`);
}

export {
  sessionCommand,
  buildSessionCreatePayload,
  buildSessionPromptPayload,
  extractTextMessages,
  formatSessionLine,
};
