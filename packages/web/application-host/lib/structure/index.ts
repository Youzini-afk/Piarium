export { SMALL_STRUCTURE_SPAN_LINES } from "./constants.js";
export { createLspStructureProvider } from "./lsp-provider.js";
export { createStructureSource } from "./source.js";
export { outlineUsableForText, sliceStructureWindows } from "./slice.js";
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
