import type { AgentInputContext } from "@piarium/protocol";

export type StructureProviderId = "lsp" | "tree-sitter";

export type StructureStatus =
  | "ready"
  | "empty"
  | "unavailable"
  | "unsupported"
  | "stale"
  | "failed"
  | "cancelled";

export type StructureHitClass = "name" | "body" | "string" | "comment";

export interface StructureCapabilities {
  outline: boolean;
  classifyHits: boolean;
  literalCalls: boolean;
  imports: boolean;
}

export interface StructureLineRange {
  /** Inclusive, 1-based. */
  startLine: number;
  /** Inclusive, 1-based. */
  endLine: number;
}

export interface StructureSymbol {
  name: string;
  kind: string;
  range: StructureLineRange;
  signature: StructureLineRange;
  children?: StructureSymbol[];
}

export interface StructureOutlineRequest {
  path: string;
  languageId: string | null;
  text: string;
  revision: string;
  workspaceId?: string;
  sessionId?: string;
  inputContext?: AgentInputContext;
  signal?: AbortSignal;
  /** Hit lines used to detect an uncovered gap before consulting a later provider. */
  hitLines?: number[];
  /**
   * When true, a provider that would start a cold language-server session
   * must return `unavailable` instead (D-099).
   */
  warmOnly?: boolean;
}

export interface StructureOutlineResult {
  status: StructureStatus;
  provider: StructureProviderId | null;
  revision: string;
  symbols: StructureSymbol[];
  message?: string;
}

export interface StructureClassifyRequest extends StructureOutlineRequest {
  lines: number[];
}

export interface StructureClassifyResult {
  status: StructureStatus;
  provider: StructureProviderId | null;
  revision: string;
  hits: Array<{ line: number; class: StructureHitClass }>;
  incomplete?: boolean;
  message?: string;
}

export interface StructureLiteralCall {
  name: string;
  literal: string;
  line: number;
}

export interface StructureImport {
  source: string;
  line: number;
}

export interface StructureLiteralCallsResult {
  status: StructureStatus;
  provider: StructureProviderId | null;
  revision: string;
  calls: StructureLiteralCall[];
  incomplete?: boolean;
  message?: string;
}

export interface StructureImportsResult {
  status: StructureStatus;
  provider: StructureProviderId | null;
  revision: string;
  imports: StructureImport[];
  incomplete?: boolean;
  message?: string;
}

export interface StructureProvider {
  readonly id: StructureProviderId;
  capabilities(languageId: string | null): StructureCapabilities;
  outline(request: StructureOutlineRequest): Promise<StructureOutlineResult>;
  classifyHits(request: StructureClassifyRequest): Promise<StructureClassifyResult>;
  literalCalls(request: StructureOutlineRequest): Promise<StructureLiteralCallsResult>;
  imports(request: StructureOutlineRequest): Promise<StructureImportsResult>;
}

export interface StructureSource {
  outline(request: StructureOutlineRequest): Promise<StructureOutlineResult>;
  classifyHits(request: StructureClassifyRequest): Promise<StructureClassifyResult>;
  literalCalls(request: StructureOutlineRequest): Promise<StructureLiteralCallsResult>;
  imports(request: StructureOutlineRequest): Promise<StructureImportsResult>;
}

export const NO_STRUCTURE_CAPABILITIES: StructureCapabilities = {
  outline: false,
  classifyHits: false,
  literalCalls: false,
  imports: false,
};

export function unsupportedResult(
  provider: StructureProviderId | null,
  revision: string,
  message: string,
): StructureOutlineResult {
  return { status: "unsupported", provider, revision, symbols: [], message };
}
