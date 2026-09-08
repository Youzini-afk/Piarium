/**
 * Observation meters for explore.search. Visibility is the service `text`
 * after the byte budget, not the pre-budget `snippets` array (D-159 / D-171).
 */

export type ObserveStageNeed = {
  label: string;
  match: RegExp;
};

export type ObserveStageTarget = {
  id: string;
  pathIncludes: string;
  need: ObserveStageNeed;
};

export type ObserveStageWindow = {
  path: string;
  startLine: number;
  endLine: number;
  why: string;
  packed: boolean;
  hits: string[];
  arrivals?: Array<{ kind: string }>;
  assessment?: string;
  purpose?: string;
  unit?: {
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    omitted?: Array<{ startLine: number; endLine: number }>;
  };
};

export type ObserveStagePayload = {
  text?: string;
  snippets?: Array<{ path: string; text?: string; why?: string }>;
  details?: {
    provenance?: Array<{ path: string; status: string }>;
    graph?: { connections?: number; associates?: number; definitions?: number; status?: string };
    skippedQueries?: { reason: string; patterns: string[] };
    query?: { objects?: string[]; relation?: string; domain?: string };
    distinctiveness?: {
      scope?: string;
      poolFiles?: number;
      terms?: Array<{ term: string; uniqueFiles: number; coverage: string; weight: number }>;
    };
    windows?: ObserveStageWindow[];
    semantic?: {
      status?: string;
      coverage?: string;
      generation?: string;
      spaceId?: string;
      scope?: { scopeKind: string; scopeId: string };
      index?: { lifecycle?: string };
      blocks?: number;
      units?: number;
      primary?: number;
    };
  };
  notRequested?: { paths?: string[] };
};

export const visibleExcerptBlocks = (text: string): string[] => {
  if (!text) return [];
  return text.split(/\n(?=--- )/).filter((block) => block.startsWith("--- "));
};

export const needMet = (snippet: { text?: string; why?: string }, need: ObserveStageNeed): boolean => (
  need.match.test(`${snippet.text ?? ""} ${snippet.why ?? ""}`)
);

export const formatSemanticLine = (semantic: NonNullable<ObserveStagePayload["details"]>["semantic"]): string => {
  const source = semantic ?? {};
  return `semantic: status=${source.status ?? "—"} coverage=${source.coverage ?? "—"} `
    + `lifecycle=${source.index?.lifecycle ?? "—"} blocks=${source.blocks ?? 0} `
    + `units=${source.units ?? 0} primary=${source.primary ?? 0}`;
};

export const stageForTarget = (
  target: ObserveStageTarget,
  payload: ObserveStagePayload,
  options?: {
    needLinesIn?: (relativePath: string, need: ObserveStageNeed) => number[];
  },
): string => {
  const snippets = payload.snippets ?? [];
  const provenance = payload.details?.provenance ?? [];
  const unread = new Set(payload.notRequested?.paths ?? []);
  const visibleBlocks = visibleExcerptBlocks(payload.text ?? "");
  const fromPath = snippets
    .map((snippet, index) => ({ snippet, index }))
    .filter((item) => item.snippet.path.includes(target.pathIncludes));
  const visibleMetIndex = visibleBlocks.findIndex((block) => (
    block.includes(target.pathIncludes) && target.need.match.test(block)
  ));
  const snippetMet = fromPath.find((item) => needMet(item.snippet, target.need));
  const generated = (payload.details?.windows ?? []).filter((window) => window.path.includes(target.pathIncludes));
  const generatedMet = generated.find((window) => needMet({
    text: [window.hits.join("\n"), window.unit?.name ?? ""].filter(Boolean).join("\n"),
    why: window.why,
  }, target.need));
  const omittedFromBody = generated.find((window) => {
    if (!window.unit?.omitted?.length || !window.packed) return false;
    const lines = options?.needLinesIn?.(window.path, target.need) ?? [];
    return lines.some((line) => (
      line >= window.unit!.startLine
      && line <= window.unit!.endLine
      && window.unit!.omitted!.some((gap) => line >= gap.startLine && line <= gap.endLine)
    ));
  });
  const acquired = provenance.some((entry) => entry.path.includes(target.pathIncludes)) || fromPath.length > 0 || generated.length > 0;
  const entry = provenance.find((item) => item.path.includes(target.pathIncludes));
  if (!acquired && unread.size > 0 && [...unread].some((path) => path.includes(target.pathIncludes))) {
    return `${target.id}: acquired → not-requested: read budget`;
  }
  if (!acquired) return `${target.id}: not acquired`;
  if (entry?.status === "not-requested") return `${target.id}: acquired → not-requested: read budget`;
  if (entry?.status && entry.status !== "ready") return `${target.id}: acquired → ${entry.status}`;
  if (visibleMetIndex >= 0) {
    return `${target.id}: acquired → scheduled → read → ${target.need.label} verified → visible #${visibleMetIndex + 1}`;
  }
  if (snippetMet) {
    return `${target.id}: packed snippet has ${target.need.label}, not in visible text`;
  }
  if (generatedMet && !generatedMet.packed) {
    return `${target.id}: matching window generated ${generatedMet.startLine}-${generatedMet.endLine}, not selected`;
  }
  if (omittedFromBody?.unit) {
    return `${target.id}: unit ${omittedFromBody.unit.name} ${omittedFromBody.unit.startLine}-${omittedFromBody.unit.endLine}`
      + ` selected, but ${target.need.label} sits outside the packed body ${omittedFromBody.startLine}-${omittedFromBody.endLine}`;
  }
  if (fromPath[0] && !generatedMet) {
    return `${target.id}: read → visible #${fromPath[0].index + 1}, but matching window was never generated (${target.need.label})`;
  }
  if (fromPath[0]) {
    return `${target.id}: read → visible #${fromPath[0].index + 1}, but ${target.need.label} not in that window`;
  }
  if (entry?.status === "ready" && generatedMet) {
    return `${target.id}: matching window generated ${generatedMet.startLine}-${generatedMet.endLine}, packed out`;
  }
  if (entry?.status === "ready") return `${target.id}: read, but matching window was never generated`;
  return `${target.id}: acquired → scheduled → not visible`;
};
