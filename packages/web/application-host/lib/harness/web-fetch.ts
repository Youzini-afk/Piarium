import type { FetchResult } from "@piarium/protocol";
import { checkSsrf, isSameHost } from "./ssrf-policy.js";

export interface SsrfPolicy {
  check(url: string): Promise<{ blocked: boolean; reason?: "private-network" | "scheme" }>;
  isSameHost(url1: string, url2: string): boolean;
}

export interface DomainPolicy {
  allow: string[];
  block: string[];
}

export interface WebFetchDeps {
  ssrf: SsrfPolicy;
  domainPolicy: (workspaceId: string) => DomainPolicy;
  renderer?: (url: string) => Promise<string>;
  cacheTtlMs?: number;
  maxBytes?: number;
}

interface CacheEntry {
  result: FetchResult;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 900_000; // 15 minutes
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_REDIRECTS = 5;
const EMPTY_SHELL_THRESHOLD = 200; // characters

export function createWebFetch(deps: WebFetchDeps) {
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const cache = new Map<string, CacheEntry>();

  const checkDomainPolicy = (url: string, workspaceId: string): { blocked: boolean; reason?: "domain-blocked" } => {
    const policy = deps.domainPolicy(workspaceId);
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
    if (policy.allow.length > 0) {
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

  const extractPdfText = async (data: ArrayBuffer): Promise<string> => {
    try {
      // pdfjs-dist is loaded dynamically to avoid bundling it on non-PDF paths
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const doc = await pdfjs.getDocument({ data }).promise;
      const pages: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => item.str ?? "")
          .join(" ");
        pages.push(text);
      }
      return pages.join("\n\n");
    } catch {
      return "[PDF text extraction failed]";
    }
  };

  const detectEmptyShell = (html: string, markdown: string, render: boolean): boolean => {
    if (render) return false;
    if (markdown.length >= EMPTY_SHELL_THRESHOLD) return false;
    // Check if original HTML has script tags but very little content
    return html.includes("<script") && markdown.trim().length < EMPTY_SHELL_THRESHOLD;
  };

  const fetchUrl = async (url: string, ctx: { workspaceId: string; render?: boolean }): Promise<FetchResult> => {
    // Check cache
    const cacheKey = `${url}:${ctx.render ?? false}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      // Mark as from cache
      if (cached.result.status === "ok") {
        return { ...cached.result, fromCache: true };
      }
      return cached.result;
    }

    // Check domain policy
    const domainCheck = checkDomainPolicy(url, ctx.workspaceId);
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

    // Fetch with redirect handling
    let currentUrl = url;
    let redirectCount = 0;

    while (redirectCount < MAX_REDIRECTS) {
      let response: Response;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20_000);
        response = await fetch(currentUrl, {
          signal: controller.signal,
          redirect: "manual", // Handle redirects manually for cross-host detection
          headers: { "User-Agent": "Piarium-Agent/1.0" },
        });
        clearTimeout(timeout);
      } catch (error) {
        const result: FetchResult = {
          status: "failed",
          url,
          reason: error instanceof Error ? error.message : "fetch failed",
        };
        cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
        return result;
      }

      // Handle redirects
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          return { status: "failed", url, reason: "redirect without location" };
        }
        const redirectUrl = new URL(location, currentUrl).href;
        if (!isSameHost(currentUrl, redirectUrl)) {
          // Cross-host redirect — don't follow, return metadata
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
        continue;
      }

      if (!response.ok) {
        const result: FetchResult = {
          status: "failed",
          url,
          reason: `HTTP ${response.status}`,
        };
        cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
        return result;
      }

      // Success — extract content
      const contentType = response.headers.get("content-type") ?? "text/plain";
      const contentLength = Number(response.headers.get("content-length") ?? 0);

      // If render requested, use renderer
      if (ctx.render && deps.renderer) {
        try {
          const html = await deps.renderer(currentUrl);
          const { markdown, title } = await extractContent(html, "text/html");
          const result: FetchResult = {
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
          cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
          return result;
        } catch (error) {
          return {
            status: "failed",
            url,
            reason: `renderer failed: ${error instanceof Error ? error.message : "unknown"}`,
          };
        }
      }

      // Check content type for PDF
      if (contentType.includes("application/pdf")) {
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > maxBytes) {
          return {
            status: "failed",
            url,
            reason: `PDF exceeds max size (${arrayBuffer.byteLength} > ${maxBytes})`,
          };
        }
        const text = await extractPdfText(arrayBuffer);
        const result: FetchResult = {
          status: "ok",
          url,
          finalUrl: currentUrl,
          contentType,
          markdown: text,
          bytes: text.length,
          fromCache: false,
          rendered: false,
        };
        cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
        return result;
      }

      // Read body with size limit
      let text: string;
      if (contentLength > maxBytes) {
        // Read only up to maxBytes
        const reader = response.body?.getReader();
        if (!reader) {
          return { status: "failed", url, reason: "no response body" };
        }
        const chunks: Uint8Array[] = [];
        let totalSize = 0;
        while (totalSize < maxBytes) {
          const { done, value } = await reader.read();
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
        text = await response.text();
        if (text.length > maxBytes) {
          text = text.slice(0, maxBytes);
        }
      }

      // Extract content
      const { markdown, title } = await extractContent(text, contentType);

      // Check for empty shell
      if (detectEmptyShell(text, markdown, ctx.render ?? false)) {
        return {
          status: "empty-shell",
          url,
          hint: "page appears to be a JS-rendered app; retry with render: true on desktop",
        };
      }

      const result: FetchResult = {
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
      cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs });
      return result;
    }

    // Too many redirects
    return { status: "failed", url, reason: "too many redirects" };
  };

  return { fetch: fetchUrl, cache };
}
