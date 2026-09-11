import { createHash } from "node:crypto";
import type {
  RetrievalArtifactRef,
  RetrievalEvidence,
  RetrievalReceiptAuthority,
  RetrievalUrlReceipt,
  Thread,
} from "@piarium/protocol";
import { deleteObjectReferences, listObjectReferences, replaceObjectReferences } from "../recovery/journal-catalog.js";
import type { WorkspaceWorkingStateAccess } from "./working-state/working-state-store.js";
import type { WebFetchReceiptDraft } from "./web-fetch-receipt.js";

export const RETRIEVAL_PENDING_EVIDENCE_OWNER_KIND = "retrieval-evidence-pending";
export const RETRIEVAL_SEALED_EVIDENCE_OWNER_KIND = "retrieval-evidence-sealed";
export const RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND = "retrieval-artifact-temporary";
export const WEB_FETCH_RECEIPT_OWNER_KIND = "web-fetch-receipt-temporary";

export const hashRetrievalText = (text: string): string => (
  `sha256-${createHash("sha256").update(text, "utf8").digest("hex")}`
);

const keyPart = (value: string): string => Buffer.from(value, "utf8").toString("base64url");
const evidenceOwnerPrefix = (threadId: string): string => `${keyPart(threadId)}:`;
const pendingEvidenceOwnerId = (threadId: string, runId: string): string => (
  `${evidenceOwnerPrefix(threadId)}pending:${keyPart(runId)}`
);
const sealedEvidenceOwnerId = (threadId: string, runId: string): string => (
  `${evidenceOwnerPrefix(threadId)}sealed:${keyPart(runId)}`
);
const temporaryArtifactOwnerPrefix = (threadId: string, runId: string): string => (
  `${evidenceOwnerPrefix(threadId)}temporary:${keyPart(runId)}:`
);
const temporaryArtifactOwnerId = (threadId: string, runId: string, hash: string): string => (
  `${temporaryArtifactOwnerPrefix(threadId, runId)}${keyPart(hash)}`
);
const receiptAuthorityKey = (authority: RetrievalReceiptAuthority): string => [
  authority.owningWorkspaceId,
  authority.sessionId,
  authority.threadId ?? "",
  authority.runId ?? "",
].map(keyPart).join(".");
const receiptOwnerId = (authority: RetrievalReceiptAuthority, receiptId: string): string => (
  `${receiptAuthorityKey(authority)}:${keyPart(receiptId)}`
);
const receiptOwnerBelongsToThread = (ownerId: string, threadId: string): boolean => {
  const authorityKey = ownerId.split(":", 1)[0];
  if (!authorityKey) return false;
  const parts = authorityKey.split(".");
  return parts.length === 4 && parts[2] === keyPart(threadId);
};

export const collectRetrievalArtifactHashes = (evidence: RetrievalEvidence): string[] => {
  const hashes = new Set<string>();
  for (const fact of evidence.facts) {
    for (const source of fact.sources) {
      if (source.artifact?.hash) hashes.add(source.artifact.hash);
    }
  }
  return [...hashes].sort();
};

const evidenceReferences = (evidence: RetrievalEvidence) => (
  collectRetrievalArtifactHashes(evidence).map((objectHash, index) => ({ slot: String(index), objectHash }))
);

const sameAuthority = (left: RetrievalReceiptAuthority, right: RetrievalReceiptAuthority): boolean => (
  left.owningWorkspaceId === right.owningWorkspaceId
  && left.sessionId === right.sessionId
  && (left.threadId ?? "") === (right.threadId ?? "")
  && (left.runId ?? "") === (right.runId ?? "")
);

