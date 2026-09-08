/**
 * Object-first query parse for explore (plan 3.13).
 *
 * Technical objects are extracted and protected first. Remaining tokens are
 * question content: they may still drive weak lexical rg, but they do not
 * drive graph queries and they do not take identifier weight.
 *
 * Relation words are a closed table of edges the graph actually has. Anything
 * else is unknown. This is not NLU.
 */

import {
  classifyFileRole,
  classifyFileRoleDecision,
  fileRoleFit,
  type ExploreFileRole,
  type FileRoleGround,
} from "./file-role.js";

export type { ExploreFileRole, FileRoleGround };
export { classifyFileRole, classifyFileRoleDecision, fileRoleFit };

export type ExploreQueryRelation = "register" | "import" | "define" | "unknown";
export type ExploreQueryDomain = "implementation" | "design" | "dependency" | "unknown";

export type TermGroupKind = "anchor" | "literal" | "identifier" | "question";

export interface TermGroup {
  id: string;
  kind: TermGroupKind;
  distinctive: string;
  variants: string[];
}

export const DEFAULT_ANCHOR_CAP = 16;

const QUESTION_WORDS = new Set([
  "how", "does", "where", "what", "why", "which", "is", "are", "the", "a", "an", "of", "to", "in", "and", "find",
  "on", "for", "with", "from", "that", "this", "it", "we", "do", "be", "or", "as", "by", "at", "into",
  "这个", "那个", "这里", "那里", "哪里", "怎么", "如何", "为什么", "什么", "是否", "的", "了", "在", "是", "和", "与", "或", "请", "帮", "找", "查", "看看", "一下",
]);

/**
 * Closed relation table. Only edges the symbol graph can answer.
 * Do not grow this into NLU (D-144).
 */
const RELATION_WORDS: ReadonlyArray<{ relation: Exclude<ExploreQueryRelation, "unknown">; words: readonly string[] }> = [
  { relation: "register", words: ["registered", "register", "registers", "注册", "连接"] },
  { relation: "import", words: ["imports", "import", "imported", "导入"] },
  { relation: "define", words: ["defined", "define", "defines", "定义"] },
];

const DOMAIN_DESIGN = /设计|取舍|决策|为什么这样|why did we|decision record|agent-harness-decisions/iu;
const DOMAIN_DEPENDENCY = /lockfile|license|changelog|依赖|许可|变更历史/iu;
const DOMAIN_IMPLEMENT = /router|host|implement|service|write guard|注册|入口|how does|where is|where do|what stops|what limits|how is|在哪|怎么|如何/iu;

const CHINESE_WORD_SEGMENTER = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("zh", { granularity: "word" })
  : null;

export function extractQuotedLiterals(question: string): string[] {
  return [...question.matchAll(/"([^"]+)"|'([^']+)'|\x60([^\x60]+)\x60|“([^”]+)”|‘([^’]+)’/gu)]
    .map((match) => match.slice(1).find((value) => value !== undefined)!)
    .filter(Boolean);
}

/** Identifier-like tokens, stopwords removed. Used by tests and as a tokenizer. */
export function extractIdentifiers(question: string): string[] {
  return [...new Set(extractIdentifierGroups(question).flatMap((group) => group.variants))];
}

export function extractIdentifierGroups(question: string): Array<{ distinctive: string; variants: string[] }> {
  const identifiers = question.match(/[$_\p{L}][$_\p{L}\p{M}\p{N}]*/gu) ?? [];
  const groups: Array<{ distinctive: string; variants: string[] }> = [];
  for (const identifier of identifiers) {
    if (QUESTION_WORDS.has(identifier.toLowerCase())) continue;
    const variants = new Set<string>([identifier]);
    for (const part of identifier.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").split(/[\s_]+/u)) {
      if (part && !QUESTION_WORDS.has(part.toLowerCase())) variants.add(part);
    }
    if (CHINESE_WORD_SEGMENTER && /\p{Script=Han}/u.test(identifier)) {
      for (const segment of CHINESE_WORD_SEGMENTER.segment(identifier)) {
        if (segment.isWordLike && !QUESTION_WORDS.has(segment.segment)) variants.add(segment.segment);
      }
    }
    groups.push({ distinctive: identifier, variants: [...variants] });
  }
  return groups;
}

