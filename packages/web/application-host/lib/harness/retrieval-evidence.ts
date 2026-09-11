import {
  DEFAULT_HARNESS_SETTINGS,
  type RetrievalAttempt,
  type RetrievalEvidence,
  type RetrievalFact,
  type RetrievalFactSource,
  type RetrievalOutputRef,
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

const storeLargeExcerpt = (
  text: string,
  visibleBytes: number,
  outputStore: OutputStore | undefined,
  sessionId: string,
): RetrievalOutputRef | undefined => {
  if (!outputStore || Buffer.byteLength(text, "utf8") <= visibleBytes) return undefined;
  return outputStore.store(sessionId, text, "retrieval").ref;
};

const validateOutputRef = (
  ref: RetrievalOutputRef | undefined,
  outputStore: OutputStore | undefined,
  sessionId: string,
): { ok: true } | { ok: false; reason: string } => {
  if (!ref) return { ok: false, reason: "output source is missing a handle" };
  if (!outputStore) return { ok: false, reason: "output store is unavailable" };
  const read = outputStore.read(sessionId, ref.handle);
  if (read.status === "ready") return { ok: true };
  return { ok: false, reason: `output handle is ${read.status}` };
};

export async function validateRetrievalEvidence(
  input: RetrievalEvidenceValidationInput,
): Promise<RetrievalEvidence> {
  const attempted: RetrievalAttempt[] = [...(input.attempted ?? [])];
  const unknowns = [...(input.unknowns ?? [])];
  const facts: RetrievalFact[] = [];
  const visibleBytes = input.visibleBytes ?? DEFAULT_HARNESS_SETTINGS.output.visibleBytes;
  const question = input.question.trim() || input.brief;

  for (const raw of input.facts) {
    const claim = raw.claim.trim();
    if (!claim) {
      unknowns.push("a submitted fact had an empty claim");
      continue;
    }
    const sources: RetrievalFactSource[] = [];
    let status: RetrievalFact["status"] = "unknown";
    let rejected = false;

    for (const source of raw.sources) {
      if (source.kind === "url") {
        const url = source.url?.trim() ?? "";
        if (!HTTP_URL.test(url)) {
          status = status === "verified" ? status : "unknown";
          unknowns.push(`${claim}: URL is missing or is not http(s)`);
          continue;
        }
        const storedRef = source.outputRef;
        const refCheck = storedRef
          ? validateOutputRef(storedRef, input.outputStore, input.sessionId)
          : null;
        if (storedRef && refCheck?.ok) {
          sources.push({ kind: "url", url, outputRef: storedRef });
          if (status !== "unavailable") status = "verified";
          continue;
        }
        sources.push({ kind: "url", url });
        if (status !== "verified") status = "unknown";
        unknowns.push(`${claim}: URL was not stored as independently fetched material`);
        continue;
      }

      if (source.kind === "output") {
        const storedRef = source.outputRef;
        const refCheck = validateOutputRef(storedRef, input.outputStore, input.sessionId);
        if (!storedRef || !refCheck.ok) {
          if (status !== "verified") status = "unavailable";
          attempted.push({
            action: `output ${storedRef?.handle ?? "?"}`,
            outcome: "unavailable",
            detail: refCheck.ok ? "output source is missing a handle" : refCheck.reason,
          });
          continue;
        }
        sources.push({ kind: "output", outputRef: storedRef });
        if (status !== "unavailable") status = "verified";
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
        sources.push({ kind: "local", path: authorized.path });
        if (status !== "verified") status = "unavailable";
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
        if (status !== "verified") status = snapshot.status === "unavailable" ? "unavailable" : "unknown";
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
        sources.push({
          kind: "local",
          path: authorized.path,
          revision: snapshot.revision,
          origin: snapshot.source,
        });
        if (status !== "verified") status = "unknown";
        unknowns.push(`${claim}: ${authorized.path} is missing a compact line range`);
        continue;
      }
      const startLine = source.startLine;
      const endLine = source.endLine;
      const total = lineCount(snapshot.content);
      if (endLine > total) {
        sources.push({
          kind: "local",
          path: authorized.path,
          startLine,
          endLine,
          revision: snapshot.revision,
          origin: snapshot.source,
        });
        if (status !== "verified") status = "unknown";
        unknowns.push(`${claim}: ${authorized.path}:${startLine}-${endLine} is outside the file (${total} lines)`);
        continue;
      }
      const excerpt = excerptFor(snapshot.content, startLine, endLine);
      const outputRef = storeLargeExcerpt(excerpt, visibleBytes, input.outputStore, input.sessionId);
      sources.push({
        kind: "local",
        path: authorized.path,
        startLine,
        endLine,
        revision: snapshot.revision,
        origin: snapshot.source,
        ...(outputRef ? { outputRef } : {}),
      });
      if (status !== "unavailable") status = "verified";
    }

    if (rejected && sources.length === 0) continue;
    if (sources.length === 0 && !rejected) {
      unknowns.push(`${claim}: no usable sources`);
      continue;
    }
    if (sources.length === 0) continue;
    facts.push({ claim, status, sources });
  }

  const verified = facts.filter((fact) => fact.status === "verified").length;
  const unavailableOnly = facts.length > 0 && facts.every((fact) => fact.status === "unavailable");
  const completion = verified === 0 && unavailableOnly
    ? "unavailable" as const
    : verified > 0 && unknowns.length === 0 && attempted.length === 0 && facts.every((fact) => fact.status === "verified")
      ? "complete" as const
      : facts.length === 0 && unknowns.length === 0 && attempted.length === 0
        ? "incomplete" as const
        : "partial" as const;

  return {
    question,
    scope: [...input.frozenScope],
    facts,
    unknowns,
    attempted,
    completion,
  };
}