export const createRetrievalArtifactAccess = (workingStates: WorkspaceWorkingStateAccess) => {
  const storeArtifact = async (
    workspaceId: string,
    bytes: Buffer,
    authority?: RetrievalReceiptAuthority,
  ): Promise<RetrievalArtifactRef> => (
    workingStates.withStore(workspaceId, "retrieval-evidence-put", async (store, context) => {
      const object = await store.putObject(bytes);
      if (authority) {
        if (authority.owningWorkspaceId !== workspaceId || !authority.threadId || !authority.runId) {
          throw new Error("Retrieval artifact authority does not match an owning Thread Run");
        }
        replaceObjectReferences(
          context.database,
          workspaceId,
          RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND,
          temporaryArtifactOwnerId(authority.threadId, authority.runId, object.hash),
          [{ slot: "body", objectHash: object.hash }],
        );
      }
      return { durability: "durable" as const, hash: object.hash, byteLength: object.byteLength };
    })
  );

  const readArtifact = async (workspaceId: string, hash: string): Promise<Buffer | null> => (
    workingStates.withStore(workspaceId, "retrieval-evidence-get", (store) => store.getObject(hash), "shared")
  );

  const readArtifactSlice = async (
    workspaceId: string,
    artifact: RetrievalArtifactRef,
    offset: number,
    length: number,
  ): Promise<Buffer | null> => (
    workingStates.withStore(workspaceId, "retrieval-evidence-slice", (store) => (
      store.getObjectSlice(artifact.hash, artifact.byteLength, offset, length)
    ), "shared")
  );

  const persistReceipt = async (
    workspaceId: string,
    draft: WebFetchReceiptDraft,
    markdown: string,
  ): Promise<RetrievalUrlReceipt> => (
    workingStates.withStore(workspaceId, "web-fetch-receipt-put", async (store, context) => {
      if (draft.authority.owningWorkspaceId !== workspaceId) {
        throw new Error("Web receipt authority does not match its owning workspace");
      }
      const body = await store.putObject(Buffer.from(markdown, "utf8"));
      if (body.hash !== draft.contentHash || draft.revision !== draft.contentHash) {
        throw new Error("Web receipt content identity does not match its durable body");
      }
      const receipt: RetrievalUrlReceipt = {
        ...draft,
        artifact: { durability: "durable", hash: body.hash, byteLength: body.byteLength },
      };
      const meta = await store.putObject(Buffer.from(JSON.stringify(receipt), "utf8"));
      context.database.transaction(() => {
        replaceObjectReferences(
          context.database,
          workspaceId,
          WEB_FETCH_RECEIPT_OWNER_KIND,
          receiptOwnerId(receipt.authority, receipt.receiptId),
          [
            { slot: "meta", objectHash: meta.hash },
            { slot: "body", objectHash: body.hash },
          ],
        );
      }).immediate();
      return receipt;
    })
  );

  const lookupReceipt = async (
    workspaceId: string,
    authority: RetrievalReceiptAuthority,
    receiptId: string,
  ): Promise<RetrievalUrlReceipt | null> => (
    workingStates.withStore(workspaceId, "web-fetch-receipt-get", async (store, context) => {
      if (authority.owningWorkspaceId !== workspaceId) return null;
      const refs = listObjectReferences(
        context.database,
        workspaceId,
        WEB_FETCH_RECEIPT_OWNER_KIND,
        receiptOwnerId(authority, receiptId),
      );
      const metaRef = refs.find((ref) => ref.slot === "meta");
      const bodyRef = refs.find((ref) => ref.slot === "body");
      if (!metaRef || !bodyRef) return null;
      const bytes = await store.getObject(metaRef.objectHash);
      if (!bytes) return null;
      try {
        const parsed = JSON.parse(bytes.toString("utf8")) as RetrievalUrlReceipt;
        if (
          typeof parsed.receiptId !== "string"
          || typeof parsed.finalUrl !== "string"
          || typeof parsed.contentHash !== "string"
          || typeof parsed.revision !== "string"
          || !parsed.artifact
          || parsed.artifact.durability !== "durable"
          || typeof parsed.artifact.hash !== "string"
          || typeof parsed.artifact.byteLength !== "number"
          || !parsed.authority
          || !sameAuthority(parsed.authority, authority)
          || parsed.receiptId !== receiptId
          || parsed.artifact.hash !== bodyRef.objectHash
          || parsed.artifact.hash !== parsed.contentHash
          || parsed.revision !== parsed.contentHash
        ) return null;
        if (await store.getObject(parsed.artifact.hash) === null) return null;
        return parsed;
      } catch {
        return null;
      }
    }, "shared")
  );

  const promotePendingEvidence = async (input: {
    workspaceId: string;
    threadId: string;
    runId: string;
    evidence: RetrievalEvidence;
    receiptAuthority: RetrievalReceiptAuthority;
  }): Promise<void> => (
    workingStates.withStore(input.workspaceId, "retrieval-evidence-promote", (_store, context) => {
      context.database.transaction(() => {
        replaceObjectReferences(
          context.database,
          input.workspaceId,
          RETRIEVAL_PENDING_EVIDENCE_OWNER_KIND,
          pendingEvidenceOwnerId(input.threadId, input.runId),
          evidenceReferences(input.evidence),
        );
        for (const fact of input.evidence.facts) {
          for (const source of fact.sources) {
            if (source.kind === "url" && source.receiptId) {
              deleteObjectReferences(
                context.database,
                input.workspaceId,
                WEB_FETCH_RECEIPT_OWNER_KIND,
                receiptOwnerId(input.receiptAuthority, source.receiptId),
              );
            }
          }
        }
        const temporaryRows = context.database.prepare(`
          SELECT owner_id FROM object_references
          WHERE workspace_id = ? AND owner_kind = ?
        `).all(input.workspaceId, RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND) as Array<{ owner_id: string }>;
        const prefix = temporaryArtifactOwnerPrefix(input.threadId, input.runId);
        for (const row of temporaryRows) {
          if (row.owner_id.startsWith(prefix)) {
            deleteObjectReferences(
              context.database,
              input.workspaceId,
              RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND,
              row.owner_id,
            );
          }
        }
      }).immediate();
    })
  );

  const syncThreadEvidence = async (workspaceId: string, thread: Thread): Promise<void> => (
    workingStates.withStore(workspaceId, "retrieval-evidence-reconcile-thread", async (store, context) => {
      if (thread.workspaceId !== workspaceId) throw new Error("Thread evidence workspace mismatch");
      const desired = new Map<string, { kind: string; evidence: RetrievalEvidence }>();
      if (thread.pendingEvidence && thread.activeRunId) {
        desired.set(pendingEvidenceOwnerId(thread.id, thread.activeRunId), {
          kind: RETRIEVAL_PENDING_EVIDENCE_OWNER_KIND,
          evidence: thread.pendingEvidence,
        });
      }
      const sealedRunId = thread.report?.evidenceRunId ?? thread.activeRunId;
      if (thread.report?.evidence && sealedRunId) {
        desired.set(sealedEvidenceOwnerId(thread.id, sealedRunId), {
          kind: RETRIEVAL_SEALED_EVIDENCE_OWNER_KIND,
          evidence: thread.report.evidence,
        });
      }
      const receiptRows = context.database.prepare(`
        SELECT owner_id, object_hash FROM object_references
        WHERE workspace_id = ? AND owner_kind = ? AND slot = 'meta'
      `).all(workspaceId, WEB_FETCH_RECEIPT_OWNER_KIND) as Array<{ owner_id: string; object_hash: string }>;
      const staleReceiptOwners: string[] = [];
      for (const row of receiptRows) {
        const meta = await store.getObject(row.object_hash);
        if (!meta) {
          staleReceiptOwners.push(row.owner_id);
          continue;
        }
        try {
          const parsed = JSON.parse(meta.toString("utf8")) as Partial<RetrievalUrlReceipt>;
          if (parsed.authority?.threadId === thread.id && (
            thread.lifecycle !== "active"
            || !thread.activeRunId
            || parsed.authority.runId !== thread.activeRunId
          )) staleReceiptOwners.push(row.owner_id);
        } catch {
          staleReceiptOwners.push(row.owner_id);
        }
      }
      const temporaryRows = context.database.prepare(`
        SELECT owner_id FROM object_references
        WHERE workspace_id = ? AND owner_kind = ?
      `).all(workspaceId, RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND) as Array<{ owner_id: string }>;
      const activeTemporaryPrefix = thread.activeRunId
        ? temporaryArtifactOwnerPrefix(thread.id, thread.activeRunId)
        : null;
      const staleTemporaryOwners = temporaryRows
        .map((row) => row.owner_id)
        .filter((ownerId) => ownerId.startsWith(evidenceOwnerPrefix(thread.id))
          && (!activeTemporaryPrefix || !ownerId.startsWith(activeTemporaryPrefix)));
      context.database.transaction(() => {
        for (const kind of [RETRIEVAL_PENDING_EVIDENCE_OWNER_KIND, RETRIEVAL_SEALED_EVIDENCE_OWNER_KIND]) {
          const rows = context.database.prepare(`
            SELECT owner_id FROM object_references
            WHERE workspace_id = ? AND owner_kind = ?
          `).all(workspaceId, kind) as Array<{ owner_id: string }>;
          for (const row of rows) {
            if (row.owner_id.startsWith(evidenceOwnerPrefix(thread.id)) && !desired.has(row.owner_id)) {
              deleteObjectReferences(context.database, workspaceId, kind, row.owner_id);
            }
          }
        }
        for (const [ownerId, entry] of desired) {
          replaceObjectReferences(context.database, workspaceId, entry.kind, ownerId, evidenceReferences(entry.evidence));
        }
        for (const ownerId of staleReceiptOwners) {
          deleteObjectReferences(context.database, workspaceId, WEB_FETCH_RECEIPT_OWNER_KIND, ownerId);
        }
        for (const ownerId of staleTemporaryOwners) {
          deleteObjectReferences(context.database, workspaceId, RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND, ownerId);
        }
      }).immediate();
    })
  );

  const releaseThreadEvidence = async (workspaceId: string, threadId: string): Promise<void> => (
    workingStates.withStore(workspaceId, "retrieval-evidence-release", (_store, context) => {
      context.database.transaction(() => {
        for (const kind of [
          RETRIEVAL_PENDING_EVIDENCE_OWNER_KIND,
          RETRIEVAL_SEALED_EVIDENCE_OWNER_KIND,
          RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND,
        ]) {
          const rows = context.database.prepare(`
            SELECT owner_id FROM object_references
            WHERE workspace_id = ? AND owner_kind = ?
          `).all(workspaceId, kind) as Array<{ owner_id: string }>;
          for (const row of rows) {
            if (row.owner_id.startsWith(evidenceOwnerPrefix(threadId))) {
              deleteObjectReferences(context.database, workspaceId, kind, row.owner_id);
            }
          }
        }
        const receiptRows = context.database.prepare(`
          SELECT owner_id FROM object_references
          WHERE workspace_id = ? AND owner_kind = ?
        `).all(workspaceId, WEB_FETCH_RECEIPT_OWNER_KIND) as Array<{ owner_id: string }>;
        for (const row of receiptRows) {
          if (receiptOwnerBelongsToThread(row.owner_id, threadId)) {
            deleteObjectReferences(context.database, workspaceId, WEB_FETCH_RECEIPT_OWNER_KIND, row.owner_id);
          }
        }
      }).immediate();
    })
  );

  const releaseReceiptAuthority = async (
    workspaceId: string,
    authority: RetrievalReceiptAuthority,
  ): Promise<void> => (
    workingStates.withStore(workspaceId, "web-fetch-receipt-release", (_store, context) => {
      const prefix = `${receiptAuthorityKey(authority)}:`;
      const rows = context.database.prepare(`
        SELECT owner_id FROM object_references
        WHERE workspace_id = ? AND owner_kind = ?
      `).all(workspaceId, WEB_FETCH_RECEIPT_OWNER_KIND) as Array<{ owner_id: string }>;
      context.database.transaction(() => {
        for (const row of rows) {
          if (row.owner_id.startsWith(prefix)) {
            deleteObjectReferences(context.database, workspaceId, WEB_FETCH_RECEIPT_OWNER_KIND, row.owner_id);
          }
        }
      }).immediate();
    })
  );

  const releaseTemporaryArtifacts = async (
    workspaceId: string,
    authority: RetrievalReceiptAuthority,
  ): Promise<void> => {
    if (authority.owningWorkspaceId !== workspaceId || !authority.threadId || !authority.runId) return;
    await workingStates.withStore(workspaceId, "retrieval-artifact-temporary-release", (_store, context) => {
      const prefix = temporaryArtifactOwnerPrefix(authority.threadId!, authority.runId!);
      const rows = context.database.prepare(`
        SELECT owner_id FROM object_references
        WHERE workspace_id = ? AND owner_kind = ?
      `).all(workspaceId, RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND) as Array<{ owner_id: string }>;
      context.database.transaction(() => {
        for (const row of rows) {
          if (row.owner_id.startsWith(prefix)) {
            deleteObjectReferences(context.database, workspaceId, RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND, row.owner_id);
          }
        }
      }).immediate();
    });
  };

  const reconcileWorkspaceEvidence = async (workspaceId: string, threads: readonly Thread[]): Promise<void> => (
    workingStates.withStore(workspaceId, "retrieval-evidence-reconcile-workspace", async (store, context) => {
      const activeRetrievalRuns = new Map(
        threads
          .filter((thread) => thread.role === "retrieval" && thread.lifecycle === "active" && thread.activeRunId)
          .map((thread) => [thread.id, thread.activeRunId!] as const),
      );
      const receiptRows = context.database.prepare(`
        SELECT DISTINCT owner_id FROM object_references
        WHERE workspace_id = ? AND owner_kind = ?
      `).all(workspaceId, WEB_FETCH_RECEIPT_OWNER_KIND) as Array<{ owner_id: string }>;
      const staleReceiptOwners: string[] = [];
      for (const row of receiptRows) {
        const refs = listObjectReferences(
          context.database,
          workspaceId,
          WEB_FETCH_RECEIPT_OWNER_KIND,
          row.owner_id,
        );
        const metaRef = refs.find((ref) => ref.slot === "meta");
        const meta = metaRef ? await store.getObject(metaRef.objectHash) : null;
        if (!meta) {
          staleReceiptOwners.push(row.owner_id);
          continue;
        }
        try {
          const parsed = JSON.parse(meta.toString("utf8")) as Partial<RetrievalUrlReceipt>;
          const authority = parsed.authority;
          if (
            !authority
            || authority.owningWorkspaceId !== workspaceId
            || !authority.threadId
            || !authority.runId
            || activeRetrievalRuns.get(authority.threadId) !== authority.runId
          ) staleReceiptOwners.push(row.owner_id);
        } catch {
          staleReceiptOwners.push(row.owner_id);
        }
      }
      const temporaryRows = context.database.prepare(`
        SELECT DISTINCT owner_id FROM object_references
        WHERE workspace_id = ? AND owner_kind = ?
      `).all(workspaceId, RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND) as Array<{ owner_id: string }>;
      const activeTemporaryPrefixes = [...activeRetrievalRuns]
        .map(([threadId, runId]) => temporaryArtifactOwnerPrefix(threadId, runId));
      const staleTemporaryOwners = temporaryRows
        .map((row) => row.owner_id)
        .filter((ownerId) => !activeTemporaryPrefixes.some((prefix) => ownerId.startsWith(prefix)));
      context.database.transaction(() => {
        context.database.prepare(`
          DELETE FROM object_references
          WHERE workspace_id = ? AND owner_kind IN (?, ?)
        `).run(
          workspaceId,
          RETRIEVAL_PENDING_EVIDENCE_OWNER_KIND,
          RETRIEVAL_SEALED_EVIDENCE_OWNER_KIND,
        );
        for (const thread of threads) {
          if (thread.pendingEvidence && thread.activeRunId) {
            replaceObjectReferences(
              context.database,
              workspaceId,
              RETRIEVAL_PENDING_EVIDENCE_OWNER_KIND,
              pendingEvidenceOwnerId(thread.id, thread.activeRunId),
              evidenceReferences(thread.pendingEvidence),
            );
          }
          const sealedRunId = thread.report?.evidenceRunId ?? thread.activeRunId;
          if (thread.report?.evidence && sealedRunId) {
            replaceObjectReferences(
              context.database,
              workspaceId,
              RETRIEVAL_SEALED_EVIDENCE_OWNER_KIND,
              sealedEvidenceOwnerId(thread.id, sealedRunId),
              evidenceReferences(thread.report.evidence),
            );
          }
        }
        for (const ownerId of staleReceiptOwners) {
          deleteObjectReferences(context.database, workspaceId, WEB_FETCH_RECEIPT_OWNER_KIND, ownerId);
        }
        for (const ownerId of staleTemporaryOwners) {
          deleteObjectReferences(context.database, workspaceId, RETRIEVAL_TEMPORARY_ARTIFACT_OWNER_KIND, ownerId);
        }
      }).immediate();
    })
  );

  return {
    storeArtifact,
    readArtifact,
    readArtifactSlice,
    persistReceipt,
    lookupReceipt,
    promotePendingEvidence,
    syncThreadEvidence,
    releaseThreadEvidence,
    releaseReceiptAuthority,
    releaseTemporaryArtifacts,
    reconcileWorkspaceEvidence,
  };
};
