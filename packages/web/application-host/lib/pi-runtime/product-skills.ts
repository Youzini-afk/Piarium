/**
 * Product skills (Stage S / D-309 S4): a small set of Piarium-authored Pi
 * skills seeded into the user-scope resource root (`<agentDir>/skills/`).
 *
 * These are product skills — they teach composition over the live settings
 * catalog and follow-up/experiment tools. They reference stable catalog ids
 * and action entries; current values, model lists, install state, and
 * credentials are always queried at run time, never copied here.
 *
 * Seeding semantics: a skill directory is product-managed only while its
 * SKILL.md still matches the hash this host last wrote (tracked in
 * `.piarium-managed`). Once the user edits the file it becomes theirs and is
 * never overwritten; deleting the directory removes the skill entirely.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface ProductSkill {
  /** Directory name under `<agentDir>/skills/` — also the resource id stem. */
  id: string;
  name: string;
  description: string;
  /** SKILL.md body (markdown after frontmatter). */
  body: string;
}

const MANAGED_MARKER = '.piarium-managed';

const PRODUCT_SKILLS: readonly ProductSkill[] = [
  {
    id: 'piarium-research-environment',
    name: 'piarium-research-environment',
    description:
      'Configure a research working environment in Piarium: model routing for research roles, ' +
      'retrieval sources, notifications, and durable experiments. Use when asked to prepare ' +
      'or audit a research workspace setup.',
    body: `# Configure a research working environment

This skill composes existing Piarium settings and tools. It never stores
current values — always query the live catalog first.

## Method

1. **Inventory the current state** — \`settings_search\` with queries like
   \`models\`, \`retrieval\`, \`notifications\`. Read the entries that matter
   with \`settings_read\` to get saved vs effective values and the CAS
   revision before writing.
2. **Model routing** — research roles live under pi-settings model slots
   (e.g. \`harness.models.*\`). Write them through \`settings_update\` with
   \`expectedRevision\` from the read. Provider login/model discovery is a
   domain action: \`settings_action\` on the \`providers.*\` entries — never
   write credentials as settings.
3. **Retrieval** — web search domains and local semantic retrieval are
   ordinary settings; remote/cluster execution is an action on
   \`resources.*\` / \`remote.*\` entries.
4. **Experiments** — prefer durable \`experiment\` runs over ad-hoc shell
   loops; register \`follow_up\` waits instead of polling.
5. **Verify** — re-read the changed entries and report what is effective
   vs pending (\`appliedAt: next-run\` means a future run picks it up).

## Judgment

- Never invent a provider, model id, or endpoint — discover through
  \`settings_action\` verbs like \`list\`/\`status\`.
- A \`pending\` or \`unavailable\` result is a fact to report, not a failure
  to work around by writing files.
`,
  },
  {
    id: 'piarium-multi-agent-models',
    name: 'piarium-multi-agent-models',
    description:
      'Configure multi-agent model division of labour: per-role model slots, ' +
      'provider credentials state, fallback order, and thread dispatch readiness. ' +
      'Use when assigning models to main/explore/execute roles or preparing a team.',
    body: `# Configure multi-agent model roles

Model slots are pi-settings owned per scope; providers and credentials are
domain actions. Compose, never duplicate authority.

## Method

1. Read \`settings_read\` on the \`harness.models.*\` entries for the caller's
   scope to see the current slot map and revision.
2. Check provider readiness with \`settings_action\` on \`providers.*\`
   (\`status\`/\`list\` verbs) — a slot pointing at a logged-out provider is a
   real finding to report, not to fix silently.
3. The catalog's model groups share the single \`harness.models\` owner path.
   Merge every intended role into one complete object, then write it through
   one catalog item with the scope revision. Do not send several compound
   items for the same path.
4. For team runs, thread dispatch inherits the run's frozen launch
   configuration — changing slots mid-run applies to the next run.

## Judgment

- Cost and latency differ per role: retrieval/explore slots tolerate cheaper
  models; the executing role should match the task's difficulty.
- If a provider is unavailable the entry's action state says so — surface it
  instead of configuring around a dead provider.
`,
  },
  {
    id: 'piarium-retrieval-setup',
    name: 'piarium-retrieval-setup',
    description:
      'Configure web retrieval and local/remote semantic retrieval in Piarium: ' +
      'domain allowlists, search providers, local semantic components, and ' +
      'language-support structure. Use when setting up evidence-gathering for agents.',
    body: `# Configure retrieval (web + semantic)

Retrieval spans ordinary settings (domain policy) and domain actions
(language support, runtime components). Treat each through its owner.

## Method

1. \`settings_search\` for \`web\`, \`domains\`, \`search\`, \`language\`.
2. Domain allow/block lists are settings — read then update with CAS.
3. Language/semantic components are actions on \`language.*\` /
   \`runtime.*\` entries: \`status\` first, then \`prepare\`/\`install\` —
   these are long operations that return operation handles; poll the
   operation rather than re-invoking.
4. External MCP search providers are configured through \`mcp.*\` action
   entries (config documents) plus \`mcp.runtime\` status/reconnect.

## Judgment

- A partially prepared language server is real state — report
  \`pending\`/\`unavailable\` honestly instead of retrying blindly.
- Web fetch/search tool availability is a harness capability fact; check
  the tool list instead of assuming.
`,
  },
  {
    id: 'piarium-remote-experiments',
    name: 'piarium-remote-experiments',
    description:
      'Configure remote/managed experiment execution in Piarium: machine ' +
      'registration, capacity, remote targets, and follow-up waits on remote ' +
      'jobs. Use when preparing cluster or remote-host experiment runs.',
    body: `# Configure remote experiment execution

Remote execution has real owners: machine registration, resource
commitments, and durable follow-ups on remote jobs.

## Method

1. Inventory capacity with the \`resources\` tool — machines, commitments,
   queued attempts are live facts.
2. Register or inspect remote targets through \`settings_action\` on the
   \`remote.*\` / \`service:fleet\` entries — connection state is owner truth,
   and an unreachable target is \`unavailable\`, never simulated.
3. Submit work with the \`experiment\` tool on the appropriate backend;
   durable attempts get stable identities you can reattach to.
4. Wait on outcomes with \`follow_up\` on the attempt — a host disconnect is
   not a job failure; reconnection reattaches to real state.

## Judgment

- Credentials for remote targets never appear in settings or tool output;
  check \`isSet\`/connection status only.
- Local shell processes do not survive host restarts — only durable
  experiment/remote jobs may be reattached.
`,
  },
];

