export { JSON_OUTLINE_MAX_DEPTH, JSON_OUTLINE_MAX_SYMBOLS, SMALL_STRUCTURE_SPAN_LINES, STRUCTURE_HIT_CLASS_SCORE } from "./constants.js";
export { createLspStructureProvider } from "./lsp-provider.js";
export { CATALOG_SCAN_LANGUAGES, capabilitiesFromSpec, treeSitterLanguageSpec, TREE_SITTER_LANGUAGE_SPECS } from "./languages.js";
export { createTreeSitterStructureProvider } from "./tree-sitter-provider.js";
export type { TreeSitterLanguageSpec } from "./languages.js";
export { createStructureSource } from "./source.js";
export { classifyLiteralCall, CONFIRMED_CONNECTION_CALLEES } from "./connections.js";
export {
  enclosingSliceSymbol,
  outlineCoversHitLines,
  outlineUsableForText,
  proposeSymbolSliceSchemes,
  renderSymbolSliceScheme,
  sliceStructureWindows,
} from "./slice.js";
export type { StructureFocusOrigin, StructureFocusRange, StructureSliceScheme } from "./slice.js";
export { isJsonStructureContainerKind, isStructureContainerKind } from "./kinds.js";
export type { LiteralCallClass } from "./connections.js";
export type {
  StructureCapabilities,
  StructureClassifyRequest,
  StructureClassifyResult,
  StructureHitClass,
  StructureImport,
  StructureImportsResult,
  StructureLiteralCall,
  StructureLiteralCallsResult,
  StructureOutlineRequest,
  StructureOutlineResult,
  StructureProvider,
  StructureProviderId,
  StructureSource,
  StructureStatus,
  StructureSymbol,
} from "./types.js";
