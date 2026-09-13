import { createHash } from "node:crypto";
import type { RetrievalArtifactRef, RetrievalEvidence, RetrievalReceiptAuthority, RetrievalUrlReceipt, Thread } from "@piarium/protocol";
import type { WorkspaceWorkingStateAccess } from "./working-state/working-state-store.js";
import type { WebFetchReceiptDraft } from "./web-fetch-receipt.js";

export const RETRIEVAL_PENDING_EVIDENCE_OWNER_KIND = "retrieval-evidence-pending";
export const RETRIEVAL_SEALED_EVIDENCE_OWNER_KIND = "retrieval-evidence-sealed";
export const RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND = "retrieval-artifact-temporary";
export const WEB_FETCH_RECEIPT_OWNER_KIND = "web-fetch-receipt-temporary";

export const hashRetrievalText = (text: string): string => `sha256-${createHash("sha256").update(text, "utf8").digest("hex")}`;
const keyPart = (value: string): string => Buffer.from(value, "utf8").toString("base64url");
const authorityKey = (authority: RetrievalReceiptAuthority): string => [authority.owningWorkspaceId, authority.sessionId, authority.threadId ?? "", authority.runId ?? ""].map(keyPart).join(".");
const artifactRecordId = (authority: RetrievalReceiptAuthority | undefined, hash: string): string => `retrieval-artifact:${authority?.threadId ?? "unbound"}:${authority?.runId ?? "unbound"}:${hash}`;
const receiptRecordId = (authority: RetrievalReceiptAuthority, receiptId: string): string => `retrieval-receipt:${authorityKey(authority)}:${keyPart(receiptId)}`;
const evidenceRecordId = (kind: "pending" | "sealed", threadId: string, runId: string): string => `retrieval-evidence:${kind}:${threadId}:${runId}`;
const sameAuthority = (left: RetrievalReceiptAuthority, right: RetrievalReceiptAuthority): boolean => left.owningWorkspaceId === right.owningWorkspaceId && left.sessionId === right.sessionId && (left.threadId ?? "") === (right.threadId ?? "") && (left.runId ?? "") === (right.runId ?? "");
const hashesForEvidence = (evidence: RetrievalEvidence): string[] => [...new Set(evidence.facts.flatMap((fact) => fact.sources.flatMap((source) => source.artifact?.hash ? [source.artifact.hash] : [])))].sort();

type StoreLike = {
  putObject(bytes: Buffer): Promise<{ hash: string; byteLength: number }>;
  getObject(hash: string): Promise<Buffer | null>;
  getObjectSlice(hash: string, byteLength: number, offset: number, length: number): Promise<Buffer | null>;
  ownerIdForObject?(hash: string): string | undefined;
};
type ContextLike = { records: { get(id: string): Promise<any>; list(input: { recordType?: string }): Promise<any[]>; put(input: any): Promise<any>; release(operationId: string, recordId: string): Promise<any> } };
const withKernel = async <T>(workingStates: WorkspaceWorkingStateAccess, workspaceId: string, purpose: string, operation: (store: StoreLike, context: ContextLike) => Promise<T> | T): Promise<T> => workingStates.withStore(workspaceId, purpose, (store, context) => operation(store as unknown as StoreLike, context as unknown as ContextLike));

export const collectRetrievalArtifactHashes = hashesForEvidence;