const contentHash = (body: string): string =>
  createHash('sha256').update(body, 'utf8').digest('hex');

const renderSkillMd = (skill: ProductSkill): string =>
  `---\nname: ${skill.name}\ndescription: "${skill.description.replace(/"/g, "'")}"\n---\n\n${skill.body}`;

export interface ProductSkillSeedResult {
  seeded: string[];
  updated: string[];
  userOwned: string[];
}

/**
 * Seed product skills into `<agentDir>/skills/`. Idempotent: writes only when
 * the target is absent or still matches the hash this host previously wrote.
 */
export const seedProductSkills = (agentDir: string): ProductSkillSeedResult => {
  const skillsRoot = path.join(agentDir, 'skills');
  const result: ProductSkillSeedResult = { seeded: [], updated: [], userOwned: [] };
  for (const skill of PRODUCT_SKILLS) {
    const dir = path.join(skillsRoot, skill.id);
    const file = path.join(dir, 'SKILL.md');
    const marker = path.join(dir, MANAGED_MARKER);
    const content = renderSkillMd(skill);
    const hash = contentHash(content);
    try {
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      const markerHash = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null;
      if (existing === null) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, content, 'utf8');
        fs.writeFileSync(marker, hash, 'utf8');
        result.seeded.push(skill.id);
        continue;
      }
      if (markerHash === contentHash(existing)) {
        // Still product-owned — apply the new revision.
        fs.writeFileSync(file, content, 'utf8');
        fs.writeFileSync(marker, hash, 'utf8');
        if (existing !== content) result.updated.push(skill.id);
        continue;
      }
      // No marker or diverged content — the user owns this directory now.
      result.userOwned.push(skill.id);
    } catch {
      // A read-only or missing agent dir leaves skills unseeded; sessions
      // simply don't see them. Never block host startup on seeding.
    }
  }
  return result;
};

export const listProductSkillIds = (): readonly string[] => PRODUCT_SKILLS.map((s) => s.id);