export function extractTechnicalObjects(question: string): string[] {
  const found = question.match(/[A-Za-z_][\w]*(?:[.\-:][\w]+)+/g) ?? [];
  return [...new Set(found)];
}

export function isCodeObjectToken(token: string): boolean {
  if (!token) return false;
  if (/[.\-:]/.test(token)) return true;
  if (/[/\\]/.test(token) || /\.\w{1,8}$/.test(token)) return true;
  if (token.startsWith("$") || token.startsWith("_")) return true;
  if (/[A-Z]/.test(token) && /[a-z]/.test(token)) return true;
  if (/_/.test(token)) return true;
  if (/^[A-Z][A-Z0-9]{1,}$/.test(token)) return true;
  return false;
}

/** Dotted or protocol-like values the graph stores as connection literals. Hyphenated package names are not. */
export function looksLikeConnectionValue(token: string): boolean {
  return /[.:]/.test(token) || /[A-Za-z0-9]\/[A-Za-z0-9]/.test(token);
}

export function looksLikeSymbolName(token: string): boolean {
  return !looksLikeConnectionValue(token) && !/[/\\]/.test(token);
}

const FILE_PATH_EXTENSION = /\.(?:[cm]?[tj]sx?|json|md|py|rs|go|java|c|h|cc|cpp|css|html|yml|yaml|toml|lock)$/i;

export function looksLikePathObject(token: string): boolean {
  return /[/\\]/.test(token) || FILE_PATH_EXTENSION.test(token);
}

function relationOf(token: string): ExploreQueryRelation {
  const lower = token.toLowerCase();
  for (const entry of RELATION_WORDS) {
    if (entry.words.includes(lower) || entry.words.includes(token)) return entry.relation;
  }
  return "unknown";
}

function isRelationWord(token: string): boolean {
  return relationOf(token) !== "unknown";
}

