import { createHash } from "node:crypto";
import {
  DEFAULT_HARNESS_SETTINGS,
  type RetrievalAttempt,
  type RetrievalArtifactRef,
  type RetrievalEvidence,
  type RetrievalFact,
  type RetrievalFactSource,
  type RetrievalOutputRef,
  type RetrievalSourceCheck,
  type RetrievalUrlReceipt,
  type ThreadFactsSetParams,
} from "@piarium/protocol";
import { parseThreadScopePath, scopePathContainedBy } from "./thread-nesting.js";
import type { ExploreFileReader } from "./explore-file-reader.js";
import type { OutputStore } from "./output-store.js";

const HTTP_URL = /^https?:\/\//i;

export interface RetrievalEvidenceValidationInput {
  question: string;
  facts: ThreadFactsSetParams["facts"];
  unknowns?: string[];
  attempted?: ThreadFactsSetParams["attempted"];
  frozenScope: readonly string[];
  actorScope?: readonly string[];
  brief: string;
  readFile?: ExploreFileReader;
  actor: Parameters<ExploreFileReader>[0];
  signal: AbortSignal;
  inputContext?: Parameters<ExploreFileReader>[3];
  outputStore?: OutputStore;
  sessionId: string;
  visibleBytes?: number;
  storeArtifact?: (bytes: Buffer) => Promise<RetrievalArtifactRef>;
  lookupReceipt?: (receiptId: string) => Promise<RetrievalUrlReceipt | null>;
}

const pathInScope = (path: string, scopes: readonly string[]): boolean => {
  if (scopes.length === 0) return true;
  return scopes.some((scope) => scopePathContainedBy(scope, path));
};

const authorizedPath = (
  path: string,
  frozenScope: readonly string[],
  actorScope?: readonly string[],
): { ok: true; path: string } | { ok: false; reason: string } => {
  const parsed = parseThreadScopePath(path);
  if (!parsed.ok) return { ok: false, reason: `path is outside the frozen thread scope: ${path}` };
  if (!pathInScope(parsed.path, frozenScope)) {
    return { ok: false, reason: `path is outside the frozen thread scope: ${parsed.path}` };
  }
  if (actorScope && actorScope.length > 0 && !pathInScope(parsed.path, actorScope)) {
    return { ok: false, reason: `path is outside the Run authorization: ${parsed.path}` };
  }
  return { ok: true, path: parsed.path };
};

const lineCount = (content: string): number => {
  if (content.length === 0) return 0;
  return content.split(/\r?\n/).length;
};

const excerptFor = (content: string, startLine: number, endLine: number): string => (
  content.split(/\r?\n/).slice(startLine - 1, endLine).join("\n")
);

const contentHashOf = (text: string): string => (
  `sha256-${createHash("sha256").update(text, "utf8").digest("hex")}`
);

const factStatusFrom = (checks: readonly RetrievalSourceCheck[]): RetrievalFact["status"] => {
  if (checks.includes("source-valid")) return "source-checked";
  if (checks.includes("unknown")) return "unknown";
  if (checks.length > 0 && checks.every((check) => check === "unavailable")) return "unavailable";
  return "unknown";
};

const readOutputText = (
  outputStore: OutputStore | undefined,
  sessionId: string,
  ref: RetrievalOutputRef | undefined,
): { ok: true; text: string } | { ok: false; reason: string } => {
  if (!ref) return { ok: false, reason: "output source is missing a handle" };
  if (!outputStore) return { ok: false, reason: "output store is unavailable" };
  const first = outputStore.read(sessionId, ref.handle, 0, 1);
  if (first.status !== "ready") return { ok: false, reason: `output handle is ${first.status}` };
  const full = outputStore.read(sessionId, ref.handle, 0, Math.max(first.slice.total, 1));
  if (full.status !== "ready") return { ok: false, reason: `output handle is ${full.status}` };
  return { ok: true, text: full.slice.text };
};

const persistExcerpt = async (
  text: string,
  visibleBytes: number,
  storeArtifact: RetrievalEvidenceValidationInput["storeArtifact"],
): Promise<{ contentHash: string; excerpt?: string; artifact?: RetrievalArtifactRef }> => {
  const contentHash = contentHashOf(text);
  const artifact = storeArtifact ? await storeArtifact(Buffer.from(text, "utf8")) : undefined;
  const excerpt = Buffer.byteLength(text, "utf8") <= visibleBytes ? text : undefined;
  return {
    contentHash,
    ...(excerpt !== undefined ? { excerpt } : {}),
    ...(artifact ? { artifact } : excerpt === undefined ? { excerpt: text } : {}),
  };
};

