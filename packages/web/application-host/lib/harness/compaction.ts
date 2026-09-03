/**
 * Compaction — take over session compaction with memory blocks + facts.
 *
 * Design: agent-harness.md §8.4.2–8.4.4
 * Plan: agent-harness-plan.md §2.6
 *
 * session_before_compact → assemble summary from blocks + plan + facts.
 * Returns { compaction: { summary, firstKeptEntryId, tokensBefore } }.
 *
 * Summary template:
 * <piarium-compaction note="State carried across compaction...">
 * <plan>…</plan>
 * <blocks>[progress] …</blocks>
 * <facts>files touched: …, unresolved diagnostics: …, last checkpoint: …</facts>
 * </piarium-compaction>
 *
 * Non-stacking: second compaction's summary must be current blocks + facts,
 * not include first compaction's summary text.
 */

import type { KnowledgeStore, Block } from "../knowledge/store.js";

// ── Types ──────────────────────────────────────────────────────────

export interface CompactionFacts {
  touchedFiles: string[];
  unresolvedDiagnostics: Array<{ path: string; count: number }>;
  checkpoints: string[];
}

export interface CompactionMaterials {
  blocks: Block[];
  plan: string;
  facts: CompactionFacts;
  recentTurnsToKeep: number;
}

export interface CompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface CompactionSettings {
  keepTurns: number; // default 8
  reinjectFileLimit: number; // default 5
  reinjectFileTokens: number; // default 5000
  reinjectTotalTokens: number; // default 50000
  reinjectSkillsTokens: number; // default 25000
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  keepTurns: 8,
  reinjectFileLimit: 5,
  reinjectFileTokens: 5000,
  reinjectTotalTokens: 50000,
  reinjectSkillsTokens: 25000,
};

// ── Summary assembly ───────────────────────────────────────────────

export function assembleCompactionSummary(materials: CompactionMaterials): string {
  const sections: string[] = [];

  // Plan
  if (materials.plan) {
    sections.push(`<plan>${materials.plan}</plan>`);
  }

  // Blocks (excluding plan which is already included)
  const nonPlanBlocks = materials.blocks.filter((b) => b.label !== "plan");
  if (nonPlanBlocks.length > 0) {
    const blockText = nonPlanBlocks.map((b) => `[${b.label}] ${b.content}`).join("\n");
    sections.push(`<blocks>\n${blockText}\n</blocks>`);
  }

  // Facts
  const factLines: string[] = [];
  if (materials.facts.touchedFiles.length > 0) {
    const files = materials.facts.touchedFiles.slice(0, 10);
    const extra = materials.facts.touchedFiles.length - files.length;
    factLines.push(`files touched: ${files.join(", ")}${extra > 0 ? ` (+${extra} more)` : ""}`);
  }
  if (materials.facts.unresolvedDiagnostics.length > 0) {
    const diags = materials.facts.unresolvedDiagnostics.slice(0, 5);
    factLines.push(`unresolved diagnostics: ${diags.map((d) => `${d.path} (${d.count})`).join(", ")}`);
  }
  if (materials.facts.checkpoints.length > 0) {
    factLines.push(`last checkpoint: ${materials.facts.checkpoints[materials.facts.checkpoints.length - 1]}`);
  }
  if (factLines.length > 0) {
    sections.push(`<facts>\n${factLines.join("\n")}\n</facts>`);
  }

  return `<piarium-compaction note="State carried across compaction. Blocks are maintained by the memory keeper; facts come from the host.">\n${sections.join("\n")}\n</piarium-compaction>`;
}

// ── Compaction handler ─────────────────────────────────────────────

export interface CompactionHandlerDeps {
  store: KnowledgeStore;
  settings: CompactionSettings;
  /** Get facts from host */
  getFacts: () => Promise<CompactionFacts>;
  /** Get entry ID for K turns ago */
  getEntryIdAtTurn: (turnsAgo: number) => string | null;
  /** Get tokens before compaction */
  getTokensBefore: () => number;
  /** Memory agent pre-compaction refresh */
  requestPreCompactionRefresh?: () => Promise<void>;
}

export async function handleBeforeCompact(
  sessionId: string,
  deps: CompactionHandlerDeps,
  options?: { staleNote?: boolean },
): Promise<CompactionResult> {
  const { store, settings, getFacts, getEntryIdAtTurn, getTokensBefore } = deps;

  const blocks = await store.getBlocks(sessionId);
  const planBlock = blocks.find((b) => b.label === "plan");
  const plan = planBlock?.content ?? "";
  const facts = await getFacts();

  let summary = assembleCompactionSummary({
    blocks,
    plan,
    facts,
    recentTurnsToKeep: settings.keepTurns,
  });

  if (options?.staleNote) {
    summary += "\nnote: memory blocks may be stale";
  }

  const firstKeptEntryId = getEntryIdAtTurn(settings.keepTurns) ?? "";
  const tokensBefore = getTokensBefore();

  return { summary, firstKeptEntryId, tokensBefore };
}

// ── Re-injection after compaction ──────────────────────────────────

export interface ReinjectFile {
  path: string;
  content: string;
}

export interface ReinjectResult {
  message: string;
  filesReinjected: number;
  skillsReinjected: number;
}

export function assembleReinjectMessage(
  files: ReinjectFile[],
  skills: string[],
  settings: CompactionSettings,
): ReinjectResult {
  const fileContents: string[] = [];
  let totalTokens = 0;
  let filesReinjected = 0;

  for (const file of files.slice(0, settings.reinjectFileLimit)) {
    const truncated = file.content.slice(0, settings.reinjectFileTokens * 4);
    const tokens = Math.ceil(truncated.length / 4);
    if (totalTokens + tokens > settings.reinjectTotalTokens) break;
    fileContents.push(`<file path="${file.path}">\n${truncated}\n</file>`);
    totalTokens += tokens;
    filesReinjected++;
  }

  const skillsText = skills.join("\n");
  const skillsTokens = Math.ceil(skillsText.length / 4);
  const skillsReinjected = skillsTokens <= settings.reinjectSkillsTokens ? skills.length : 0;
  const skillsSection = skillsReinjected > 0 ? `<skills>\n${skillsText}\n</skills>` : "";

  const message = `<piarium-reinject>\n${fileContents.join("\n")}\n${skillsSection}\n</piarium-reinject>`;

  return { message, filesReinjected, skillsReinjected };
}
