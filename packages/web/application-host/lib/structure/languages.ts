import { JSON_OUTLINE_MAX_DEPTH, JSON_OUTLINE_MAX_SYMBOLS } from "./constants.js";
import {
  JAVASCRIPT_DEFINITION_QUERY,
  JAVASCRIPT_IMPORT_QUERY,
  JAVASCRIPT_LITERAL_CALL_QUERY,
  JSON_DEFINITION_QUERY,
  TYPESCRIPT_DEFINITION_QUERY,
  TYPESCRIPT_IMPORT_QUERY,
  TYPESCRIPT_LITERAL_CALL_QUERY,
} from "./queries.js";
import { NO_STRUCTURE_CAPABILITIES, type StructureCapabilities } from "./types.js";

/**
 * Per-language tree-sitter wiring. Capabilities are derived from which
 * queries are present — do not restate the four flags by hand.
 */
export interface TreeSitterLanguageSpec {
  grammarFile: string;
  definitionQuery: string;
  importQuery?: string;
  literalCallQuery?: string;
  commentTypes: ReadonlySet<string>;
  stringTypes: ReadonlySet<string>;
  bindingTypes: ReadonlySet<string>;
  /** When set, outline walks JSON pair/object/array nodes instead of code units. */
  jsonOutline?: { maxDepth: number; maxSymbols: number };
}

const TYPESCRIPT_COMMENT_TYPES: ReadonlySet<string> = new Set(["comment", "html_comment"]);
const TYPESCRIPT_STRING_TYPES: ReadonlySet<string> = new Set([
  "string",
  "template_string",
  "string_fragment",
  "escape_sequence",
]);
const TYPESCRIPT_BINDING_TYPES: ReadonlySet<string> = new Set([
  "lexical_declaration",
  "variable_declaration",
  "public_field_definition",
]);

const JAVASCRIPT_BINDING_TYPES: ReadonlySet<string> = new Set([
  "lexical_declaration",
  "variable_declaration",
  "field_definition",
]);

const TYPESCRIPT_FAMILY: Omit<TreeSitterLanguageSpec, "grammarFile"> = {
  definitionQuery: TYPESCRIPT_DEFINITION_QUERY,
  importQuery: TYPESCRIPT_IMPORT_QUERY,
  literalCallQuery: TYPESCRIPT_LITERAL_CALL_QUERY,
  commentTypes: TYPESCRIPT_COMMENT_TYPES,
  stringTypes: TYPESCRIPT_STRING_TYPES,
  bindingTypes: TYPESCRIPT_BINDING_TYPES,
};

const JAVASCRIPT_FAMILY: Omit<TreeSitterLanguageSpec, "grammarFile"> = {
  definitionQuery: JAVASCRIPT_DEFINITION_QUERY,
  importQuery: JAVASCRIPT_IMPORT_QUERY,
  literalCallQuery: JAVASCRIPT_LITERAL_CALL_QUERY,
  commentTypes: TYPESCRIPT_COMMENT_TYPES,
  stringTypes: TYPESCRIPT_STRING_TYPES,
  bindingTypes: JAVASCRIPT_BINDING_TYPES,
};

export const TREE_SITTER_LANGUAGE_SPECS: Readonly<Record<string, TreeSitterLanguageSpec>> = {
  typescript: {
    ...TYPESCRIPT_FAMILY,
    grammarFile: "tree-sitter-typescript.wasm",
  },
  typescriptreact: {
    ...TYPESCRIPT_FAMILY,
    grammarFile: "tree-sitter-tsx.wasm",
  },
  javascript: {
    ...JAVASCRIPT_FAMILY,
    grammarFile: "tree-sitter-javascript.wasm",
  },
  javascriptreact: {
    ...JAVASCRIPT_FAMILY,
    grammarFile: "tree-sitter-javascript.wasm",
  },
  json: {
    grammarFile: "tree-sitter-json.wasm",
    definitionQuery: JSON_DEFINITION_QUERY,
    commentTypes: new Set(["comment"]),
    stringTypes: new Set(["string", "string_content", "escape_sequence"]),
    bindingTypes: new Set(),
    jsonOutline: { maxDepth: JSON_OUTLINE_MAX_DEPTH, maxSymbols: JSON_OUTLINE_MAX_SYMBOLS },
  },
};

/**
 * Cold catalog languages: specs that extract imports. JSON outlines for
 * slicing only and stays out (D-114 / D-115).
 */
export const CATALOG_SCAN_LANGUAGES: ReadonlySet<string> = new Set(
  Object.entries(TREE_SITTER_LANGUAGE_SPECS)
    .filter(([, spec]) => Boolean(spec.importQuery))
    .map(([languageId]) => languageId),
);

export function treeSitterLanguageSpec(languageId: string | null | undefined): TreeSitterLanguageSpec | undefined {
  if (!languageId) return undefined;
  return TREE_SITTER_LANGUAGE_SPECS[languageId];
}

export function capabilitiesFromSpec(spec: TreeSitterLanguageSpec | undefined): StructureCapabilities {
  if (!spec) return NO_STRUCTURE_CAPABILITIES;
  return {
    outline: true,
    classifyHits: true,
    literalCalls: Boolean(spec.literalCallQuery),
    imports: Boolean(spec.importQuery),
  };
}
