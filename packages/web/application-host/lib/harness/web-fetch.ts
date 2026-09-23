import type { FetchResult, HarnessWebDomainPolicy, RetrievalReceiptAuthority, RetrievalUrlReceipt, WebFetchRequest } from "@varin/protocol";
import { isSameHost } from "./ssrf-policy.js";
import { mintWebFetchReceipt, type WebFetchReceiptDraft } from "./web-fetch-receipt.js";
import type { WebMaterialStore } from "./web-materials.js";

export interface SsrfPolicy {
  check(url: string): Promise<{ blocked: boolean; reason?: "private-network" | "scheme" }>;
  isSameHost(url1: string, url2: string): boolean;
}

export type DomainPolicy = HarnessWebDomainPolicy;

export interface WebFetchDeps {
  ssrf: SsrfPolicy;
  domainPolicy?: (workspaceId: string) => DomainPolicy;
  renderer?: (url: string, signal?: AbortSignal) => Promise<string>;
  cacheTtlMs?: number;
  maxBytes?: number;
  persistReceipt?: (workspaceId: string, receipt: WebFetchReceiptDraft, markdown: string) => Promise<RetrievalUrlReceipt>;
  /** Durable snapshot store; when absent fetches still deliver content but mint no snapshotId. */
  materials?: Pick<WebMaterialStore, "put" | "read">;
}

interface CacheEntry {
  result: FetchResult;
  expiresAt: number;
}

interface FetchContext {
  workspaceId: string;
  authority: RetrievalReceiptAuthority;
  render?: boolean;
  domainPolicy?: DomainPolicy;
  signal?: AbortSignal;
  issueReceipt?: boolean;
}

interface SharedFetch {
  controller: AbortController;
  promise: Promise<FetchResult>;
  waiters: number;
  done: boolean;
}

const DEFAULT_CACHE_TTL_MS = 900_000; // 15 minutes
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_REDIRECTS = 5;
const EMPTY_SHELL_THRESHOLD = 200; // characters

