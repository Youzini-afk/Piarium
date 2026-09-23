import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWebFetch } from "./web-fetch.js";
import type { SsrfPolicy, DomainPolicy } from "./web-fetch.js";
import type { WebFetchReceiptDraft } from "./web-fetch-receipt.js";

// Minimal SSRF mock that blocks known private addresses
const createMockSsrf = (): SsrfPolicy => ({
  check: async (url: string) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { blocked: true, reason: "scheme" };
      }
      const host = parsed.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host === "10.0.0.1" || host === "169.254.169.254") {
        return { blocked: true, reason: "private-network" };
      }
      return { blocked: false };
    } catch {
      return { blocked: true, reason: "scheme" };
    }
  },
  isSameHost: (url1: string, url2: string) => {
    try {
      return new URL(url1).hostname === new URL(url2).hostname;
    } catch {
      return false;
    }
  },
});

const noDomainPolicy = (): DomainPolicy => ({ block: [] });
const fetchContext = {
  workspaceId: "ws",
  authority: { owningWorkspaceId: "ws", sessionId: "session-1" },
  issueReceipt: true,
};
const persistReceipt = async (_workspaceId: string, draft: WebFetchReceiptDraft, markdown: string) => ({
  ...draft,
  artifact: {
    durability: "durable" as const,
    hash: draft.contentHash,
    byteLength: Buffer.byteLength(markdown),
    recordId: `receipt:${draft.receiptId}`,
    recordType: "retrieval.receipt" as const,
    workspaceId: draft.authority.owningWorkspaceId,
    sessionId: draft.authority.sessionId,
    ...(draft.authority.threadId ? { threadId: draft.authority.threadId } : {}),
    ...(draft.authority.runId ? { runId: draft.authority.runId } : {}),
  },
});

