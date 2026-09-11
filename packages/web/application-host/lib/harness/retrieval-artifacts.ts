import { createHash } from "node:crypto";
import type { RetrievalArtifactRef, RetrievalEvidence, RetrievalUrlReceipt } from "@piarium/protocol";
import { deleteObjectReferences, listObjectReferences, replaceObjectReferences } from "../recovery/journal-catalog.js";
import type { WorkspaceWorkingStateAccess } from "./working-state/working-state-store.js";

export const RETRIEVAL_EVIDENCE_OWNER_KIND = "retrieval-evidence";
export const WEB_FETCH_RECEIPT_OWNER_KIND = "web-fetch-receipt";

export const hashRetrievalText = (text: string): string => (
  `sha256-${createHash("sha256").update(text, "utf8").digest("hex")}`
);

export const collectRetrievalArtifactHashes = (evidence: RetrievalEvidence): string[] => {
  const hashes = new Set<string>();
  for (const fact of evidence.facts) {
    for (const source of fact.sources) {
      if (source.artifact?.hash) hashes.add(source.artifact.hash);
    }
  }
  return [...hashes].sort();
};

export const createRetrievalArtifactAccess = (workingStates: WorkspaceWorkingStateAccess) => {
  const storeArtifact = async (workspaceId: string, bytes: Buffer): Promise<RetrievalArtifactRef> => (
    workingStates.withStore(workspaceId, "retrieval-evidence-put", async (store) => {
      const object = await store.putObject(bytes);
      return { durability: "durable" as const, hash: object.hash, byteLength: object.byteLength };
    })
  );

  const readArtifact = async (workspaceId: string, hash: string): Promise<Buffer | null> => (
    workingStates.withStore(workspaceId, "retrieval-evidence-get", (store) => store.getObject(hash), "shared")
  );

  const protectEvidence = async (workspaceId: string, threadId: string, evidence: RetrievalEvidence): Promise<void> => (
    workingStates.withStore(workspaceId, "retrieval-evidence-protect", (_store, context) => {
      replaceObjectReferences(
        context.database,
        workspaceId,
        RETRIEVAL_EVIDENCE_OWNER_KIND,
        threadId,
        collectRetrievalArtifactHashes(evidence).map((objectHash, index) => ({
          slot: String(index),
          objectHash,
        })),
      );
    })
  );

  const releaseEvidence = async (workspaceId: string, threadId: string): Promise<void> => (
    workingStates.withStore(workspaceId, "retrieval-evidence-release", (_store, context) => {
      deleteObjectReferences(context.database, workspaceId, RETRIEVAL_EVIDENCE_OWNER_KIND, threadId);
    })
  );

  const persistReceipt = async (
    workspaceId: string,
    receipt: RetrievalUrlReceipt,
    markdown: string,
  ): Promise<void> => (
    workingStates.withStore(workspaceId, "web-fetch-receipt-put", async (store, context) => {
      const body = await store.putObject(Buffer.from(markdown, "utf8"));
      const meta = await store.putObject(Buffer.from(JSON.stringify({
        receiptId: receipt.receiptId,
        finalUrl: receipt.finalUrl,
        contentHash: receipt.contentHash,
        revision: receipt.revision,
        bodyHash: body.hash,
      }), "utf8"));
      replaceObjectReferences(context.database, workspaceId, WEB_FETCH_RECEIPT_OWNER_KIND, receipt.receiptId, [
        { slot: "meta", objectHash: meta.hash },
        { slot: "body", objectHash: body.hash },
      ]);
    })
  );

  const lookupReceipt = async (workspaceId: string, receiptId: string): Promise<RetrievalUrlReceipt | null> => (
    workingStates.withStore(workspaceId, "web-fetch-receipt-get", async (store, context) => {
      const refs = listObjectReferences(context.database, workspaceId, WEB_FETCH_RECEIPT_OWNER_KIND, receiptId);
      const metaRef = refs.find((ref) => ref.slot === "meta");
      if (!metaRef) return null;
      const bytes = await store.getObject(metaRef.objectHash);
      if (!bytes) return null;
      try {
        const parsed = JSON.parse(bytes.toString("utf8")) as Partial<RetrievalUrlReceipt>;
        if (
          typeof parsed.receiptId !== "string"
          || typeof parsed.finalUrl !== "string"
          || typeof parsed.contentHash !== "string"
          || typeof parsed.revision !== "string"
        ) {
          return null;
        }
        return {
          receiptId: parsed.receiptId,
          finalUrl: parsed.finalUrl,
          contentHash: parsed.contentHash,
          revision: parsed.revision,
        };
      } catch {
        return null;
      }
    }, "shared")
  );

  return {
    storeArtifact,
    readArtifact,
    protectEvidence,
    releaseEvidence,
    persistReceipt,
    lookupReceipt,
  };
};
