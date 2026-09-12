export type OrganizedCommandKind = "vitest" | "tsc" | "eslint" | "git" | "package-manager" | "generic";

export type IdentifiedCommand = {
  kind: OrganizedCommandKind;
  gitSubcommand?: string;
  /** The package-manager head token when the command runs through one (D-241). */
  packageManager?: string;
  source: "command" | "output";
};

/** Heads that execute a resolved binary directly: `npx vitest`, `bunx tsc`. */
const EXEC_WRAPPERS = new Set(["npx", "bunx"]);
/**
 * Heads that act as the package manager itself: they run package.json
 * scripts, their own builtins (install/test/add…), or a script/binary the
 * command line cannot disambiguate — the reliable execution position is the
 * manager, and the script echo identifies the inner command (D-241).
 */
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** `deno task`, `node file.js` — runtime heads, not package-manager context. */
const RUNTIME_HEADS = new Set(["deno", "node"]);
const WRAPPERS = new Set([...EXEC_WRAPPERS, ...PACKAGE_MANAGERS, ...RUNTIME_HEADS]);
/** Subcommands that execute a resolved binary: `npm exec vitest`, `pnpm dlx tsc`. */
const WRAPPER_EXEC_SUB = new Set(["exec", "x", "dlx"]);
/** `<pm> run <script>` — the script name is user data, not a tool identity. */
const WRAPPER_RUN_SUB = new Set(["run"]);
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const WRAPPER_VALUE_FLAGS = new Set([
  "-p", "--package", "--cwd", "--config", "--prefix",
  "-w", "--workspace", "--filter", "-F", "--dir", "--mode",
]);

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

type SegmentClassification = IdentifiedCommand | "context" | "output-only" | "unknown";

function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function tokenAt(tokens: string[], index: number): string | undefined {
  return tokens[index];
}

const specificKind = (token: string): OrganizedCommandKind | undefined => {
  if (token === "vitest") return "vitest";
  if (token === "tsc") return "tsc";
  if (token === "eslint") return "eslint";
  if (token === "git") return "git";
  return undefined;
};

export function gitSubcommand(command: string): string | undefined {
  const subcommands: string[] = [];
  for (const segment of splitCommandSegments(command)) {
    const tokens = commandTokens(segment);
    const classification = classifySegment(tokens);
    if (classification === "context") continue;
    if (classification === "unknown" || classification === "output-only" || !classification || classification.kind !== "git") return undefined;
    if (classification.gitSubcommand) subcommands.push(classification.gitSubcommand);
  }
  const unique = [...new Set(subcommands)];
  if (unique.length === 1) return unique[0];
  return undefined;
}

function gitSubcommandFromTokens(tokens: string[], gitIndex: number): string | undefined {
  for (let index = gitIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (GIT_VALUE_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return undefined;
}

function classifySegment(tokens: string[]): SegmentClassification {
  let index = 0;
  while (index < tokens.length && isAssignment(tokens[index]!)) index += 1;
  if (index >= tokens.length) return "unknown";

  const first = tokens[index]!;
  if (first === "cd" || first === "pushd" || first === "popd") return "context";
  if (first === "echo" || first === "printf") return "output-only";
  if (first === "command" || first === "exec") {
    index += 1;
    while (tokens[index]?.startsWith("-")) index += 1;
  }
  const executable = tokenAt(tokens, index);
  if (!executable) return "unknown";
  const direct = specificKind(executable);
  if (direct) {
    const subcommand = direct === "git" ? gitSubcommandFromTokens(tokens, index) : undefined;
    return {
      kind: direct,
      source: "command",
      ...(subcommand ? { gitSubcommand: subcommand } : {}),
    };
  }

  if (!WRAPPERS.has(executable)) return "unknown";
  const packageManager = PACKAGE_MANAGERS.has(executable) ? executable : undefined;
  index += 1;
  const skipWrapperFlags = (): void => {
    while (index < tokens.length && tokens[index]!.startsWith("-")) {
      if (WRAPPER_VALUE_FLAGS.has(tokens[index]!)) index += 1;
      index += 1;
    }
  };
  skipWrapperFlags();
  if (WRAPPER_RUN_SUB.has(tokens[index] ?? "")) {
    // `npm run build` / `bun run test` invoke an arbitrary package script; the
    // manager is the reliable execution position, not the script name.
    if (packageManager) return { kind: "package-manager", source: "command", packageManager };
    index += 1;
    skipWrapperFlags();
  } else if (WRAPPER_EXEC_SUB.has(tokens[index] ?? "")) {
    // `npm exec` / `pnpm dlx` / `bun x` resolve and run a binary directly.
    // Only a recognized inner tool gets its own organizer; an unknown binary
    // behind exec/dlx/x is NOT package-manager context — the tool's own output
    // is all there is, and PM noise folding must not hide it (D-241 rework).
    index += 1;
    skipWrapperFlags();
    const wrappedExec = tokenAt(tokens, index);
    const execKind = wrappedExec ? specificKind(wrappedExec) : undefined;
    if (!execKind) return "unknown";
    const execSubcommand = execKind === "git" ? gitSubcommandFromTokens(tokens, index) : undefined;
    return {
      kind: execKind,
      source: "command",
      ...(execSubcommand ? { gitSubcommand: execSubcommand } : {}),
      ...(packageManager ? { packageManager } : {}),
    };
  } else if (packageManager) {
    // `npm test` / `pnpm vitest` / `yarn add` / `bun install`: a builtin or an
    // implicit script/binary run — the package manager is what executed.
    return { kind: "package-manager", source: "command", packageManager };
  }
  const wrapped = tokenAt(tokens, index);
  const kind = wrapped ? specificKind(wrapped) : undefined;
  if (!kind) {
    return packageManager ? { kind: "package-manager", source: "command", packageManager } : "unknown";
  }
  const subcommand = kind === "git" ? gitSubcommandFromTokens(tokens, index) : undefined;
  return {
    kind,
    source: "command",
    ...(subcommand ? { gitSubcommand: subcommand } : {}),
    ...(packageManager ? { packageManager } : {}),
  };
}

export function identifyFromCommand(command: string): IdentifiedCommand | undefined {
  const found: IdentifiedCommand[] = [];
  let hasUnknown = false;
  let hasOutputOnly = false;
  for (const segment of splitCommandSegments(command)) {
    const classification = classifySegment(commandTokens(segment));
    if (classification === "context") continue;
    if (classification === "output-only") {
      hasOutputOnly = true;
      continue;
    }
    if (classification === "unknown") {
      hasUnknown = true;
      continue;
    }
    found.push(classification);
  }
  if (found.length === 0) return hasOutputOnly ? { kind: "generic", source: "command" } : undefined;
  const kinds = new Set(found.map((entry) => entry.kind));
  const gitSubcommands = new Set(found.filter((entry) => entry.kind === "git").map((entry) => entry.gitSubcommand));
  if (hasUnknown || hasOutputOnly || kinds.size > 1 || (kinds.has("git") && gitSubcommands.size > 1)) {
    return { kind: "generic", source: "command" };
  }
  return found[0];
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
    /\):\s+error TS\d+/.test(line)
    || /:\d+:\d+\s+-\s+error TS\d+/.test(line)
    || /:\d+:\d+:\s+error TS\d+/.test(line)
    || /^\s*error TS\d+/.test(line)
    || /^\s*Found\s+\d+\s+errors?\b/.test(line)
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
