import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const defaultManifest = path.join(repoRoot, 'evaluation', 'harness', 'cases.json');
const variants = new Set(['native', 'harness-shadow']);
const failureCategories = new Set([
  'retrieval-miss',
  'lost-context',
  'wrong-edit',
  'permission-interruption',
  'tool-runtime-failure',
  'coordination-failure',
]);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export const loadReplayManifest = (file = defaultManifest) => readJson(file);

const commitExists = (root, commit) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const isAncestor = (root, base, reference) => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base, reference], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

export const validateReplayManifest = (manifest, root = repoRoot) => {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['manifest must be an object'];
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!Array.isArray(manifest.cases) || manifest.cases.length < 5 || manifest.cases.length > 8) {
    errors.push('cases must contain the designed 5–8 replay tasks');
    return errors;
  }
  const ids = new Set();
  for (const [index, candidate] of manifest.cases.entries()) {
    const label = `cases[${index}]`;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (typeof candidate.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.id)) errors.push(`${label}.id is invalid`);
    else if (ids.has(candidate.id)) errors.push(`${label}.id is duplicated`);
    else ids.add(candidate.id);
    for (const key of ['title', 'category', 'task']) {
      if (typeof candidate[key] !== 'string' || !candidate[key].trim()) errors.push(`${label}.${key} is required`);
    }
    for (const key of ['acceptance', 'suggestedChecks']) {
      if (!Array.isArray(candidate[key]) || candidate[key].length === 0 || !candidate[key].every((entry) => typeof entry === 'string' && entry.trim())) {
        errors.push(`${label}.${key} must be a non-empty string array`);
      }
    }
    for (const key of ['baseCommit', 'referenceCommit']) {
      if (typeof candidate[key] !== 'string' || !/^[0-9a-f]{40}$/.test(candidate[key])) errors.push(`${label}.${key} must be a full commit hash`);
      else if (!commitExists(root, candidate[key])) errors.push(`${label}.${key} does not resolve in this repository`);
    }
    if (
      typeof candidate.baseCommit === 'string'
      && typeof candidate.referenceCommit === 'string'
      && commitExists(root, candidate.baseCommit)
      && commitExists(root, candidate.referenceCommit)
      && !isAncestor(root, candidate.baseCommit, candidate.referenceCommit)
    ) errors.push(`${label}.baseCommit is not an ancestor of referenceCommit`);
  }
  return errors;
};

const parseArgs = (argv) => {
  const positional = [];
  const named = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) positional.push(value);
    else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${value} requires a value`);
      named[value.slice(2)] = next;
      index += 1;
    }
  }
  return { positional, named };
};

const required = (named, key) => {
  const value = named[key];
  if (!value) throw new Error(`--${key} is required`);
  return value;
};

const nonNegativeInteger = (named, key) => {
  const raw = required(named, key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${key} must be a non-negative integer`);
  return value;
};

const writeJsonAtomic = (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporary, file);
};

export const createReplayRun = ({ manifest, caseId, variant, model, pairId, output }) => {
  if (!variants.has(variant)) throw new Error(`Unknown variant: ${variant}`);
  if (typeof model !== 'string' || !model.trim()) throw new Error('model is required');
  if (typeof pairId !== 'string' || !pairId.trim()) throw new Error('pairId is required');
  const replayCase = manifest.cases.find((candidate) => candidate.id === caseId);
  if (!replayCase) throw new Error(`Unknown replay case: ${caseId}`);
  if (fs.existsSync(output)) throw new Error(`Output already exists: ${output}`);
  fs.mkdirSync(output, { recursive: true });
  const run = {
    schemaVersion: 1,
    caseId,
    variant,
    model,
    pairId,
    baseCommit: replayCase.baseCommit,
    prompt: replayCase.task,
    acceptance: replayCase.acceptance,
    status: 'prepared',
    preparedAt: new Date().toISOString(),
    result: null,
  };
  const file = path.join(output, 'run.json');
  writeJsonAtomic(file, run);
  return { file, run };
};

