export { SMALL_STRUCTURE_SPAN_LINES, STRUCTURE_HIT_CLASS_SCORE } from "./constants.js";
export { createLspStructureProvider } from "./lsp-provider.js";
export { createTreeSitterStructureProvider } from "./tree-sitter-provider.js";
export { createStructureSource } from "./source.js";
export { enclosingSliceSymbol, outlineCoversHitLines, outlineUsableForText, sliceStructureWindows } from "./slice.js";
export { isStructureContainerKind } from "./kinds.js";
export type {
  StructureCapabilities,
  StructureClassifyRequest,
  StructureClassifyResult,
  StructureHitClass,
  StructureOutlineRequest,
  StructureOutlineResult,
  StructureProvider,
  StructureProviderId,
  StructureSource,
  StructureStatus,
  StructureSymbol,
} from "./types.js";
