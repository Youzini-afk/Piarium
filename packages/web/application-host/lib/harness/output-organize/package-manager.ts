import { organizeEslint } from "./eslint.js";
import { organizeGeneric } from "./generic.js";
import { organizeGit } from "./git.js";
import {
  identifyFromCommand,
  looksLikeEslint,
  looksLikeTsc,
  looksLikeVitest,
  type OrganizedCommandKind,
} from "./identify.js";
import { organizeTsc } from "./tsc.js";
import { fitBlocks, isInteractivePrompt, joinBlocks, omissionNote, utf8Bytes } from "./text.js";
import { organizeVitest } from "./vitest.js";

/**
 * Package-manager wildcard layer (D-241): `npm test` / `pnpm run build` /
 * `yarn add` / `bun test` / `npm exec <bin>` execute through the manager, so
 * the manager's own framing — script echoes, warning spam, progress lines,
 * install summaries — is what organization can rely on. When the echo or the
 * body identifies the inner tool, the inner organizer runs on the tool's own
 * output and the PM framing stays as context.
 */

/** `> name@1.2.3 test` — npm/pnpm script header, not the inner command. */
const SCRIPT_HEADER = /^>\s+\S+@[^\s]+\s+\S/;
/** `> vitest run` / `$ vitest run` — the inner command the manager echoed. */
const ECHO_LINE = /^(?:>|\$)\s+(.+)$/;

/** Manager outcome lines — kept even under budget pressure. */
const isSummary = (line: string): boolean => (
  /^(added|removed|up to date|audited|changed)\b/i.test(line.trim())
  || /^found \d+ vulnerabilities?/i.test(line.trim())
  || /^Done in \d/i.test(line.trim())
  || /^success\b/i.test(line.trim())
  || /^Saved\.?/i.test(line.trim())
  || /^Packages:\s*[+~-]/i.test(line.trim())
  || /^Progress:\s*resolved \d+.*reused/i.test(line.trim())
  || /^No issues found/i.test(line.trim())
);

/** Manager failure lines — always required. */
const isErrorLine = (line: string): boolean => (
  /^(npm ERR!|npm error|ERR_PNPM_|ERR_)/.test(line.trim())
  || /^error Command failed/i.test(line.trim())
  || /^Command failed with exit code/i.test(line.trim())
  || /^errno\b/i.test(line.trim())
);

/** Repeated manager chatter that is safe to collapse into a count. */
const isNoise = (line: string): boolean => {
  const trimmed = line.trim();
  return (
    /^npm (warn|timing|http|verb|sill)\b/i.test(trimmed)
    || /^Progress:\s*(resolved|downloaded|fetched)/i.test(trimmed)
    || /^(Downloading|Resolving|Reusing|Fetching|Linking|Building)\b/i.test(trimmed)
    || /^Packages:\s*(resolved|downloaded)/i.test(trimmed)
    || /^WARN\b/i.test(trimmed)
  );
};

const innerOrganizer = (
  kind: OrganizedCommandKind,
  subcommand: string | undefined,
  body: string,
  budget: number,
  exitCode?: number,
): { text: string; omitted: boolean; recognized: boolean } => {
  if (kind === "vitest") return organizeVitest(body, budget);
  if (kind === "tsc") return organizeTsc(body, budget, exitCode);
  if (kind === "eslint") return organizeEslint(body, budget);
  if (kind === "git") return organizeGit(body, subcommand, budget, exitCode);
  return { ...organizeGeneric(body, budget), recognized: false };
};

const sniffBody = (body: string): OrganizedCommandKind | undefined => {
  if (looksLikeVitest(body)) return "vitest";
  if (looksLikeTsc(body)) return "tsc";
  if (looksLikeEslint(body)) return "eslint";
  return undefined;
};

