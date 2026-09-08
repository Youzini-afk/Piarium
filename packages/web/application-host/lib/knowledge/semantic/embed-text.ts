/**
 * Embedding text for one chunk. Body is first-class: path and signature are
 * decoration and must not crowd it out (design 6.1; AFT is the counterexample).
 */

export type EmbedTextParts = {
  documentId: string;
  parentName: string;
  parentSignature: string;
  docComments: string;
  body: string;
};

export type TokenCounter = (text: string) => number;

const joinParts = (parts: readonly string[]): string => parts.filter((part) => part.length > 0).join("\n");

/**
 * Keep the body. Add decoration only while the tokenizer still accepts the
 * result. Never shrink the body to make room for a path or signature.
 */
export function buildEmbedText(parts: EmbedTextParts, maxTokens: number, countTokens: TokenCounter): string {
  const body = parts.body;
  if (countTokens(body) > maxTokens) return body;
  const decoration: string[] = [];
  const tryKeep = (piece: string): void => {
    if (!piece) return;
    const next = joinParts([...decoration, piece, body]);
    if (countTokens(next) <= maxTokens) decoration.push(piece);
  };
  tryKeep(parts.parentSignature);
  tryKeep(parts.parentName);
  tryKeep(parts.docComments);
  tryKeep(parts.documentId);
  return joinParts([...decoration, body]);
}

export const splitSourceLines = (text: string): string[] => (
  text.split("\n").map((line) => line.replace(/\r$/u, ""))
);

export const textOfLines = (lines: readonly string[], startLine: number, endLine: number): string => (
  lines.slice(Math.max(0, startLine - 1), Math.max(0, endLine)).join("\n")
);