function objectShapeOn(question: string): boolean {
  return /\bon\s*\(|名为\s*on|called\s+on\b/iu.test(question);
}

function relationInToken(token: string): ExploreQueryRelation {
  const direct = relationOf(token);
  if (direct !== "unknown") return direct;
  if (CHINESE_WORD_SEGMENTER && /\p{Script=Han}/u.test(token)) {
    for (const segment of CHINESE_WORD_SEGMENTER.segment(token)) {
      const rel = relationOf(segment.segment);
      if (rel !== "unknown") return rel;
    }
  }
  if (/\p{Script=Han}/u.test(token)) {
    for (const entry of RELATION_WORDS) {
      for (const word of entry.words) {
        if (/\p{Script=Han}/u.test(word) && token.includes(word)) return entry.relation;
      }
    }
  }
  return "unknown";
}

function coveredByObject(token: string, objects: readonly string[]): boolean {
  return objects.some((object) => object === token || object.split(/[.\-:/\\]/).includes(token));
}

export function classifyExploreDomain(question: string, relation: ExploreQueryRelation): ExploreQueryDomain {
  if (DOMAIN_DEPENDENCY.test(question)) return "dependency";
  if (DOMAIN_DESIGN.test(question)) return "design";
  if (relation === "register" || relation === "import" || relation === "define") return "implementation";
  if (DOMAIN_IMPLEMENT.test(question)) return "implementation";
  return "unknown";
}

export function preferTestFiles(question: string, domain: ExploreQueryDomain, relation: ExploreQueryRelation): boolean | null {
  if (/\b(tests?|spec|fixture|单测)\b/iu.test(question)) return true;
  if (domain === "implementation" && (relation === "register" || relation === "define" || relation === "import")) return false;
  return null;
}

export interface ExploreQueryParse {
  objects: string[];
  content: string[];
  relation: ExploreQueryRelation;
  domain: ExploreQueryDomain;
  groups: TermGroup[];
  suppliedAnchors: string[];
  usedAnchors: string[];
  anchorsTruncated: number;
  preferTests: boolean | null;
}

export function parseExploreQuery(question: string, anchors: readonly string[] = []): ExploreQueryParse {
  const suppliedAnchors = [...anchors];
  const usable = anchors.map((anchor) => anchor.trim()).filter(Boolean);
  const usedAnchors = usable.slice(0, DEFAULT_ANCHOR_CAP);
  const anchorsTruncated = Math.max(0, usable.length - usedAnchors.length);

  const objects: string[] = [];
  const content: string[] = [];
  const seen = new Set<string>();
  const remember = (list: string[], value: string): void => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    list.push(value);
  };

  for (const anchor of usedAnchors) remember(objects, anchor);
  for (const literal of extractQuotedLiterals(question)) remember(objects, literal);
  for (const technical of extractTechnicalObjects(question)) remember(objects, technical);

  let relation: ExploreQueryRelation = "unknown";
  const tokens = question.match(/[$_\p{L}][$_\p{L}\p{M}\p{N}]*/gu) ?? [];
  const allowBareOn = objectShapeOn(question) || tokens.filter((token) => !QUESTION_WORDS.has(token.toLowerCase()) || token.toLowerCase() === "on").length === 1;
  for (const token of tokens) {
    const rel = relationInToken(token);
    if (rel !== "unknown") {
      if (relation === "unknown") relation = rel;
      continue;
    }
    if (QUESTION_WORDS.has(token.toLowerCase())) {
      if (token.toLowerCase() === "on" && allowBareOn) remember(objects, token);
      continue;
    }
    if (CHINESE_WORD_SEGMENTER && /\p{Script=Han}/u.test(token)) {
      const parts = [...CHINESE_WORD_SEGMENTER.segment(token)].filter((segment) => segment.isWordLike);
      if (
        parts.length > 0
        && parts.every((part) => QUESTION_WORDS.has(part.segment) || relationInToken(part.segment) !== "unknown")
      ) {
        for (const part of parts) {
          const rel = relationInToken(part.segment);
          if (rel !== "unknown" && relation === "unknown") relation = rel;
        }
        continue;
      }
    }
    if (seen.has(token) || coveredByObject(token, objects)) continue;
    if (isCodeObjectToken(token)) remember(objects, token);
    else remember(content, token);
  }

  if (objects.length === 0 && content.length === 0) {
    const trimmed = question.trim();
    if (trimmed) remember(objects, trimmed);
  }

  const groups: TermGroup[] = [];
  const add = (kind: TermGroupKind, distinctive: string, variants: string[]): void => {
    if (!distinctive || groups.some((group) => group.distinctive === distinctive)) return;
    groups.push({
      id: `${kind}:${distinctive}`,
      kind,
      distinctive,
      variants: variants.length > 0 ? variants : [distinctive],
    });
  };
  for (const anchor of usedAnchors) add("anchor", anchor, [anchor]);
  for (const object of objects) {
    if (usedAnchors.includes(object)) continue;
    if (extractQuotedLiterals(question).includes(object) || /[.\-:]/.test(object) || looksLikePathObject(object)) {
      add("literal", object, [object]);
      continue;
    }
    const splits = object.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").split(/[\s_]+/u)
      .filter((part) => part && !QUESTION_WORDS.has(part.toLowerCase()) && !isRelationWord(part));
    add("identifier", object, [object, ...splits.filter((part) => part !== object)]);
  }
  for (const word of content) add("question", word, [word]);
  if (groups.length === 0 && question.trim()) add("question", question.trim(), [question.trim()]);

  const domain = classifyExploreDomain(question, relation);
  return {
    objects,
    content,
    relation,
    domain,
    groups,
    suppliedAnchors,
    usedAnchors,
    anchorsTruncated,
    preferTests: preferTestFiles(question, domain, relation),
  };
}

export function buildTermGroups(question: string, anchors: readonly string[] = []): {
  groups: TermGroup[];
  suppliedAnchors: string[];
  usedAnchors: string[];
  anchorsTruncated: number;
} {
  const parsed = parseExploreQuery(question, anchors);
  return {
    groups: parsed.groups,
    suppliedAnchors: parsed.suppliedAnchors,
    usedAnchors: parsed.usedAnchors,
    anchorsTruncated: parsed.anchorsTruncated,
  };
}

export function buildRgPatterns(identifiers: string[], literals: string[]): Array<{ pattern: string; fixedStrings: true }> {
  return [...new Set([...literals, ...identifiers])].map((pattern) => ({ pattern, fixedStrings: true }));
}