export const recordReplayRun = (file, input) => {
  const run = readJson(file);
  if (run.schemaVersion !== 1 || run.status !== 'prepared') throw new Error('Run is not a prepared v1 record');
  if (input.success !== 'pass' && input.success !== 'fail') throw new Error('--success must be pass or fail');
  if (input.success === 'fail' && !failureCategories.has(input.failureCategory)) {
    throw new Error('A failed run requires a known --failure-category');
  }
  const cacheReadTokens = input.cacheReadTokens ?? 0;
  const cacheWriteTokens = input.cacheWriteTokens ?? 0;
  for (const [name, value] of Object.entries({ inputTokens: input.inputTokens, outputTokens: input.outputTokens, cacheReadTokens, cacheWriteTokens, interventions: input.interventions })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  }
  const completed = {
    ...run,
    status: 'completed',
    completedAt: new Date().toISOString(),
    result: {
      success: input.success === 'pass',
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: input.inputTokens + input.outputTokens + cacheReadTokens + cacheWriteTokens,
      interventions: input.interventions,
      ...(input.success === 'fail' ? { failureCategory: input.failureCategory } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
    },
  };
  writeJsonAtomic(`${file}.next`, completed);
  fs.renameSync(`${file}.next`, file);
  return completed;
};

export const summarizeReplayRuns = (resultsRoot) => {
  if (!fs.existsSync(resultsRoot)) return [];
  const runs = fs.readdirSync(resultsRoot, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const file = path.join(resultsRoot, entry.name, 'run.json');
    if (!fs.existsSync(file)) return [];
    const run = readJson(file);
    return run.status === 'completed' && run.result ? [run] : [];
  });
  const grouped = new Map();
  for (const run of runs) {
    const key = `${run.caseId}\0${run.model}\0${run.pairId}`;
    const group = grouped.get(key) ?? { caseId: run.caseId, model: run.model, pairId: run.pairId, native: null, harnessShadow: null };
    if (run.variant === 'native') group.native = run.result;
    if (run.variant === 'harness-shadow') group.harnessShadow = run.result;
    grouped.set(key, group);
  }
  return [...grouped.values()].sort((left, right) => left.caseId.localeCompare(right.caseId) || left.model.localeCompare(right.model) || left.pairId.localeCompare(right.pairId));
};

const printCase = (candidate) => {
  process.stdout.write(`${candidate.title} (${candidate.id})\nbase: ${candidate.baseCommit}\n\n${candidate.task}\n\nAcceptance:\n${candidate.acceptance.map((item) => `- ${item}`).join('\n')}\n`);
};

const main = () => {
  const { positional, named } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? 'validate';
  const manifest = loadReplayManifest(named.manifest ? path.resolve(named.manifest) : defaultManifest);
  const errors = validateReplayManifest(manifest, repoRoot);
  if (errors.length > 0) throw new Error(`Replay manifest is invalid:\n- ${errors.join('\n- ')}`);
  if (command === 'validate') {
    process.stdout.write(`Harness replay manifest is valid: ${manifest.cases.length} cases\n`);
    return;
  }
  if (command === 'show') {
    const candidate = manifest.cases.find((entry) => entry.id === positional[1]);
    if (!candidate) throw new Error(`Unknown replay case: ${positional[1] ?? ''}`);
    printCase(candidate);
    return;
  }
  if (command === 'new-run') {
    const created = createReplayRun({
      manifest,
      caseId: required(named, 'case'),
      variant: required(named, 'variant'),
      model: required(named, 'model'),
      pairId: required(named, 'pair'),
      output: path.resolve(required(named, 'output')),
    });
    process.stdout.write(`Prepared ${created.file}\ncheckout: ${created.run.baseCommit}\n\n`);
    printCase(manifest.cases.find((entry) => entry.id === created.run.caseId));
    return;
  }
  if (command === 'record') {
    const file = path.resolve(required(named, 'run'));
    const completed = recordReplayRun(file, {
      success: required(named, 'success'),
      inputTokens: nonNegativeInteger(named, 'input-tokens'),
      outputTokens: nonNegativeInteger(named, 'output-tokens'),
      cacheReadTokens: named['cache-read-tokens'] === undefined ? 0 : nonNegativeInteger(named, 'cache-read-tokens'),
      cacheWriteTokens: named['cache-write-tokens'] === undefined ? 0 : nonNegativeInteger(named, 'cache-write-tokens'),
      interventions: nonNegativeInteger(named, 'interventions'),
      failureCategory: named['failure-category'],
      notes: named.notes,
    });
    process.stdout.write(`Recorded ${completed.caseId} ${completed.variant}: ${completed.result.success ? 'pass' : 'fail'}\n`);
    return;
  }
  if (command === 'summary') {
    const rows = summarizeReplayRuns(path.resolve(required(named, 'results')));
    process.stdout.write('| Case | Model | Pair | Native | Harness shadow | Token delta | Intervention delta |\n| --- | --- | --- | --- | --- | ---: | ---: |\n');
    for (const row of rows) {
      const native = row.native;
      const harness = row.harnessShadow;
      process.stdout.write(`| ${row.caseId} | ${row.model} | ${row.pairId} | ${native ? (native.success ? 'pass' : 'fail') : '—'} | ${harness ? (harness.success ? 'pass' : 'fail') : '—'} | ${native && harness ? harness.totalTokens - native.totalTokens : '—'} | ${native && harness ? harness.interventions - native.interventions : '—'} |\n`);
    }
    return;
  }
  throw new Error(`Unknown command: ${command}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
