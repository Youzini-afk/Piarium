/**
 * D-315 / Stage L3: explicit material collections.
 *
 * A collection is a kernel record (`material.collection`) owned by the
 * caller's session or thread. Members reference material that already exists
 * — web snapshots, URLs fetched and pinned on add, or scholarly paper
 * identities — so no second body store is introduced. The record's object
 * references keep member snapshot bodies alive under the ordinary
 * keep-if-referenced rule; a `persisted` collection survives its owning
 * thread's lifecycle and stays readable workspace-wide.
 *
 * Collection-scoped search applies the collection boundary before recall:
 * only member bodies the caller's own authority can read are scanned.
 */
import { randomUUID } from "node:crypto";
import type {
  MaterialCollection,
  MaterialCollectionMember,
  MaterialCollectionSearchHit,
  MaterialCollectionSummary,
  MaterialGrant,
  MaterialsCollectionParams,
  MaterialsCollectionResult,
  RetrievalReceiptAuthority,
  WebSnapshotRef,
} from "@varin/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import { HarnessServiceError } from "./service-error.js";
import type { WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import { createWorkspaceOpSerializer, kernelContext, type KernelRecordContext } from "./retrieval-artifacts.js";
import type { WebMaterialStore } from "./web-materials.js";

export const MATERIAL_COLLECTION_RECORD_TYPE = "material.collection";
export const MATERIAL_GRANT_RECORD_TYPE = "material.grant";

type Authority = Pick<RetrievalReceiptAuthority, "owningWorkspaceId" | "sessionId" | "threadId">;

interface CollectionPayload {
  collectionId: string;
  name?: string;
  persisted: boolean;
  createdAt: number;
  updatedAt: number;
  members: MaterialCollectionMember[];
}

export interface MaterialCollectionsDeps {
  materials?: WebMaterialStore;
  /** Fetches and pins a URL through the full web.fetch authority path. */
  fetchUrl?: (params: { url: string }, ctx: HarnessServiceContext) => Promise<{
    status: string;
    snapshot?: WebSnapshotRef;
    finalUrl?: string;
    title?: string;
  }>;
  /** Resolves the session's bound thread so collections carry thread ownership. */
  resolveThreadId?: (sessionId: string) => Promise<string | undefined>;
  /** Root-task relationship check for cross-thread grants (parent/child/sibling). */
  threadsRelated?: (fromThreadId: string, toThreadId: string, workspaceId: string) => Promise<boolean>;
  now?: () => number;
  serializer?: ReturnType<typeof createWorkspaceOpSerializer>;
}

const recordIdFor = (collectionId: string): string => `material.collection:${collectionId}`;
const sameIds = (left: readonly string[], right: readonly string[]): boolean => (
  JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
);

const parsePayload = (payloadJson: string): CollectionPayload | null => {
  try {
    const value = JSON.parse(payloadJson) as CollectionPayload;
    if (!value || typeof value.collectionId !== "string" || !Array.isArray(value.members)) return null;
    return value;
  } catch {
    return null;
  }
};

const parseGrant = (payloadJson: string): MaterialGrant | null => {
  try {
    const value = JSON.parse(payloadJson) as MaterialGrant;
    if (!value || typeof value.grantId !== "string" || typeof value.toThreadId !== "string"
      || !Array.isArray(value.snapshotIds) || !Array.isArray(value.collectionIds)) return null;
    return value;
  } catch {
    return null;
  }
};

/** A caller may read: its own thread/session collections, persisted ones, or
 * collections covered by a live grant targeting the caller's thread. */
const collectionVisibleTo = (
  payload: CollectionPayload,
  record: { sessionId?: string; threadId?: string },
  authority: Authority | undefined,
  grantedCollectionIds?: ReadonlySet<string>,
): boolean => {
  if (payload.persisted) return true;
  if (!authority) return false;
  if (grantedCollectionIds?.has(payload.collectionId) && authority.threadId !== undefined) return true;
  if (record.threadId !== undefined) return record.threadId === authority.threadId;
  return record.sessionId === authority.sessionId && authority.threadId === undefined;
};

/** Mutating requires owning authority — persistence does not open writes. */
const collectionWritableBy = (
  record: { sessionId?: string; threadId?: string },
  authority: Authority | undefined,
): boolean => {
  if (!authority) return false;
  if (record.threadId !== undefined) return record.threadId === authority.threadId;
  return record.sessionId === authority.sessionId && authority.threadId === undefined;
};

export const createMaterialCollections = (
  workingStates: WorkspaceWorkingStateRootAccess,
  deps: MaterialCollectionsDeps = {},
) => {
  const now = deps.now ?? Date.now;
  const serializer = deps.serializer ?? createWorkspaceOpSerializer();
  const collections: HarnessService<"materials.collections"> = {
    handle: async (params: MaterialsCollectionParams, ctx: HarnessServiceContext): Promise<MaterialsCollectionResult> => {
      const workspaceId = ctx.workspaceId;
      if (!workspaceId) throw new HarnessServiceError("forbidden", "Material collections require an owning workspace");
      const threadId = await deps.resolveThreadId?.(ctx.sessionId);
      const authority: Authority = {
        owningWorkspaceId: workspaceId,
        sessionId: ctx.sessionId,
        ...(threadId ? { threadId } : {}),
      };

      /** Snapshot/collection ids a live grant makes readable for this caller's
       * thread. Grants authorize reads under the receiver's own authority —
       * they never carry over the sender's receipt or scope. */
      const grantsFor = async (context: KernelRecordContext): Promise<{
        snapshotIds: Set<string>;
        collectionIds: Set<string>;
      }> => {
        const snapshotIds = new Set<string>();
        const collectionIds = new Set<string>();
        if (!authority.threadId) return { snapshotIds, collectionIds };
        for (const record of await context.records.list({ recordType: MATERIAL_GRANT_RECORD_TYPE })) {
          if (record.state === "released") continue;
          const grant = parseGrant(record.payloadJson);
          if (!grant || grant.toThreadId !== authority.threadId) continue;
          for (const id of grant.snapshotIds) snapshotIds.add(id);
          for (const id of grant.collectionIds) collectionIds.add(id);
        }
        return { snapshotIds, collectionIds };
      };

      const readBodyHash = async (snapshotId: string): Promise<WebSnapshotRef | null> => {
        if (!deps.materials?.read) return null;
        const found = await deps.materials.read(workspaceId, snapshotId, authority).catch(() => null);
        return found?.ref ?? null;
      };

      const snapshotReferences = (members: MaterialCollectionMember[], bodies: Map<string, string>) => (
        members.flatMap((member) => {
          const hash = member.snapshotId ? bodies.get(member.snapshotId) : undefined;
          return hash ? [{ slot: `member:${member.memberId}`, objectHash: hash }] : [];
        })
      );

      const memberBodyHashes = async (members: MaterialCollectionMember[]): Promise<Map<string, string>> => {
        const map = new Map<string, string>();
        for (const member of members) {
          if (!member.snapshotId) continue;
          const ref = await readBodyHash(member.snapshotId);
          if (ref) map.set(member.snapshotId, ref.contentHash);
        }
        return map;
      };

      const writeCollection = async (
        context: KernelRecordContext,
        record: { recordId: string; recordRevision: number },
        payload: CollectionPayload,
      ): Promise<void> => {
        const bodies = await memberBodyHashes(payload.members);
        await context.records.put({
          operationId: `material-collection-put:${record.recordId}:${now()}`,
          recordId: record.recordId,
          recordType: MATERIAL_COLLECTION_RECORD_TYPE,
          state: "temporary",
          sessionId: authority.sessionId,
          ...(authority.threadId ? { threadId: authority.threadId } : {}),
          payloadJson: JSON.stringify(payload),
          references: snapshotReferences(payload.members, bodies),
          expectedRecordRevision: record.recordRevision,
        });
      };

      const loadCollection = async (
        context: KernelRecordContext,
        collectionId: string,
      ): Promise<{ record: NonNullable<Awaited<ReturnType<KernelRecordContext["records"]["get"]>>>; payload: CollectionPayload } | null> => {
        const record = await context.records.get(recordIdFor(collectionId));
        if (!record || record.recordType !== MATERIAL_COLLECTION_RECORD_TYPE || record.state === "released") return null;
        const payload = parsePayload(record.payloadJson);
        if (!payload) return null;
        return { record, payload };
      };

      return serializer.runSerialized(workspaceId, () => kernelContext(
        workingStates,
        workspaceId,
        "material-collections",
        async (_store, context) => {
          switch (params.action) {
            case "create": {
              const collectionId = `coll-${randomUUID()}`;
              const at = now();
              const payload: CollectionPayload = {
                collectionId,
                ...(params.name?.trim() ? { name: params.name.trim() } : {}),
                persisted: params.persist === true,
                createdAt: at,
                updatedAt: at,
                members: [],
              };
              await context.records.put({
                operationId: `material-collection-put:${collectionId}`,
                recordId: recordIdFor(collectionId),
                recordType: MATERIAL_COLLECTION_RECORD_TYPE,
                state: "temporary",
                sessionId: authority.sessionId,
                ...(authority.threadId ? { threadId: authority.threadId } : {}),
                payloadJson: JSON.stringify(payload),
                references: [],
              });
              return { status: "ok", collection: payload satisfies MaterialCollection };
            }
            case "list": {
              const grants = await grantsFor(context);
              const collections: MaterialCollectionSummary[] = [];
              for (const record of await context.records.list({ recordType: MATERIAL_COLLECTION_RECORD_TYPE })) {
                if (record.state === "released") continue;
                const payload = parsePayload(record.payloadJson);
                if (!payload || !collectionVisibleTo(payload, record, authority, grants.collectionIds)) continue;
                collections.push({
                  collectionId: payload.collectionId,
                  ...(payload.name ? { name: payload.name } : {}),
                  persisted: payload.persisted,
                  memberCount: payload.members.length,
                  updatedAt: payload.updatedAt,
                });
              }
              return { status: "ok", collections };
            }
            case "add": {
              const collectionId = params.collectionId?.trim();
              const member = params.member;
              if (!collectionId || !member) {
                throw new HarnessServiceError("invalid-params", "collection add requires collectionId and member");
              }
              const loaded = await loadCollection(context, collectionId);
              if (!loaded) return { status: "not-found", message: `collection not found: ${collectionId}` };
              if (!collectionWritableBy(loaded.record, authority)) {
                return { status: "denied", message: "collection is owned by another thread or session" };
              }
              const next: MaterialCollectionMember = {
                kind: member.kind,
                memberId: `mem-${randomUUID()}`,
                addedAt: now(),
                ...(member.snapshotId?.trim() ? { snapshotId: member.snapshotId.trim() } : {}),
                ...(member.url?.trim() ? { url: member.url.trim() } : {}),
                ...(member.paper ? { paper: member.paper } : {}),
                ...(member.role ? { role: member.role } : {}),
                ...(member.note?.trim() ? { note: member.note.trim() } : {}),
                ...(member.title?.trim() ? { title: member.title.trim() } : {}),
              };
              if (member.kind === "snapshot") {
                if (!next.snapshotId) throw new HarnessServiceError("invalid-params", "snapshot member requires snapshotId");
                // The caller must be able to read the snapshot under its own
                // authority — a foreign snapshot id alone is not a grant.
                const ref = await readBodyHash(next.snapshotId);
                if (!ref) return { status: "denied", message: `snapshot is not readable under this authority: ${next.snapshotId}` };
              } else if (member.kind === "url") {
                if (!next.url) throw new HarnessServiceError("invalid-params", "url member requires url");
                if (!deps.fetchUrl) return { status: "unavailable", message: "URL fetching is not wired for material collections" };
                const fetched = await deps.fetchUrl({ url: next.url }, ctx);
                if (fetched.status !== "ok" || !fetched.snapshot) {
                  return { status: "failed", message: `url could not be pinned as a snapshot (status ${fetched.status})` };
                }
                next.snapshotId = fetched.snapshot.snapshotId;
                if (fetched.finalUrl) next.url = fetched.finalUrl;
                const resolvedTitle = next.title ?? fetched.title ?? fetched.snapshot.title;
                if (resolvedTitle) next.title = resolvedTitle;
              } else if (member.kind === "paper") {
                if (!member.paper || !member.paper.provider.trim() || !member.paper.id.trim()) {
                  throw new HarnessServiceError("invalid-params", "paper member requires provider and id");
                }
              }
              loaded.payload.members.push(next);
              loaded.payload.updatedAt = now();
              await writeCollection(context, loaded.record, loaded.payload);
              return { status: "ok", member: next, collection: loaded.payload satisfies MaterialCollection };
            }
            case "remove": {
              const collectionId = params.collectionId?.trim();
              const memberId = params.memberId?.trim();
              if (!collectionId || !memberId) {
                throw new HarnessServiceError("invalid-params", "collection remove requires collectionId and memberId");
              }
              const loaded = await loadCollection(context, collectionId);
              if (!loaded) return { status: "not-found", message: `collection not found: ${collectionId}` };
              if (!collectionWritableBy(loaded.record, authority)) {
                return { status: "denied", message: "collection is owned by another thread or session" };
              }
              const index = loaded.payload.members.findIndex((member) => member.memberId === memberId);
              if (index < 0) return { status: "not-found", message: `member not found: ${memberId}` };
              loaded.payload.members.splice(index, 1);
              loaded.payload.updatedAt = now();
              await writeCollection(context, loaded.record, loaded.payload);
              return { status: "ok", collection: loaded.payload satisfies MaterialCollection };
            }
            case "search": {
              const collectionId = params.collectionId?.trim();
              const query = params.query?.trim();
              if (!collectionId || !query) {
                throw new HarnessServiceError("invalid-params", "collection search requires collectionId and query");
              }
              if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1)) {
                throw new HarnessServiceError("invalid-params", "collection search limit must be a positive integer");
              }
              const loaded = await loadCollection(context, collectionId);
              const grants = await grantsFor(context);
              if (!loaded || !collectionVisibleTo(loaded.payload, loaded.record, authority, grants.collectionIds)) {
                return { status: "not-found", message: `collection not found: ${collectionId}` };
              }
              // The collection boundary applies first: only member bodies are
              // scanned, each under the caller's own read authority.
              const hits: MaterialCollectionSearchHit[] = [];
              const unreadable: string[] = [];
              const needle = query.toLowerCase();
              for (const member of loaded.payload.members) {
                if (!member.snapshotId || !deps.materials?.read) continue;
                const found = await deps.materials.read(workspaceId, member.snapshotId, authority).catch(() => null);
                if (!found) {
                  unreadable.push(member.memberId);
                  continue;
                }
                const lines = found.body.toString("utf8").split(/\r?\n/);
                for (let index = 0; index < lines.length; index += 1) {
                  if (!lines[index]!.toLowerCase().includes(needle)) continue;
                  hits.push({
                    memberId: member.memberId,
                    snapshotId: member.snapshotId,
                    line: index + 1,
                    excerpt: lines[index]!.slice(0, 240),
                  });
                  if (params.limit !== undefined && hits.length >= params.limit) break;
                }
                if (params.limit !== undefined && hits.length >= params.limit) break;
              }
              return {
                status: "ok",
                hits,
                ...(unreadable.length ? { unreadable } : {}),
              };
            }
            case "share": {
              const targetThreadId = params.targetThreadId?.trim();
              const fromThreadId = authority.threadId;
              if (!targetThreadId || !fromThreadId) {
                throw new HarnessServiceError("invalid-params", "share requires targetThreadId and a thread-bound caller");
              }
              if (targetThreadId === fromThreadId) {
                throw new HarnessServiceError("invalid-params", "cannot grant material to the owning thread itself");
              }
              const snapshotIds: string[] = [];
              const collectionIds: string[] = [];
              if (params.collectionId?.trim()) {
                const loaded = await loadCollection(context, params.collectionId.trim());
                // Sharing requires readable access: the sender can only grant
                // what it can itself see under its own authority.
                const senderGrants = await grantsFor(context);
                if (!loaded || !collectionVisibleTo(loaded.payload, loaded.record, authority, senderGrants.collectionIds)) {
                  return { status: "not-found", message: `collection not found: ${params.collectionId}` };
                }
                collectionIds.push(loaded.payload.collectionId);
                for (const member of loaded.payload.members) {
                  if (member.snapshotId) snapshotIds.push(member.snapshotId);
                }
              } else if (params.snapshotId?.trim()) {
                snapshotIds.push(params.snapshotId.trim());
              } else {
                throw new HarnessServiceError("invalid-params", "share requires collectionId or snapshotId");
              }
              // The sender must actually be able to read each snapshot — a
              // grant never covers material outside the sender's own scope.
              for (const snapshotId of snapshotIds) {
                if (!await readBodyHash(snapshotId)) {
                  return { status: "denied", message: `snapshot is not readable under this authority: ${snapshotId}` };
                }
              }
              // Grants stay inside the root-task family — the same reachability
              // rule thread.send enforces (parent/child/sibling).
              if (!await deps.threadsRelated?.(fromThreadId, targetThreadId, workspaceId)) {
                return { status: "denied", message: `thread is outside the caller's root-task relationships: ${targetThreadId}` };
              }
              const grantId = `grant-${randomUUID()}`;
              const grant: MaterialGrant = {
                grantId,
                fromThreadId,
                toThreadId: targetThreadId,
                snapshotIds,
                collectionIds,
                createdAt: now(),
              };
              // Idempotent: an identical live grant is reused, not duplicated.
              for (const record of await context.records.list({ recordType: MATERIAL_GRANT_RECORD_TYPE })) {
                if (record.state === "released") continue;
                const existing = parseGrant(record.payloadJson);
                if (existing
                  && existing.fromThreadId === grant.fromThreadId
                  && existing.toThreadId === grant.toThreadId
                  && sameIds(existing.snapshotIds, grant.snapshotIds)
                  && sameIds(existing.collectionIds, grant.collectionIds)) {
                  return { status: "ok", grant: existing };
                }
              }
              await context.records.put({
                operationId: `material-grant-put:${grantId}`,
                recordId: `material.grant:${grantId}`,
                recordType: MATERIAL_GRANT_RECORD_TYPE,
                state: "temporary",
                sessionId: authority.sessionId,
                threadId: fromThreadId,
                payloadJson: JSON.stringify(grant),
                references: [],
              });
              return { status: "ok", grant };
            }
            default:
              throw new HarnessServiceError("invalid-params", `unknown collection action: ${params.action}`);
          }
        },
      ));
    },
  };
  return collections;
};
