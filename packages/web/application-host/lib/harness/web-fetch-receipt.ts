import { createHash } from "node:crypto";
import type { RetrievalUrlReceipt } from "@piarium/protocol";

export const mintWebFetchReceipt = (finalUrl: string, markdown: string): RetrievalUrlReceipt => {
  const contentHash = `sha256-${createHash("sha256").update(markdown, "utf8").digest("hex")}`;
  const receiptId = `web-${createHash("sha256").update(`${finalUrl}\n${contentHash}`).digest("hex")}`;
  return {
    receiptId,
    finalUrl,
    contentHash,
    revision: contentHash,
  };
};