export function createWebFetch(deps: WebFetchDeps) {
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const cache = new Map<string, CacheEntry>();
  const withReceipt = async (
    result: Extract<FetchResult, { status: "ok" }>,
    workspaceId: string,
    authority: RetrievalReceiptAuthority,
    issueReceipt: boolean,
  ): Promise<Extract<FetchResult, { status: "ok" }>> => {
    if (!issueReceipt || !deps.persistReceipt) return result;
    const draft = mintWebFetchReceipt(result.finalUrl, result.markdown, authority);
    try {
      const receipt = await deps.persistReceipt(workspaceId, draft, result.markdown);
      return { ...result, receipt };
    } catch {
      // Fetching content succeeded, but an unpersisted token must never become
      // source-check authority.
      return result;
    }
  };

  const checkDomainPolicy = (
    url: string,
    workspaceId: string,
    override?: DomainPolicy,
  ): { blocked: boolean; reason?: "domain-blocked" } => {
    const policy = override ?? deps.domainPolicy?.(workspaceId) ?? { block: [] };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { blocked: true };
    }
    const hostname = parsed.hostname.toLowerCase();

    // Block list
    if (policy.block.some((d) => hostname === d.toLowerCase() || hostname.endsWith(`.${d.toLowerCase()}`))) {
      return { blocked: true, reason: "domain-blocked" };
    }

    // Allow list (whitelist mode if non-empty)
    if (policy.allow !== undefined) {
      if (!policy.allow.some((d) => hostname === d.toLowerCase() || hostname.endsWith(`.${d.toLowerCase()}`))) {
        return { blocked: true, reason: "domain-blocked" };
      }
    }

    return { blocked: false };
  };

  const extractContent = async (html: string, contentType: string): Promise<{ markdown: string; title?: string }> => {
    // For text/* content, pass through directly
    if (contentType.startsWith("text/plain") || contentType.startsWith("text/csv") || contentType.startsWith("text/yaml")) {
      return { markdown: html };
    }

    // For HTML, use readability + turndown
    if (contentType.startsWith("text/html") || contentType.includes("xml")) {
      return await extractHtmlContent(html);
    }

    // For other content types, return raw
    return { markdown: html };
  };

  const extractHtmlContent = async (html: string): Promise<{ markdown: string; title?: string }> => {
    try {
      // linkedom provides a DOM implementation compatible with @mozilla/readability
      const { parseHTML } = await import("linkedom");
      const { document } = parseHTML(html);

      const { Readability } = await import("@mozilla/readability");
      const Turndown = (await import("turndown")).default;

      const reader = new Readability(document);
      const article = reader.parse();

      if (!article) {
        const text = html.replace(/<[^>]*>/g, "").trim();
        return { markdown: text };
      }

      const turndown = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced" });
      const markdown = turndown.turndown(article.content || html);
      const title = article.title ?? undefined;
      return { markdown, ...(title !== undefined ? { title } : {}) };
    } catch {
      // Fallback: strip HTML tags
      const text = html.replace(/<[^>]*>/g, "").trim();
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const title = titleMatch?.[1]?.trim();
      return { markdown: text, ...(title !== undefined ? { title } : {}) };
    }
  };

  const awaitAbortable = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => reject(signal.reason ?? new DOMException("Web fetch aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };

  const extractPdfText = async (data: ArrayBuffer, signal?: AbortSignal): Promise<string> => {
    try {
      signal?.throwIfAborted();
      // pdfjs-dist is loaded dynamically to avoid bundling it on non-PDF paths
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const loading = pdfjs.getDocument({ data });
      const doc = signal ? await awaitAbortable(loading.promise, signal) : await loading.promise;
      const pages: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        signal?.throwIfAborted();
        const pagePromise = doc.getPage(i);
        const page = signal ? await awaitAbortable(pagePromise, signal) : await pagePromise;
        signal?.throwIfAborted();
        const contentPromise = page.getTextContent();
        const content = signal ? await awaitAbortable(contentPromise, signal) : await contentPromise;
        const text = content.items
          .map((item) => item.str ?? "")
          .join(" ");
        pages.push(text);
      }
      return pages.join("\n\n");
    } catch {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Web fetch aborted", "AbortError");
      }
      return "[PDF text extraction failed]";
    }
  };

  const detectEmptyShell = (html: string, markdown: string, render: boolean): boolean => {
    if (render) return false;
    if (markdown.length >= EMPTY_SHELL_THRESHOLD) return false;
    // Check if original HTML has script tags but very little content
    return html.includes("<script") && markdown.trim().length < EMPTY_SHELL_THRESHOLD;
  };

  const representationFor = (contentType: string, rendered: boolean, pdf: boolean): string => (
    pdf
      ? "pdf-text"
      : rendered
        ? "rendered-readability-markdown"
        : contentType.startsWith("text/html") || contentType.includes("xml")
          ? "readability-markdown"
          : "raw-text"
  );

  const attachSnapshot = async (
    content: Extract<FetchResult, { status: "ok" }>,
    ctx: FetchContext,
    pdf = false,
  ): Promise<Extract<FetchResult, { status: "ok" }>> => {
    if (!deps.materials || content.snapshot) return content;
    try {
      const snapshot = await deps.materials.put(
        ctx.workspaceId,
        {
          sourceUrl: content.url,
          finalUrl: content.finalUrl,
          ...(content.contentType ? { contentType: content.contentType } : {}),
          ...(content.title ? { title: content.title } : {}),
          representation: representationFor(content.contentType, content.rendered, pdf),
          ...(content.rendered ? { rendered: true } : {}),
        },
        Buffer.from(content.markdown, "utf8"),
        ctx.authority,
      );
      return { ...content, snapshot };
    } catch {
      // Snapshot persistence must never fail a body that was fetched
      // successfully; the result is delivered without a snapshotId.
      return content;
    }
  };

  // One in-flight fetch per (url, render, policy) key. Each caller waits with
  // its own cancellation; when the last waiter leaves before the task
  // settles, the underlying request is aborted.
  const inflight = new Map<string, SharedFetch>();

  const joinShared = (shared: SharedFetch, signal: AbortSignal | undefined): Promise<FetchResult> => {
    shared.waiters += 1;
    let left = false;
    const leave = (): void => {
      if (left) return;
      left = true;
      shared.waiters -= 1;
      if (shared.waiters <= 0 && !shared.done) shared.controller.abort();
    };
    if (!signal) return shared.promise.finally(leave);
    if (signal.aborted) {
      leave();
      return Promise.reject(signal.reason ?? new DOMException("Web fetch aborted", "AbortError"));
    }
    return new Promise<FetchResult>((resolve, reject) => {
      const onAbort = (): void => {
        leave();
        reject(signal.reason ?? new DOMException("Web fetch aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      shared.promise.then(
        (value) => { leave(); resolve(value); },
        (error) => { leave(); reject(error); },
      ).finally(() => signal.removeEventListener("abort", onAbort));
    });
  };

  const performFetch = async (url: string, ctx: FetchContext): Promise<FetchResult> => {
    const cacheKey = `${url}:${ctx.render ?? false}`;
    const finishOk = async (
      content: Extract<FetchResult, { status: "ok" }>,
      pdf = false,
    ): Promise<FetchResult> => {
      const result = await attachSnapshot(content, ctx, pdf);
      cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
      return result;
    };

    // Fetch with redirect handling
    let currentUrl = url;
    let redirectCount = 0;

    while (redirectCount < MAX_REDIRECTS) {
      const redirectDomainCheck = checkDomainPolicy(currentUrl, ctx.workspaceId, ctx.domainPolicy);
      if (redirectDomainCheck.blocked) return { status: "blocked", url: currentUrl, reason: "domain-blocked" };
      const redirectSsrfCheck = await deps.ssrf.check(currentUrl);
      if (redirectSsrfCheck.blocked) {
        return { status: "blocked", url: currentUrl, reason: redirectSsrfCheck.reason ?? "private-network" };
      }
      let response: Response;
      const controller = new AbortController();
      const abortFromCaller = (): void => controller.abort(ctx.signal?.reason);
      if (ctx.signal?.aborted) controller.abort(ctx.signal.reason);
      else ctx.signal?.addEventListener("abort", abortFromCaller, { once: true });
      const timeout = setTimeout(() => controller.abort(), 20_000);
      const finishRequest = (): void => {
        clearTimeout(timeout);
        ctx.signal?.removeEventListener("abort", abortFromCaller);
      };
      try {
        response = await fetch(currentUrl, {
          signal: controller.signal,
          redirect: "manual", // Handle redirects manually for cross-host detection
          headers: { "User-Agent": "Varin-Agent/1.0" },
        });
      } catch (error) {
        if (ctx.signal?.aborted) {
          finishRequest();
          throw ctx.signal.reason ?? new DOMException("Web fetch aborted", "AbortError");
        }
        const result: FetchResult = {
          status: "failed",
          url,
          reason: error instanceof Error ? error.message : "fetch failed",
        };
        if (!ctx.signal?.aborted) cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
        finishRequest();
        return result;
      }

      try {
      // Handle redirects
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          finishRequest();
          return { status: "failed", url, reason: "redirect without location" };
        }
        const redirectUrl = new URL(location, currentUrl).href;
        if (!isSameHost(currentUrl, redirectUrl)) {
          // Cross-host redirect — don't follow, return metadata
          finishRequest();
          return {
            status: "redirect-cross-host",
            url,
            location: redirectUrl,
            statusCode: response.status,
          };
        }
        // Same-host redirect — follow
        currentUrl = redirectUrl;
        redirectCount++;
        finishRequest();
        continue;
      }

      if (!response.ok) {
        const result: FetchResult = {
          status: "failed",
          url,
          reason: `HTTP ${response.status}`,
        };
        cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
        finishRequest();
        return result;
      }

      // Success — extract content
      const contentType = response.headers.get("content-type") ?? "text/plain";
      const contentLength = Number(response.headers.get("content-length") ?? 0);

      // If render requested, use renderer
      if (ctx.render && deps.renderer) {
        try {
          const html = await awaitAbortable(deps.renderer(currentUrl, controller.signal), controller.signal);
          controller.signal.throwIfAborted();
          const { markdown, title } = await extractContent(html, "text/html");
          const content: Extract<FetchResult, { status: "ok" }> = {
            status: "ok",
            url,
            finalUrl: currentUrl,
            contentType,
            markdown,
            bytes: markdown.length,
            fromCache: false,
            rendered: true,
            ...(title ? { title } : {}),
          };
          finishRequest();
          return finishOk(content);
        } catch (error) {
          finishRequest();
          if (ctx.signal?.aborted) {
            throw ctx.signal.reason ?? new DOMException("Web fetch aborted", "AbortError");
          }
          return {
            status: "failed",
            url,
            reason: `renderer failed: ${error instanceof Error ? error.message : "unknown"}`,
          };
        }
      }

      // Check content type for PDF
      if (contentType.includes("application/pdf")) {
        const arrayBuffer = await awaitAbortable(response.arrayBuffer(), controller.signal);
        if (arrayBuffer.byteLength > maxBytes) {
          finishRequest();
          return {
            status: "failed",
            url,
            reason: `PDF exceeds max size (${arrayBuffer.byteLength} > ${maxBytes})`,
          };
        }
        const text = await extractPdfText(arrayBuffer, controller.signal);
        controller.signal.throwIfAborted();
        const content: Extract<FetchResult, { status: "ok" }> = {
          status: "ok",
          url,
          finalUrl: currentUrl,
          contentType,
          markdown: text,
          bytes: text.length,
          fromCache: false,
          rendered: false,
        };
        finishRequest();
        return finishOk(content, true);
      }

      // Read body with size limit
      let text: string;
      if (contentLength > maxBytes) {
        // Read only up to maxBytes
        const reader = response.body?.getReader();
        if (!reader) {
          finishRequest();
          return { status: "failed", url, reason: "no response body" };
        }
        const chunks: Uint8Array[] = [];
        let totalSize = 0;
        while (totalSize < maxBytes) {
          controller.signal.throwIfAborted();
          const { done, value } = await awaitAbortable(reader.read(), controller.signal);
          if (done) break;
          if (value) {
            chunks.push(value);
            totalSize += value.length;
          }
        }
        reader.cancel();
        const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        text = buffer.toString("utf-8");
      } else {
        text = await awaitAbortable(response.text(), controller.signal);
        if (text.length > maxBytes) {
          text = text.slice(0, maxBytes);
        }
      }

      // Extract content
      const { markdown, title } = await extractContent(text, contentType);
      controller.signal.throwIfAborted();

      // Check for empty shell
      if (detectEmptyShell(text, markdown, ctx.render ?? false)) {
        finishRequest();
        return {
          status: "empty-shell",
          url,
          hint: "page appears to be a JS-rendered app; retry with render: true on desktop",
        };
      }

      const content: Extract<FetchResult, { status: "ok" }> = {
        status: "ok",
        url,
        finalUrl: currentUrl,
        contentType,
        markdown,
        bytes: markdown.length,
        fromCache: false,
        rendered: false,
        ...(title ? { title } : {}),
      };
      finishRequest();
      return finishOk(content);
      } finally {
        finishRequest();
      }
    }

    // Too many redirects
    return { status: "failed", url, reason: "too many redirects" };
  };

  const policyKeyFor = (workspaceId: string, override?: DomainPolicy): string => {
    const policy = override ?? deps.domainPolicy?.(workspaceId) ?? { block: [] };
    return JSON.stringify({ allow: policy.allow ?? null, block: [...policy.block].sort() });
  };

  const readSnapshot = async (snapshotId: string, ctx: FetchContext): Promise<FetchResult> => {
    const found = deps.materials ? await deps.materials.read(ctx.workspaceId, snapshotId).catch(() => null) : null;
    if (!found) return { status: "snapshot-missing", snapshotId };
    // Re-reading stored material still passes the caller's current domain
    // policy — a snapshot is content, not a stored authorization.
    const policyCheck = checkDomainPolicy(found.ref.finalUrl, ctx.workspaceId, ctx.domainPolicy);
    if (policyCheck.blocked) {
      return { status: "blocked", url: found.ref.finalUrl, reason: "domain-blocked" };
    }
    const markdown = found.body.toString("utf8");
    return withReceipt({
      status: "ok",
      url: found.ref.sourceUrl,
      finalUrl: found.ref.finalUrl,
      contentType: found.ref.contentType ?? "text/markdown",
      ...(found.ref.title ? { title: found.ref.title } : {}),
      markdown,
      bytes: found.body.byteLength,
      fromCache: false,
      rendered: found.ref.rendered === true,
      snapshot: found.ref,
    }, ctx.workspaceId, ctx.authority, ctx.issueReceipt === true);
  };

  const fetchUrl = async (input: WebFetchRequest | string, ctx: FetchContext): Promise<FetchResult> => {
    const request: WebFetchRequest = typeof input === "string" ? { url: input } : input;
    const snapshotId = request.snapshotId?.trim();
    if (snapshotId) return readSnapshot(snapshotId, ctx);
    const url = request.url?.trim() ?? "";
    if (!url) return { status: "failed", url: "", reason: "url or snapshotId is required" };

    // Check domain policy
    const domainCheck = checkDomainPolicy(url, ctx.workspaceId, ctx.domainPolicy);
    if (domainCheck.blocked) {
      return { status: "blocked", url, reason: "domain-blocked" };
    }

    // Check SSRF
    const ssrfCheck = await deps.ssrf.check(url);
    if (ssrfCheck.blocked) {
      return { status: "blocked", url, reason: ssrfCheck.reason ?? "private-network" };
    }

    // If render requested but no renderer available
    if (ctx.render && !deps.renderer) {
      return { status: "renderer-unavailable", url };
    }

    // Cached bytes are reusable only after this workspace and request have
    // independently passed their current authorization policies.
    const cacheKey = `${url}:${ctx.render ?? false}`;
    if (!request.refresh) {
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        if (cached.result.status === "ok") {
          const { receipt: _oldReceipt, ...content } = cached.result;
          return withReceipt({ ...content, fromCache: true }, ctx.workspaceId, ctx.authority, ctx.issueReceipt === true);
        }
        return cached.result;
      }
    }

    const deliver = async (result: FetchResult): Promise<FetchResult> => (
      result.status === "ok"
        ? withReceipt(result, ctx.workspaceId, ctx.authority, ctx.issueReceipt === true)
        : result
    );

    // A refresh is intentionally a fresh request: it bypasses both the
    // response cache and in-flight sharing so it can mint a new snapshot.
    if (request.refresh) {
      return deliver(await performFetch(url, ctx));
    }

    const sharedKey = `${cacheKey}|${policyKeyFor(ctx.workspaceId, ctx.domainPolicy)}`;
    let shared = inflight.get(sharedKey);
    if (!shared || shared.done || shared.controller.signal.aborted) {
      const controller = new AbortController();
      const entry: SharedFetch = { controller, waiters: 0, done: false, promise: Promise.resolve({ status: "failed", url, reason: "unset" }) };
      entry.promise = performFetch(url, { ...ctx, signal: controller.signal })
        .finally(() => {
          entry.done = true;
          if (inflight.get(sharedKey) === entry) inflight.delete(sharedKey);
        });
      shared = entry;
      inflight.set(sharedKey, shared);
    }
    return deliver(await joinShared(shared, ctx.signal));
  };

  return {
    fetch: fetchUrl,
    cache,
    inflight,
  };
}