export const createRetrievalArtifactAccess = (workingStates: WorkspaceWorkingStateAccess) => {
  const storeArtifact = async (workspaceId: string, bytes: Buffer, authority?: RetrievalReceiptAuthority): Promise<RetrievalArtifactRef> => withKernel(workingStates, workspaceId, "retrieval-evidence-put", async (store, context) => {
    const object = await store.putObject(bytes);
    const ownerId = store.ownerIdForObject?.(object.hash);
    await context.records.put({ operationId: `retrieval-artifact:${object.hash}`, recordId: artifactRecordId(authority, object.hash), recordType: "retrieval.artifact", state: authority ? "temporary" : "durable", ...(authority?.sessionId ? { sessionId: authority.sessionId } : {}), ...(authority?.threadId ? { threadId: authority.threadId } : {}), ...(authority?.runId ? { runId: authority.runId } : {}), payloadJson: JSON.stringify({ artifact: { durability: "durable", hash: object.hash, byteLength: object.byteLength }, authority: authority ?? null }), ownerIds: ownerId ? [ownerId] : [], references: [{ slot: "body", objectHash: object.hash }] });
    return { durability: "durable", hash: object.hash, byteLength: object.byteLength };
  });
  const readArtifact = async (workspaceId: string, hash: string): Promise<Buffer | null> => withKernel(workingStates, workspaceId, "retrieval-evidence-get", async (store, context) => { const records = await context.records.list({ recordType: "retrieval.artifact" }); return records.some((record) => record.references.some((reference: any) => reference.slot === "body" && reference.objectHash === hash)) ? store.getObject(hash) : null; });
  const readArtifactSlice = async (workspaceId: string, artifact: RetrievalArtifactRef, offset: number, length: number): Promise<Buffer | null> => withKernel(workingStates, workspaceId, "retrieval-evidence-slice", async (store, context) => { const records = await context.records.list({ recordType: "retrieval.artifact" }); return records.some((record) => record.references.some((reference: any) => reference.slot === "body" && reference.objectHash === artifact.hash)) ? store.getObjectSlice(artifact.hash, artifact.byteLength, offset, length) : null; });
  const persistReceipt = async (workspaceId: string, draft: WebFetchReceiptDraft, markdown: string): Promise<RetrievalUrlReceipt> => withKernel(workingStates, workspaceId, "web-fetch-receipt-put", async (store, context) => {
    if (draft.authority.owningWorkspaceId !== workspaceId) throw new Error("Web receipt authority does not match its owning workspace");
    const body = await store.putObject(Buffer.from(markdown, "utf8"));
    if (body.hash !== draft.contentHash || draft.revision !== draft.contentHash) throw new Error("Web receipt content identity does not match its durable body");
    const receipt: RetrievalUrlReceipt = { ...draft, artifact: { durability: "durable", hash: body.hash, byteLength: body.byteLength } };
    const meta = await store.putObject(Buffer.from(JSON.stringify(receipt), "utf8"));
    const owners = [store.ownerIdForObject?.(body.hash), store.ownerIdForObject?.(meta.hash)].filter((value): value is string => Boolean(value));
    await context.records.put({ operationId: `receipt:${receipt.receiptId}`, recordId: receiptRecordId(receipt.authority, receipt.receiptId), recordType: "retrieval.receipt", state: "temporary", sessionId: receipt.authority.sessionId, ...(receipt.authority.threadId ? { threadId: receipt.authority.threadId } : {}), ...(receipt.authority.runId ? { runId: receipt.authority.runId } : {}), payloadJson: JSON.stringify(receipt), ownerIds: owners, references: [{ slot: "body", objectHash: body.hash }, { slot: "meta", objectHash: meta.hash }] });
    return receipt;
  });
  const lookupReceipt = async (workspaceId: string, authority: RetrievalReceiptAuthority, receiptId: string): Promise<RetrievalUrlReceipt | null> => withKernel(workingStates, workspaceId, "web-fetch-receipt-get", async (store, context) => {
    const record = await context.records.get(receiptRecordId(authority, receiptId)); if (!record) return null;
    try { const parsed = JSON.parse(record.payloadJson) as RetrievalUrlReceipt; if (parsed.receiptId !== receiptId || !sameAuthority(parsed.authority, authority) || parsed.artifact?.hash !== record.references.find((item: any) => item.slot === "body")?.objectHash) return null; return await store.getObject(parsed.artifact.hash) === null ? null : parsed; } catch { return null; }
  });
  const putEvidence = async (kind: "pending" | "sealed", threadId: string, runId: string, evidence: RetrievalEvidence, context: ContextLike): Promise<void> => { const references = hashesForEvidence(evidence).map((objectHash) => ({ slot: objectHash, objectHash })); await context.records.put({ operationId: `evidence:${kind}:${threadId}:${runId}`, recordId: evidenceRecordId(kind, threadId, runId), recordType: `retrieval.evidence.${kind}`, state: kind, threadId, runId, payloadJson: JSON.stringify(evidence), references }); };
  const promotePendingEvidence = async (input: { workspaceId: string; threadId: string; runId: string; evidence: RetrievalEvidence; receiptAuthority: RetrievalReceiptAuthority }): Promise<void> => withKernel(workingStates, input.workspaceId, "retrieval-evidence-promote", async (_store, context) => { await putEvidence("pending", input.threadId, input.runId, input.evidence, context); for (const fact of input.evidence.facts) for (const source of fact.sources) if (source.kind === "url" && source.receiptId) await context.records.release(`receipt-release:${source.receiptId}`, receiptRecordId(input.receiptAuthority, source.receiptId)); });
  const syncThreadEvidence = async (workspaceId: string, thread: Thread): Promise<void> => withKernel(workingStates, workspaceId, "retrieval-evidence-reconcile-thread", async (_store, context) => { const pending = thread.pendingEvidence && thread.activeRunId ? evidenceRecordId("pending", thread.id, thread.activeRunId) : null; const sealedRunId = thread.report?.evidenceRunId ?? thread.activeRunId; const sealed = thread.report?.evidence && sealedRunId ? evidenceRecordId("sealed", thread.id, sealedRunId) : null; for (const record of await context.records.list({})) if ((record.recordType === "retrieval.evidence.pending" || record.recordType === "retrieval.evidence.sealed") && record.threadId === thread.id && record.recordId !== pending && record.recordId !== sealed) await context.records.release(`evidence-release:${record.recordId}`, record.recordId); if (thread.pendingEvidence && thread.activeRunId) await putEvidence("pending", thread.id, thread.activeRunId, thread.pendingEvidence, context); if (thread.report?.evidence && sealedRunId) await putEvidence("sealed", thread.id, sealedRunId, thread.report.evidence, context); });
  const releaseThreadEvidence = async (workspaceId: string, threadId: string): Promise<void> => withKernel(workingStates, workspaceId, "retrieval-evidence-release", async (_store, context) => { for (const record of await context.records.list({})) if ((record.recordType.startsWith("retrieval.evidence.") || record.recordType === "retrieval.artifact" || record.recordType === "retrieval.receipt") && (record.threadId === threadId || record.payloadJson.includes(threadId))) await context.records.release(`thread-release:${threadId}:${record.recordId}`, record.recordId); });
  const releaseReceiptAuthority = async (workspaceId: string, authority: RetrievalReceiptAuthority): Promise<void> => withKernel(workingStates, workspaceId, "web-fetch-receipt-release", async (_store, context) => { for (const record of await context.records.list({ recordType: "retrieval.receipt" })) if (record.sessionId === authority.sessionId && record.threadId === authority.threadId && record.runId === authority.runId) await context.records.release(`receipt-authority-release:${record.recordId}`, record.recordId); });
  const releaseTemporaryArtifacts = async (workspaceId: string, authority: RetrievalReceiptAuthority): Promise<void> => withKernel(workingStates, workspaceId, "retrieval-artifact-temporary-release", async (_store, context) => { for (const record of await context.records.list({ recordType: "retrieval.artifact" })) if (record.threadId === authority.threadId && record.runId === authority.runId) await context.records.release(`artifact-release:${record.recordId}`, record.recordId); });
  const reconcileWorkspaceEvidence = async (workspaceId: string, threads: readonly Thread[]): Promise<void> => { for (const thread of threads) await syncThreadEvidence(workspaceId, thread); };
  return { storeArtifact, readArtifact, readArtifactSlice, persistReceipt, lookupReceipt, promotePendingEvidence, syncThreadEvidence, releaseThreadEvidence, releaseReceiptAuthority, releaseTemporaryArtifacts, reconcileWorkspaceEvidence };
};