const unquote = (text: string): string => text.replace(/^["']+|["']+$/g, "").trim();

export function organizePackageManager(output: string, budget: number, exitCode?: number): {
  text: string;
  omitted: boolean;
  recognized: boolean;
  /** Inner tool kind when the echo/body identified one. */
  innerKind?: OrganizedCommandKind;
} {
  const lines = output.split("\n");

  // The script echo sits at the top: `> name@ver script` headers come first,
  // then `> inner command` / `$ inner command`. Only the top window counts —
  // a `>` line deep inside output is tool content (tsc frames), not an echo.
  let echoIndex = -1;
  let innerCommand = "";
  const scanLimit = Math.min(lines.length, 12);
  for (let index = 0; index < scanLimit; index += 1) {
    const trimmed = lines[index]!.trim();
    if (trimmed.length === 0 || isNoise(trimmed)) continue;
    if (SCRIPT_HEADER.test(trimmed)) continue;
    const echo = trimmed.match(ECHO_LINE);
    if (echo) {
      innerCommand = unquote(echo[1]!);
      echoIndex = index;
      break;
    }
    // A non-echo content line before any echo means this PM printed no echo.
    if (!/^(yarn (run|install|add|remove|upgrade)\b|yarn$)/i.test(trimmed)) break;
  }

  const framing = echoIndex >= 0 ? lines.slice(0, echoIndex + 1).map((line) => line.trimEnd()) : [];
  const bodyLines = echoIndex >= 0 ? lines.slice(echoIndex + 1) : lines;
  const body = bodyLines.join("\n");

  // Inner identification: the echoed command first (manager-emitted, so it is
  // reliable execution position), then the body shape when the echo names
  // something unknown or there is no echo at all.
  let innerKind: OrganizedCommandKind | undefined;
  let gitSubcommand: string | undefined;
  if (innerCommand) {
    const identified = identifyFromCommand(innerCommand);
    if (identified && identified.kind !== "generic" && identified.kind !== "package-manager") {
      innerKind = identified.kind;
      gitSubcommand = identified.gitSubcommand;
    }
  }
  if (!innerKind) innerKind = sniffBody(body);

  if (innerKind) {
    const inner = innerOrganizer(innerKind, gitSubcommand, body, budget, exitCode);
    if (inner.recognized) {
      const frameText = joinBlocks(framing.filter((line) => line.trim().length > 0));
      const text = joinBlocks([frameText, inner.text]);
      if (utf8Bytes(text) <= budget) {
        return { text, omitted: inner.omitted, recognized: true, innerKind };
      }
      const packed = fitBlocks({ required: [inner.text], optional: frameText ? [frameText] : [], budget });
      const note = omissionNote(packed.omitted, packed.omittedBytes);
      return {
        text: joinBlocks(note ? [packed.text, note] : [packed.text]),
        omitted: true,
        recognized: true,
        innerKind,
      };
    }
    // Inner command identified but its output is unrecognizable — fall through
    // to manager-level organization so nothing is discarded.
  }

  const prompts: string[] = [];
  const errors: string[] = [];
  const summaries: string[] = [];
  const kept: string[] = [];
  const noiseSamples = new Map<string, number>();
  let noiseCount = 0;
  for (const line of lines) {
    if (isInteractivePrompt(line)) {
      prompts.push(line.trimEnd());
      continue;
    }
    if (isErrorLine(line)) {
      errors.push(line.trimEnd());
      continue;
    }
    if (isSummary(line)) {
      summaries.push(line.trimEnd());
      continue;
    }
    if (isNoise(line)) {
      noiseCount += 1;
      const sample = line.trim();
      noiseSamples.set(sample.slice(0, 120), (noiseSamples.get(sample.slice(0, 120)) ?? 0) + 1);
      continue;
    }
    kept.push(line.trimEnd());
  }

  const noiseNote = noiseCount > 0
    ? `[collapsed ${noiseCount} package-manager noise line(s)${noiseSamples.size > 0 ? ` — e.g. ${[...noiseSamples.keys()][0]}` : ""}]`
    : "";
  const packed = fitBlocks({
    required: [...prompts, ...errors, ...summaries],
    optional: kept.length > 0 ? [joinBlocks(kept)] : [],
    budget,
  });
  const notes = [omissionNote(packed.omitted, packed.omittedBytes), noiseNote].filter((note) => note.length > 0);
  return {
    text: joinBlocks([packed.text, ...notes]),
    omitted: packed.omitted > 0 || noiseCount > 0,
    recognized: true,
  };
}
