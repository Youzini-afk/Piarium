export type OrganizedCommandKind = "vitest" | "tsc" | "eslint" | "git" | "generic";

export type IdentifiedCommand = {
  kind: OrganizedCommandKind;
  gitSubcommand?: string;
  source: "command" | "output";
};

const WRAPPERS = new Set(["npx", "bunx", "pnpm", "yarn", "npm", "bun", "deno", "node"]);
const WRAPPER_SUB = new Set(["run", "exec", "x", "dlx"]);
const SPECIFIC = new Set(["vitest", "tsc", "eslint", "git"]);
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === "&&" || pair === "||") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    if (char === ";" || char === "|") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

export function commandTokens(segment: string): string[] {
  return segment
    .split(/\s+/)
    .map((token) => token.replace(/^['"]+|['"]+$/g, ""))
    .filter(Boolean)
    .map((token) => token.replace(/\\/g, "/").split("/").pop() ?? token)
    .map((token) => token.replace(/\.(cmd|exe)$/i, ""));
}

const specificKind = (token: string): OrganizedCommandKind | undefined => {
  if (token === "vitest") return "vitest";
  if (token === "tsc") return "tsc";
  if (token === "eslint") return "eslint";
  if (token === "git") return "git";
  return undefined;
};

export function gitSubcommand(command: string): string | undefined {
  for (const segment of splitCommandSegments(command)) {
    const tokens = commandTokens(segment);
    let seenGit = false;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (!seenGit) {
        if (token === "git") seenGit = true;
        continue;
      }
      if (GIT_VALUE_FLAGS.has(token)) {
        index += 1;
        continue;
      }
      if (token.startsWith("-")) continue;
      return token;
    }
  }
  return undefined;
}

export function identifyFromCommand(command: string): IdentifiedCommand | undefined {
  const found: IdentifiedCommand[] = [];
  for (const segment of splitCommandSegments(command)) {
    const tokens = commandTokens(segment).filter((token) => (
      !WRAPPERS.has(token) && !WRAPPER_SUB.has(token) && !token.startsWith("-")
    ));
    for (const token of tokens) {
      const kind = specificKind(token);
      if (!kind || !SPECIFIC.has(token)) continue;
      if (kind === "git") {
        const subcommand = gitSubcommand(command);
        found.push(subcommand ? { kind, source: "command", gitSubcommand: subcommand } : { kind, source: "command" });
      } else {
        found.push({ kind, source: "command" });
      }
    }
  }
  if (found.length === 1) return found[0];
  if (found.length > 1) return found[found.length - 1];
  return undefined;
}

export function looksLikeVitest(output: string): boolean {
  let files = false;
  let duration = false;
  for (const line of output.split("\n")) {
    const trimmed = line.trimStart();
    files ||= trimmed.startsWith("Test Files");
    duration ||= trimmed.startsWith("Duration ");
  }
  return files && duration;
}

export function looksLikeTsc(output: string): boolean {
  return output.split("\n").some((line) => (
    /\):\s+error TS\d+/.test(line) || /^\s*error TS\d+/.test(line) || /^\s*Found \d+ error/.test(line.trim())
  ));
}

export function looksLikeEslint(output: string): boolean {
  const trimmed = output.trimStart();
  if (trimmed.startsWith("[{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return Array.isArray(parsed) && parsed.some((row) => (
        row !== null && typeof row === "object" && "filePath" in row && "messages" in row
      ));
    } catch {
      return false;
    }
  }
  return output.split("\n").some((line) => (
    /^✖\s+\d+\s+problem/.test(line.trim())
    || /^\s+\d+:\d+\s+(error|warning|off)\b/.test(line)
    || /:\d+:\d+:\s+.+\s+\[(error|warning)\//.test(line)
  ));
}

export function identifyShellOutput(command: string, output: string): IdentifiedCommand {
  const fromCommand = identifyFromCommand(command);
  if (fromCommand) return fromCommand;
  if (looksLikeVitest(output)) return { kind: "vitest", source: "output" };
  if (looksLikeTsc(output)) return { kind: "tsc", source: "output" };
  if (looksLikeEslint(output)) return { kind: "eslint", source: "output" };
  return { kind: "generic", source: "output" };
}
