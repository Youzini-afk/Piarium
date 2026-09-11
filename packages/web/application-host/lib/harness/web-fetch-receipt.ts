import { createHash, randomUUID } from "node:crypto";
import type { RetrievalReceiptAuthority, RetrievalUrlReceipt } from "@piarium/protocol";

export type WebFetchReceiptDraft = Omit<RetrievalUrlReceipt, "artifact">;

export const mintWebFetchReceipt = (
  finalUrl: string,
  markdown: string,
  authority: RetrievalReceiptAuthority,
): WebFetchReceiptDraft => {
  const contentHash = `sha256-${createHash("sha256").update(markdown, "utf8").digest("hex")}`;
  const receiptId = `web-${randomUUID()}`;
  return {
    receiptId,
    finalUrl,
    contentHash,
    revision: contentHash,
    authority: { ...authority },
  };
};