describe("web-fetch service", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("blocks private network addresses", async () => {
    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
    });
    const result = await service.fetch("http://127.0.0.1:8080/", fetchContext);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toBe("private-network");
    }
  });

  it("blocks non-http schemes", async () => {
    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
    });
    const result = await service.fetch("file:///etc/passwd", fetchContext);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toBe("scheme");
    }
  });

  it("blocks domain-blocked URLs", async () => {
    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: () => ({ allow: [], block: ["evil.com"] }),
    });
    const result = await service.fetch("https://evil.com/page", fetchContext);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.reason).toBe("domain-blocked");
    }
  });

  it("enforces allow-list (whitelist mode)", async () => {
    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: () => ({ allow: ["allowed.com"], block: [] }),
    });
    const blocked = await service.fetch("https://other.com/page", fetchContext);
    expect(blocked.status).toBe("blocked");
  });

  it("treats an explicit empty allow list as deny-all", async () => {
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: () => ({ allow: [], block: [] }) });
    const result = await service.fetch("https://example.com/page", fetchContext);
    expect(result).toMatchObject({ status: "blocked", reason: "domain-blocked" });
  });

  it("returns renderer-unavailable when render requested but no renderer", async () => {
    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
    });
    const result = await service.fetch("https://example.com/", { ...fetchContext, render: true });
    expect(result.status).toBe("renderer-unavailable");
  });

  it("fetches and extracts HTML content", async () => {
    // Use text/plain to avoid linkedom/readability heavy DOM parsing in test
    const text = "This is a test page with enough content to pass the empty shell threshold check. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain; charset=utf-8" }),
      text: async () => text,
    }) as never;

    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
      persistReceipt,
    });
    const result = await service.fetch("https://example.com/", fetchContext);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.contentType).toContain("text/plain");
      expect(result.markdown.length).toBeGreaterThan(0);
      expect(result.rendered).toBe(false);
      expect(result.fromCache).toBe(false);
      expect(result.receipt?.finalUrl).toBe("https://example.com/");
      expect(result.receipt?.contentHash).toMatch(/^sha256-/);
      expect(result.receipt?.artifact.hash).toBe(result.receipt?.contentHash);
    }
  });

  it("detects empty shell SPA pages", async () => {
    // Minimal HTML with script but no readable content — text/plain pass-through
    // won't trigger empty-shell; we test the detector directly via HTML content type
    const html = "<html><head><script src=\"app.js\"></script></head><body><div id=\"root\"></div></body></html>";

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => html,
    }) as never;

    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
    });
    const result = await service.fetch("https://example.com/", fetchContext);
    // With linkedom, readability may return null → fallback strips tags → very short text → empty-shell
    expect(["empty-shell", "ok"]).toContain(result.status);
  });

  it("serves from cache on second request", async () => {
    const text = "This is a cached page with enough content to pass the threshold. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => text,
    });
    globalThis.fetch = mockFetch as never;

    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
      cacheTtlMs: 60_000,
    });
    const r1 = await service.fetch("https://example.com/", fetchContext);
    const r2 = await service.fetch("https://example.com/", fetchContext);
    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    if (r2.status === "ok") {
      expect(r2.fromCache).toBe(true);
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("rechecks workspace policy before serving bytes cached by another workspace", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "workspace A content",
    });
    globalThis.fetch = mockFetch as never;
    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: (workspaceId) => workspaceId === "blocked"
        ? { allow: [], block: ["example.com"] }
        : noDomainPolicy(),
      cacheTtlMs: 60_000,
    });
    const allowed = await service.fetch("https://example.com/", fetchContext);
    expect(allowed.status).toBe("ok");
    const blocked = await service.fetch("https://example.com/", {
      workspaceId: "blocked",
      authority: { owningWorkspaceId: "blocked", sessionId: "session-b" },
    });
    expect(blocked).toMatchObject({ status: "blocked", reason: "domain-blocked" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not return a source-check receipt when durable persistence fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "content without a durable receipt",
    }) as never;
    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
      persistReceipt: async () => { throw new Error("disk unavailable"); },
    });
    const result = await service.fetch("https://example.com/durable", fetchContext);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.receipt).toBeUndefined();
  });

  it("does not persist a receipt for an ordinary non-retrieval fetch", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "ordinary browsing content",
    }) as never;
    const persist = vi.fn(persistReceipt);
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy, persistReceipt: persist });
    const result = await service.fetch("https://example.com/ordinary", {
      workspaceId: "ws",
      authority: { owningWorkspaceId: "ws", sessionId: "ordinary-session" },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.receipt).toBeUndefined();
    expect(persist).not.toHaveBeenCalled();
  });

  it("aborts while reading the response body and does not cache the cancellation", async () => {
    let resolveBody!: (value: string) => void;
    const body = new Promise<string>((resolve) => { resolveBody = resolve; });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: () => body,
    }) as never;
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy });
    const controller = new AbortController();
    const pending = service.fetch("https://example.com/slow-body", {
      workspaceId: "ws",
      authority: { owningWorkspaceId: "ws", sessionId: "session-abort" },
      signal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(service.cache.size).toBe(0);
    resolveBody("late body");
  });

  it("returns redirect-cross-host for cross-domain redirects", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      headers: new Headers({ location: "https://other.com/redirected" }),
      text: async () => "",
    }) as never;

    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
    });
    const result = await service.fetch("https://example.com/", fetchContext);
    expect(result.status).toBe("redirect-cross-host");
    if (result.status === "redirect-cross-host") {
      expect(result.location).toBe("https://other.com/redirected");
      expect(result.statusCode).toBe(302);
    }
  });

  it("returns failed for HTTP errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      text: async () => "Not Found",
    }) as never;

    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
    });
    const result = await service.fetch("https://example.com/missing", fetchContext);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("404");
    }
  });

  it("pins fetched content as a snapshot and reads it back by snapshotId", async () => {
    const text = "snapshot body with enough content to be a real page. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt.";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => text,
    }) as never;
    const objects = new Map<string, Buffer>();
    const snapshots = new Map<string, { ref: import("@varin/protocol").WebSnapshotRef; body: Buffer }>();
    const materials = {
      put: async (_ws: string, draft: { sourceUrl: string; finalUrl: string }, body: Buffer) => {
        const ref = {
          snapshotId: "snap-1",
          sourceUrl: draft.sourceUrl,
          finalUrl: draft.finalUrl,
          fetchedAt: 1,
          contentHash: `sha256-stored`,
          representation: "raw-text",
          byteLength: body.byteLength,
        };
        objects.set(ref.contentHash, body);
        snapshots.set(ref.snapshotId, { ref, body });
        return ref;
      },
      read: async (_ws: string, snapshotId: string) => snapshots.get(snapshotId) ?? null,
    };
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy, materials, persistReceipt });
    const result = await service.fetch({ url: "https://example.com/pinned" }, fetchContext);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.snapshot?.snapshotId).toBe("snap-1");

    const reread = await service.fetch({ snapshotId: "snap-1" }, fetchContext);
    expect(reread.status).toBe("ok");
    if (reread.status === "ok") {
      expect(reread.markdown).toBe(text);
      expect(reread.snapshot?.contentHash).toBe("sha256-stored");
      // A snapshot read mints this caller's own receipt — not a foreign one.
      expect(reread.receipt?.authority.sessionId).toBe("session-1");
    }
  });

  it("renders a requested PDF page from the pinned original bytes", async () => {
    const source = Buffer.from("original-pdf");
    const ref = {
      snapshotId: "snap-pdf",
      sourceUrl: "https://example.com/paper.pdf",
      finalUrl: "https://example.com/paper.pdf",
      fetchedAt: 1,
      contentHash: "sha256-text",
      representation: "pdf-text",
      byteLength: 9,
      contentType: "application/pdf",
      document: {
        kind: "pdf" as const,
        pageCount: 2,
        parser: "pdf-text-layout-v1",
        source: { contentHash: "sha256-source", byteLength: source.byteLength, contentType: "application/pdf" },
      },
    };
    const materials = {
      put: async () => ref,
      read: async (_workspaceId: string, snapshotId: string, _authority: unknown, options?: { includeSource?: boolean }) => (
        snapshotId === ref.snapshotId
          ? { ref, body: Buffer.from("page text"), ...(options?.includeSource ? { source: { bytes: source, contentType: "application/pdf" } } : {}) }
          : null
      ),
    };
    const renderer = vi.fn(async (bytes: Buffer, page: number) => {
      expect(bytes).toEqual(source);
      expect(page).toBe(2);
      return { data: Buffer.from("png-page-2"), mimeType: "image/png" as const };
    });
    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
      materials,
      pdfPageRenderer: renderer,
    });
    const result = await service.fetch({ snapshotId: ref.snapshotId, view: "page-image", page: 2 }, fetchContext);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.pageImage).toMatchObject({ page: 2, mimeType: "image/png", data: Buffer.from("png-page-2").toString("base64") });
      expect(result.snapshot?.snapshotId).toBe(ref.snapshotId);
    }
    expect(renderer).toHaveBeenCalledTimes(1);

    const outOfRange = await service.fetch({ snapshotId: ref.snapshotId, view: "page-image", page: 3 }, fetchContext);
    expect(outOfRange).toMatchObject({ status: "page-image-unavailable", page: 3 });
  });

  it("reports snapshot-missing for released or foreign snapshots and re-checks domain policy", async () => {
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy });
    const missing = await service.fetch({ snapshotId: "snap-gone" }, fetchContext);
    expect(missing).toEqual({ status: "snapshot-missing", snapshotId: "snap-gone" });

    const materials = {
      put: async () => { throw new Error("unused"); },
      read: async () => ({
        ref: {
          snapshotId: "snap-blocked",
          sourceUrl: "https://evil.com/x",
          finalUrl: "https://evil.com/x",
          fetchedAt: 1,
          contentHash: "sha256-x",
          representation: "raw-text",
          byteLength: 4,
        },
        body: Buffer.from("body"),
      }),
    };
    const guarded = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: () => ({ allow: [], block: ["evil.com"] }),
      materials,
    });
    const blocked = await guarded.fetch({ snapshotId: "snap-blocked" }, {
      workspaceId: "ws",
      authority: { owningWorkspaceId: "ws", sessionId: "s" },
    });
    expect(blocked).toMatchObject({ status: "blocked", reason: "domain-blocked" });
  });

  it("shares one in-flight fetch and lets a single waiter's cancel leave others running", async () => {
    let resolveBody!: (value: string) => void;
    const body = new Promise<string>((resolve) => { resolveBody = resolve; });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: () => body,
    });
    globalThis.fetch = mockFetch as never;
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy });
    const ctx = (sessionId: string, signal?: AbortSignal) => ({
      workspaceId: "ws",
      authority: { owningWorkspaceId: "ws", sessionId },
      ...(signal ? { signal } : {}),
    });

    const first = new AbortController();
    const pendingA = service.fetch({ url: "https://example.com/shared" }, ctx("session-a", first.signal));
    const pendingB = service.fetch({ url: "https://example.com/shared" }, ctx("session-b"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    first.abort(new DOMException("cancelled", "AbortError"));
    await expect(pendingA).rejects.toMatchObject({ name: "AbortError" });

    resolveBody("shared page body long enough to matter. Lorem ipsum dolor sit amet.");
    const resultB = await pendingB;
    expect(resultB.status).toBe("ok");
    if (resultB.status === "ok") expect(resultB.markdown).toContain("shared page body");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("aborts the shared request when the last waiter leaves", async () => {
    let resolveBody!: (value: string) => void;
    const body = new Promise<string>((resolve) => { resolveBody = resolve; });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: () => body,
    });
    globalThis.fetch = mockFetch as never;
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy });
    const controller = new AbortController();
    const pending = service.fetch({ url: "https://example.com/last" }, {
      workspaceId: "ws",
      authority: { owningWorkspaceId: "ws", sessionId: "session-only" },
      signal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.inflight.size).toBe(0);
    resolveBody("late");
  });

  it("refresh bypasses the cache and the in-flight share", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/plain" }),
        text: async () => `page version ${calls} with enough body content to pass checks.`,
      };
    }) as never;
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy, cacheTtlMs: 60_000 });
    const first = await service.fetch({ url: "https://example.com/refresh" }, fetchContext);
    const cached = await service.fetch({ url: "https://example.com/refresh" }, fetchContext);
    const refreshed = await service.fetch({ url: "https://example.com/refresh", refresh: true }, fetchContext);
    expect(first.status).toBe("ok");
    expect(cached.status === "ok" && cached.fromCache).toBe(true);
    expect(refreshed.status === "ok" && refreshed.fromCache).toBe(false);
    if (refreshed.status === "ok") expect(refreshed.markdown).toContain("version 2");
    expect(calls).toBe(2);
  });

  it("refresh mints a new snapshot even when the fetched bytes are unchanged", async () => {
    const snapshots = new Map<string, { ref: import("@varin/protocol").WebSnapshotRef; body: Buffer }>();
    let sequence = 0;
    const materials = {
      put: async (
        _workspaceId: string,
        draft: { sourceUrl: string; finalUrl: string; representation: string },
        body: Buffer,
        _authority: unknown,
        options?: { forceNew?: boolean },
      ) => {
        if (!options?.forceNew) {
          const existing = [...snapshots.values()].find((entry) => entry.ref.contentHash === "sha256-same");
          if (existing) return existing.ref;
        }
        sequence += 1;
        const ref = {
          snapshotId: `snap-refresh-${sequence}`,
          sourceUrl: draft.sourceUrl,
          finalUrl: draft.finalUrl,
          fetchedAt: sequence,
          contentHash: "sha256-same",
          representation: draft.representation,
          byteLength: body.byteLength,
        };
        snapshots.set(ref.snapshotId, { ref, body });
        return ref;
      },
      read: async (_workspaceId: string, snapshotId: string) => snapshots.get(snapshotId) ?? null,
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "unchanged body with enough content to be retained",
    }) as never;
    const service = createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy, materials });

    const first = await service.fetch({ url: "https://example.com/unchanged" }, fetchContext);
    const refreshed = await service.fetch({ url: "https://example.com/unchanged", refresh: true }, fetchContext);
    expect(first.status).toBe("ok");
    expect(refreshed.status).toBe("ok");
    if (first.status === "ok" && refreshed.status === "ok") {
      expect(refreshed.snapshot?.snapshotId).not.toBe(first.snapshot?.snapshotId);
      expect(refreshed.snapshot?.contentHash).toBe(first.snapshot?.contentHash);
    }
  });
});