export async function validateRetrievalEvidence(
  input: RetrievalEvidenceValidationInput,
): Promise<RetrievalEvidence> {
  const attempted: RetrievalAttempt[] = [...(input.attempted ?? [])];
  const unknowns = [...(input.unknowns ?? [])];
  const facts: RetrievalFact[] = [];
  const visibleBytes = input.visibleBytes ?? DEFAULT_HARNESS_SETTINGS.output.visibleBytes;
  const question = input.brief.trim() || input.question.trim();

  for (const raw of input.facts) {
    const claim = raw.claim.trim();
    if (!claim) {
      unknowns.push("a submitted fact had an empty claim");
      continue;
    }
    const sources: RetrievalFactSource[] = [];
    const checks: RetrievalSourceCheck[] = [];
    let rejected = false;

    for (const source of raw.sources) {
      if (source.kind === "url") {
        const url = source.url?.trim() ?? "";
        if (!HTTP_URL.test(url)) {
          checks.push("unknown");
          sources.push({ kind: "url", url, check: "unknown" });
          unknowns.push(`${claim}: URL is missing or is not http(s)`);
          continue;
        }
        const receiptId = source.receiptId?.trim() ?? "";
        const receipt = receiptId && input.lookupReceipt
          ? await input.lookupReceipt(receiptId)
          : null;
        if (!receipt || receipt.receiptId !== receiptId || receipt.finalUrl !== url) {
          checks.push("unknown");
          sources.push({
            kind: "url",
            url,
            check: "unknown",
            ...(receiptId ? { receiptId } : {}),
          });
          unknowns.push(`${claim}: URL has no Host receipt bound to this exact final URL`);
          continue;
        }
        checks.push("source-valid");
        sources.push({
          kind: "url",
          url,
          check: "source-valid",
          receiptId: receipt.receiptId,
          contentHash: receipt.contentHash,
          revision: receipt.revision,
        });
        continue;
      }

      if (source.kind === "output") {
        const storedRef = source.outputRef;
        const read = readOutputText(input.outputStore, input.sessionId, storedRef);
        if (!read.ok) {
          checks.push("unavailable");
          attempted.push({
            action: `output ${storedRef?.handle ?? "?"}`,
            outcome: "unavailable",
            detail: read.reason,
          });
          continue;
        }
        const persisted = await persistExcerpt(read.text, visibleBytes, input.storeArtifact);
        checks.push("source-valid");
        sources.push({
          kind: "output",
          check: "source-valid",
          contentHash: persisted.contentHash,
          ...(persisted.excerpt !== undefined ? { excerpt: persisted.excerpt } : {}),
          ...(persisted.artifact ? { artifact: persisted.artifact } : {}),
        });
        continue;
      }

      const path = source.path?.trim() ?? "";
      const authorized = authorizedPath(path, input.frozenScope, input.actorScope);
      if (!authorized.ok) {
        rejected = true;
        attempted.push({ action: `read ${path || "(missing path)"}`, outcome: "rejected", detail: authorized.reason });
        continue;
      }
      if (!input.readFile) {
        checks.push("unavailable");
        sources.push({ kind: "local", path: authorized.path, check: "unavailable" });
        attempted.push({ action: `read ${authorized.path}`, outcome: "unavailable", detail: "document reader is not configured" });
        continue;
      }
      const snapshot = await input.readFile(
        input.actor,
        authorized.path,
        input.signal,
        input.inputContext ?? { source: "disk" },
      );
      if (snapshot.status === "forbidden") {
        rejected = true;
        attempted.push({ action: `read ${authorized.path}`, outcome: "rejected", detail: snapshot.message });
        continue;
      }
      if (snapshot.status !== "ready") {
        const check: RetrievalSourceCheck = snapshot.status === "unavailable" ? "unavailable" : "unknown";
        checks.push(check);
        sources.push({ kind: "local", path: authorized.path, check });
        if (snapshot.status === "unavailable" || snapshot.status === "failed") {
          attempted.push({ action: `read ${authorized.path}`, outcome: snapshot.status === "failed" ? "failed" : "unavailable", detail: snapshot.message });
        } else {
          unknowns.push(`${claim}: ${authorized.path} ${snapshot.message}`);
        }
        continue;
      }
      if (
        typeof source.startLine !== "number"
        || typeof source.endLine !== "number"
        || !Number.isSafeInteger(source.startLine)
        || !Number.isSafeInteger(source.endLine)
        || source.startLine < 1
        || source.endLine < source.startLine
      ) {
        checks.push("unknown");
        sources.push({
          kind: "local",
          path: authorized.path,
          check: "unknown",
          revision: snapshot.revision,
          origin: snapshot.source,
        });
        unknowns.push(`${claim}: ${authorized.path} is missing a compact line range`);
        continue;
      }
      const startLine = source.startLine;
      const endLine = source.endLine;
      const total = lineCount(snapshot.content);
      if (endLine > total) {
        checks.push("unknown");
        sources.push({
          kind: "local",
          path: authorized.path,
          startLine,
          endLine,
          check: "unknown",
          revision: snapshot.revision,
          origin: snapshot.source,
        });
        unknowns.push(`${claim}: ${authorized.path}:${startLine}-${endLine} is outside the file (${total} lines)`);
        continue;
      }
      const excerpt = excerptFor(snapshot.content, startLine, endLine);
      const persisted = await persistExcerpt(excerpt, visibleBytes, input.storeArtifact);
      checks.push("source-valid");
      sources.push({
        kind: "local",
        path: authorized.path,
        startLine,
        endLine,
        check: "source-valid",
        revision: snapshot.revision,
        origin: snapshot.source,
        contentHash: persisted.contentHash,
        ...(persisted.excerpt !== undefined ? { excerpt: persisted.excerpt } : {}),
        ...(persisted.artifact ? { artifact: persisted.artifact } : {}),
      });
    }

    if (rejected && sources.length === 0) continue;
    if (sources.length === 0 && !rejected) {
      unknowns.push(`${claim}: no usable sources`);
      continue;
    }
    if (sources.length === 0) continue;
    facts.push({ claim, status: factStatusFrom(checks), sources });
  }

  const unavailableOnly = facts.length > 0 && facts.every((fact) => fact.status === "unavailable");
  const completion = facts.length === 0 && unknowns.length === 0 && attempted.length === 0
    ? "incomplete" as const
    : unavailableOnly
      ? "unavailable" as const
      : "delivered" as const;

  return {
    question,
    scope: [...input.frozenScope],
    facts,
    unknowns,
    attempted,
    completion,
  };
}