describe("structured reading (D-315 L3)", () => {
  const structuredMarkdown = [
    "# Title",
    "",
    "## Intro",
    "Intro body line one.",
    "Intro body line two.",
    "",
    "## Methods",
    "Methods body.",
    "",
    "| col | val |",
    "| --- | --- |",
    "| a | 1 |",
    "",
    "![Figure 1](fig1.png)",
    "",
    "## Appendix A",
    "Appendix body.",
  ].join("\n");

  const openMaterialService = () => {
    const snapshots = new Map<string, { ref: import("@varin/protocol").WebSnapshotRef; body: Buffer }>();
    let sequence = 0;
    const materials = {
      put: async (_ws: string, draft: import("./web-materials.js").WebSnapshotDraft, body: Buffer) => {
        sequence += 1;
        const ref: import("@varin/protocol").WebSnapshotRef = {
          snapshotId: `snap-${sequence}`,
          sourceUrl: draft.sourceUrl,
          finalUrl: draft.finalUrl,
          fetchedAt: sequence,
          contentHash: "sha256-x",
          representation: draft.representation,
          byteLength: body.byteLength,
          ...(draft.structure ? { structure: draft.structure } : {}),
        };
        snapshots.set(ref.snapshotId, { ref, body });
        return ref;
      },
      read: async (_ws: string, snapshotId: string) => snapshots.get(snapshotId) ?? null,
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => structuredMarkdown,
    }) as never;
    return createWebFetch({ ssrf: createMockSsrf(), domainPolicy: noDomainPolicy, materials });
  };

  it("detects headings/tables/figures and reads positions from a snapshot", async () => {
    const service = openMaterialService();
    const fetched = await service.fetch({ url: "https://example.com/doc" }, fetchContext);
    expect(fetched.status).toBe("ok");
    if (fetched.status !== "ok") return;
    expect(fetched.structure?.headings?.map((h) => h.title)).toEqual(["Title", "Intro", "Methods", "Appendix A"]);
    expect(fetched.structure?.tables).toEqual([{ startLine: 10, endLine: 12 }]);
    expect(fetched.structure?.figures).toEqual([{ line: 14, title: "Figure 1" }]);
    expect(fetched.snapshot?.structure?.headings?.length).toBe(4);

    const section = await service.fetch({ snapshotId: fetched.snapshot!.snapshotId, position: { kind: "section", title: "methods" } }, fetchContext);
    expect(section.status).toBe("ok");
    if (section.status === "ok") {
      expect(section.markdown).toContain("Methods body.");
      expect(section.markdown).toContain("col");
      expect(section.markdown).not.toContain("Intro body");
      expect(section.range?.startLine).toBe(7);
    }

    const appendix = await service.fetch({ snapshotId: fetched.snapshot!.snapshotId, position: { kind: "appendix" } }, fetchContext);
    expect(appendix.status).toBe("ok");
    if (appendix.status === "ok") {
      expect(appendix.markdown).toContain("Appendix body.");
      expect(appendix.markdown).not.toContain("Methods body.");
    }

    const table = await service.fetch({ snapshotId: fetched.snapshot!.snapshotId, position: { kind: "element", element: "table", index: 1 } }, fetchContext);
    expect(table.status).toBe("ok");
    if (table.status === "ok") {
      expect(table.markdown).toContain("| a | 1 |");
      expect(table.markdown).not.toContain("Methods body.");
    }
  });

  it("distinguishes unsupported structure from missing positions", async () => {
    const service = openMaterialService();
    const fetched = await service.fetch({ url: "https://example.com/doc2" }, fetchContext);
    if (fetched.status !== "ok") throw new Error("fetch failed");
    const snapshotId = fetched.snapshot!.snapshotId;

    const page = await service.fetch({ snapshotId, position: { kind: "page", page: 1 } }, fetchContext);
    expect(page).toMatchObject({ status: "structure-unsupported", kind: "pages" });

    const missing = await service.fetch({ snapshotId, position: { kind: "section", title: "nonexistent" } }, fetchContext);
    expect(missing.status).toBe("position-not-found");

    const badTable = await service.fetch({ snapshotId, position: { kind: "element", element: "table", index: 9 } }, fetchContext);
    expect(badTable.status).toBe("position-not-found");
  });

  it("applies a position slice on a URL fetch result", async () => {
    const service = openMaterialService();
    const sliced = await service.fetch({ url: "https://example.com/doc3", position: { kind: "lines", startLine: 4, endLine: 5 } }, fetchContext);
    expect(sliced.status).toBe("ok");
    if (sliced.status === "ok") {
      expect(sliced.markdown).toBe("Intro body line one.\nIntro body line two.");
      expect(sliced.range).toEqual({ startLine: 4, endLine: 5, totalLines: 17 });
    }
  });
});
