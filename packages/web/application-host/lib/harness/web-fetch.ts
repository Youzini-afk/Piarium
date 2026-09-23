import type { FetchResult, HarnessWebDomainPolicy, RetrievalReceiptAuthority, RetrievalUrlReceipt, WebDocumentRegion, WebFetchRequest, WebReadPosition, WebSnapshotStructure } from "@varin/protocol";
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
  /** Optional PDF page renderer. Text extraction stays available without it. */
  pdfPageRenderer?: (source: Buffer, page: number, region?: WebDocumentRegion, signal?: AbortSignal) => Promise<{
    data: Buffer;
    mimeType: "image/png";
  }>;
  pdfOcr?: (input: { source: Buffer; page: number; signal?: AbortSignal }) => Promise<{
    text: string;
    engine: string;
  }>;
}

interface CacheEntry {
  result: FetchResult;
  expiresAt: number;
  /** Raw PDF bytes remain available for a later authority rebind. */
  sourceBytes?: Buffer;
}

interface FetchContext {
  workspaceId: string;
  authority: RetrievalReceiptAuthority;
  render?: boolean;
  domainPolicy?: DomainPolicy;
  signal?: AbortSignal;
  issueReceipt?: boolean;
  /** A caller-requested refresh must create a new snapshot record even when
   * the fetched bytes are unchanged. */
  forceNewSnapshot?: boolean;
  ocr?: boolean;
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

  interface PdfExtraction {
    text: string;
    /** One-based line range of each page inside the joined text body. */
    pages: Array<{ page: number; startLine: number; endLine: number }>;
    pageCount: number;
    layouts: NonNullable<WebSnapshotStructure["layouts"]>;
    ocrPages: number[];
    ocrEngine?: string;
    ocrUnavailable: boolean;
    imagePages: number[];
  }

  const extractPdfText = async (data: ArrayBuffer, signal?: AbortSignal, ocr?: FetchContext["ocr"]): Promise<PdfExtraction | null> => {
    try {
      signal?.throwIfAborted();
      // pdfjs-dist is loaded dynamically to avoid bundling it on non-PDF paths
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const loading = pdfjs.getDocument({ data, disableWorker: true });
      const doc = signal ? await awaitAbortable(loading.promise, signal) : await loading.promise;
      const pages: string[] = [];
      const layouts: NonNullable<WebSnapshotStructure["layouts"]> = [];
      const ocrPages: number[] = [];
      let ocrEngine: string | undefined;
      let ocrUnavailable = false;
      const imagePages: number[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        signal?.throwIfAborted();
        const pagePromise = doc.getPage(i);
        const page = signal ? await awaitAbortable(pagePromise, signal) : await pagePromise;
        signal?.throwIfAborted();
        const contentPromise = page.getTextContent();
        const content = signal ? await awaitAbortable(contentPromise, signal) : await contentPromise;
        try {
          const operatorPromise = page.getOperatorList();
          const operatorList = signal ? await awaitAbortable(operatorPromise, signal) : await operatorPromise;
          const imageOps = [
            pdfjs.OPS.paintImageMaskXObject,
            pdfjs.OPS.paintImageMaskXObjectRepeat,
            pdfjs.OPS.paintImageXObject,
            pdfjs.OPS.paintInlineImageXObject,
          ].filter((value): value is number => typeof value === "number");
          if (imageOps.some((value) => operatorList.fnArray.includes(value))) imagePages.push(i);
        } catch {
          // Some PDFs omit an operator list or use an unsupported image op;
          // text/layout extraction remains useful and the page can still be
          // opened through the visual reader.
        }
        const items = content.items
          .filter((item) => typeof item.str === "string" && item.str.length > 0)
          .map((item) => ({
            text: item.str ?? "",
            x: Array.isArray(item.transform) ? Number(item.transform[4] ?? 0) : 0,
            y: Array.isArray(item.transform) ? Number(item.transform[5] ?? 0) : 0,
            width: Number(item.width ?? 0),
            height: Number(item.height ?? 0),
            hasEOL: item.hasEOL === true,
          }));
        // Keep a useful reading order for ordinary PDFs: group glyph runs by
        // baseline, then order each line left-to-right. A later column pass
        // groups obvious left/right starts while preserving the coordinates.
        const rows: Array<{ y: number; items: typeof items }> = [];
        for (const item of items) {
          const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 2);
          if (row) row.items.push(item);
          else rows.push({ y: item.y, items: [item] });
        }
        rows.sort((left, right) => right.y - left.y);
        const lineRecords = rows.map((row) => {
          const sorted = row.items.sort((left, right) => left.x - right.x);
          const text = sorted.map((item) => item.text).join(" ").trim();
          const x = sorted.reduce((value, item) => Math.min(value, item.x), Number.POSITIVE_INFINITY);
          const right = sorted.reduce((value, item) => Math.max(value, item.x + item.width), 0);
          const height = sorted.reduce((value, item) => Math.max(value, item.height), 0);
          return {
            text,
            x: Number.isFinite(x) ? x : 0,
            y: row.y,
            width: Math.max(0, right - (Number.isFinite(x) ? x : 0)),
            height,
            segments: sorted.map((item) => ({ text: item.text, x: item.x, width: item.width })),
          };
        }).filter((line) => line.text.length > 0);
        let text = lineRecords.map((line) => line.text).join("\n");
        if (!text.trim() && ocr === true) {
          if (!deps.pdfOcr) {
            ocrUnavailable = true;
          } else {
            try {
              const result = await deps.pdfOcr({ source: Buffer.from(data), page: i, ...(signal ? { signal } : {}) });
              if (result.text.trim()) {
                text = result.text.trim();
                ocrPages.push(i);
                ocrEngine ??= result.engine;
              } else {
                ocrUnavailable = true;
              }
            } catch {
              if (signal?.aborted) throw signal.reason ?? new DOMException("Web fetch aborted", "AbortError");
              ocrUnavailable = true;
            }
          }
        }
        const viewport = page.getViewport({ scale: 1 });
        const starts = [...new Set(lineRecords.map((line) => Math.round(line.x / 12) * 12))].sort((a, b) => a - b);
        const columns = starts.length > 1 && starts.at(-1)! - starts[0]! > viewport.width * 0.18 ? Math.min(starts.length, 3) : undefined;
        const orderedLines = columns && columns >= 2
          ? [...lineRecords.filter((line) => line.x < (starts[0]! + starts.at(-1)!) / 2),
            ...lineRecords.filter((line) => line.x >= (starts[0]! + starts.at(-1)!) / 2)]
          : lineRecords;
        if (columns && columns >= 2 && !ocrPages.includes(i)) text = orderedLines.map((line) => line.text).join("\n");
        layouts.push({
          page: i,
          width: viewport.width,
          height: viewport.height,
          ...(columns ? { columns } : {}),
          lines: orderedLines.map((line, readingIndex) => ({ ...line, readingIndex })),
        });
        pages.push(text);
      }
      // Pages join with "\n\n", which contributes exactly one empty line
      // between consecutive page bodies — page ranges map back deterministically.
      let cursor = 1;
      const ranges = pages.map((text, index) => {
        const count = text.split("\n").length;
        const range = { page: index + 1, startLine: cursor, endLine: cursor + count - 1 };
        cursor += count + 1;
        return range;
      });
      return {
        text: pages.join("\n\n"),
        pages: ranges,
        pageCount: doc.numPages,
        layouts,
        ocrPages,
        ...(ocrEngine ? { ocrEngine } : {}),
        ocrUnavailable,
        imagePages,
      };
    } catch {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Web fetch aborted", "AbortError");
      }
      return null;
    }
  };

  // Lightweight structural detection over the stored readable body. What a
  // representation cannot express is reported in `unparsed` instead of being
  // silently absent (e.g. pdf-text has no figure/table boundaries).
  const detectStructure = (
    markdown: string,
    representation: string,
    pdfPages?: Array<{ page: number; startLine: number; endLine: number }>,
    pdfLayouts?: NonNullable<WebSnapshotStructure["layouts"]>,
    pdfImagePages?: number[],
  ): WebSnapshotStructure => {
    const lines = markdown.split("\n");
    const headings: WebSnapshotStructure["headings"] = [];
    const tables: NonNullable<WebSnapshotStructure["tables"]> = [];
    const figures: NonNullable<WebSnapshotStructure["figures"]> = [];
    const formulas: NonNullable<WebSnapshotStructure["formulas"]> = [];
    const isMarkup = representation !== "pdf-text";
    if (isMarkup) {
      let index = 0;
      while (index < lines.length) {
        const line = lines[index] ?? "";
        const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (heading?.[1] && heading[2]) {
          headings.push({ title: heading[2], level: heading[1].length, line: index + 1 });
          index += 1;
          continue;
        }
        const image = /!\[([^\]]*)\]\([^)]*\)/.exec(line);
        if (image) {
          figures.push(image[1] ? { line: index + 1, title: image[1] } : { line: index + 1 });
        }
        // A markdown table block: a header line, a |---| separator, then rows.
        if (line.trim().startsWith("|") && index + 1 < lines.length && /^\|?\s*:?-{2,}/.test((lines[index + 1] ?? "").trim())) {
          let end = index + 1;
          while (end + 1 < lines.length && (lines[end + 1] ?? "").trim().startsWith("|")) end += 1;
          tables.push({ startLine: index + 1, endLine: end + 1 });
          index = end + 1;
          continue;
        }
        index += 1;
      }
    }
    if (!isMarkup && pdfLayouts && pdfPages) {
      for (const layout of pdfLayouts) {
        const pageRange = pdfPages.find((entry) => entry.page === layout.page);
        if (!pageRange) continue;
        let run: Array<(typeof layout.lines)[number]> = [];
        const flushTable = (): void => {
          if (run.length < 3) {
            run = [];
            return;
          }
          tables.push({
            startLine: pageRange.startLine + run[0]!.readingIndex,
            endLine: pageRange.startLine + run.at(-1)!.readingIndex,
            confidence: "candidate",
            rows: run.map((line) => ({
              cells: (line.segments ?? []).map((cell) => ({ text: cell.text, x: cell.x, width: cell.width })),
            })),
          });
          run = [];
        };
        for (const line of layout.lines) {
          if ((line.segments?.length ?? 0) >= 2) {
            if (run.length > 0 && line.readingIndex !== run.at(-1)!.readingIndex + 1) flushTable();
            run.push(line);
          } else {
            flushTable();
          }
          if (/[=∑∫√]|\\frac\b|\\sum\b|\\int\b/.test(line.text)) {
            formulas.push({
              line: pageRange.startLine + line.readingIndex,
              text: line.text,
              confidence: "candidate",
            });
          }
        }
        flushTable();
      }
    }
    if (!isMarkup && pdfImagePages && pdfPages) {
      for (const page of pdfImagePages) {
        const pageRange = pdfPages.find((entry) => entry.page === page);
        const layout = pdfLayouts?.find((entry) => entry.page === page);
        if (!pageRange) continue;
        figures.push({
          line: pageRange.startLine,
          page,
          title: `PDF image candidate on page ${page}`,
          confidence: "candidate",
          ...(layout ? { bbox: { x: 0, y: 0, width: layout.width, height: layout.height } } : {}),
        });
      }
    }
    const unparsed: string[] = [];
    if (!pdfPages) unparsed.push("pages");
    if (!isMarkup) {
      if (tables.length === 0) unparsed.push("tables");
      unparsed.push("figures", "headings", "ocr");
    }
    return {
      ...(pdfPages && pdfPages.length ? { pages: pdfPages } : {}),
      ...(pdfLayouts && pdfLayouts.length ? { layouts: pdfLayouts } : {}),
      ...(headings && headings.length ? { headings } : {}),
      ...(tables.length ? { tables } : {}),
      ...(figures.length ? { figures } : {}),
      ...(formulas.length ? { formulas } : {}),
      ...(unparsed.length ? { unparsed } : {}),
    };
  };

  const SECTION_END_LEVEL = (level: number): number => level;

  const resolvePosition = (
    markdown: string,
    structure: WebSnapshotStructure | undefined,
    position: WebReadPosition,
    snapshotId: string,
  ): { body: string; range: { startLine: number; endLine: number; totalLines: number } } | FetchResult => {
    const lines = markdown.split("\n");
    const totalLines = lines.length;
    const notFound = (detail: string): FetchResult => ({ status: "position-not-found", snapshotId, detail });
    const unsupported = (kind: string): FetchResult => ({ status: "structure-unsupported", snapshotId, kind });
    const slice = (startLine: number, endLine: number): { body: string; range: { startLine: number; endLine: number; totalLines: number } } => ({
      body: lines.slice(startLine - 1, Math.min(endLine, totalLines)).join("\n"),
      range: { startLine, endLine: Math.min(endLine, totalLines), totalLines },
    });
    switch (position.kind) {
      case "lines": {
        if (position.startLine < 1 || position.startLine > totalLines) {
          return notFound(`lines ${position.startLine}.. outside 1..${totalLines}`);
        }
        return slice(position.startLine, position.endLine ?? totalLines);
      }
      case "page": {
        if (!structure?.pages?.length) return unsupported("pages");
        const page = structure.pages.find((entry) => entry.page === position.page);
        if (!page) return notFound(`page ${position.page} outside 1..${structure.pages.length}`);
        return slice(page.startLine, page.endLine);
      }
      case "section": {
        if (!structure?.headings?.length) return unsupported("headings");
        const needle = position.title.trim().toLowerCase();
        const heading = structure.headings.find((entry) => entry.title.toLowerCase().includes(needle));
        if (!heading) return notFound(`no section matching "${position.title}"`);
        const next = structure.headings.find(
          (entry) => entry.line > heading.line && entry.level <= SECTION_END_LEVEL(heading.level),
        );
        return slice(heading.line, (next?.line ?? totalLines + 1) - 1);
      }
      case "appendix": {
        if (!structure?.headings?.length) return unsupported("headings");
        const heading = structure.headings.find((entry) =>
          /^(appendix|appendices|supplementary\b|supplement\b|annex\b|附录)/i.test(entry.title.trim()));
        if (!heading) return notFound("no appendix/supplementary section");
        const next = structure.headings.find(
          (entry) => entry.line > heading.line && entry.level <= heading.level,
        );
        return slice(heading.line, (next?.line ?? totalLines + 1) - 1);
      }
      case "element": {
        const list = position.element === "table"
          ? structure?.tables
          : position.element === "figure" ? structure?.figures : structure?.formulas;
        if (!list?.length) return unsupported(`${position.element}s`);
        const entry = list[position.index - 1];
        if (!entry) return notFound(`${position.element} ${position.index} outside 1..${list.length}`);
        const startLine = "startLine" in entry ? entry.startLine : entry.line;
        const endLine = "endLine" in entry ? entry.endLine : entry.line;
        return slice(startLine, endLine);
      }
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

  const snapshotDerivation = (content: Extract<FetchResult, { status: "ok" }>): {
    pdf: boolean;
    pages?: Array<{ page: number; startLine: number; endLine: number }>;
    layouts?: NonNullable<WebSnapshotStructure["layouts"]>;
    document?: NonNullable<NonNullable<Extract<FetchResult, { status: "ok" }>["snapshot"]>["document"]>;
  } => {
    const document = content.snapshot?.document;
    const pdf = document?.kind === "pdf"
      || content.snapshot?.representation === "pdf-text"
      || content.contentType.toLowerCase().includes("application/pdf");
    return {
      pdf,
      ...(content.structure?.pages ? { pages: content.structure.pages } : {}),
      ...(content.structure?.layouts ? { layouts: content.structure.layouts } : {}),
      ...(document ? { document } : {}),
    };
  };

  const attachSnapshot = async (
    content: Extract<FetchResult, { status: "ok" }>,
    ctx: FetchContext,
    pdf = false,
    pdfPages?: Array<{ page: number; startLine: number; endLine: number }>,
    pdfLayouts?: NonNullable<WebSnapshotStructure["layouts"]>,
    pdfImagePages?: number[],
    pdfDocument?: NonNullable<NonNullable<Extract<FetchResult, { status: "ok" }>["snapshot"]>["document"]>,
    sourceBytes?: Buffer,
  ): Promise<Extract<FetchResult, { status: "ok" }>> => {
    const representation = representationFor(content.contentType, content.rendered, pdf);
    const structure = content.structure ?? detectStructure(content.markdown, representation, pdfPages, pdfLayouts, pdfImagePages);
    const withStructure = { ...content, structure };
    if (!deps.materials) return withStructure;
    try {
      const snapshot = await deps.materials.put(
        ctx.workspaceId,
        {
          sourceUrl: content.url,
          finalUrl: content.finalUrl,
          ...(content.contentType ? { contentType: content.contentType } : {}),
          ...(content.title ? { title: content.title } : {}),
          representation,
          ...(content.rendered ? { rendered: true } : {}),
          structure,
          ...(pdfDocument ? { document: pdfDocument } : {}),
        },
        Buffer.from(content.markdown, "utf8"),
        ctx.authority,
        {
          ...(ctx.forceNewSnapshot ? { forceNew: true } : {}),
          ...(sourceBytes ? {
            source: { bytes: sourceBytes, contentType: content.contentType },
          } : {}),
        },
      );
      return { ...withStructure, snapshot };
    } catch {
      // Snapshot persistence must never fail a body that was fetched
      // successfully; the result is delivered without a snapshotId.
      return withStructure;
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
    const cacheKey = `${url}:${ctx.render ?? false}:ocr=${ctx.ocr === true}`;
    const finishOk = async (
      content: Extract<FetchResult, { status: "ok" }>,
      pdf = false,
      pdfPages?: Array<{ page: number; startLine: number; endLine: number }>,
      pdfLayouts?: NonNullable<WebSnapshotStructure["layouts"]>,
      pdfImagePages?: number[],
      pdfDocument?: NonNullable<NonNullable<Extract<FetchResult, { status: "ok" }>["snapshot"]>["document"]>,
      sourceBytes?: Buffer,
    ): Promise<FetchResult> => {
      const result = await attachSnapshot(content, ctx, pdf, pdfPages, pdfLayouts, pdfImagePages, pdfDocument, sourceBytes);
      cache.set(cacheKey, { result, expiresAt: Date.now() + cacheTtlMs, ...(sourceBytes ? { sourceBytes } : {}) });
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
        const extracted = await extractPdfText(arrayBuffer, controller.signal, ctx.ocr);
        controller.signal.throwIfAborted();
        if (extracted === null) {
          finishRequest();
          return { status: "failed", url, reason: "PDF text extraction failed" };
        }
        const ocr = ctx.ocr === true
          ? extracted.ocrPages.length > 0
            ? { status: "used" as const, ...(extracted.ocrEngine ? { engine: extracted.ocrEngine } : {}), pages: extracted.ocrPages }
            : extracted.ocrUnavailable
              ? { status: "unavailable" as const, pages: [] as number[], detail: "OCR adapter unavailable or returned no text" }
              : { status: "not-needed" as const, pages: [] as number[] }
          : undefined;
        const content: Extract<FetchResult, { status: "ok" }> = {
          status: "ok",
          url,
          finalUrl: currentUrl,
          contentType,
          markdown: extracted.text,
          bytes: extracted.text.length,
          fromCache: false,
          rendered: false,
          ...(ocr ? { ocr } : {}),
        };
        finishRequest();
        return finishOk(
          content,
          true,
          extracted.pages,
          extracted.layouts,
          extracted.imagePages,
          {
            kind: "pdf",
            pageCount: extracted.pageCount,
            parser: "pdf-text-layout-v1",
            ocr: ctx.ocr === true
              ? extracted.ocrPages.length > 0
                ? { status: "used" as const, ...(extracted.ocrEngine ? { engine: extracted.ocrEngine } : {}), pages: extracted.ocrPages }
                : extracted.ocrUnavailable
                  ? { status: "unavailable" as const, pages: [] as number[] }
                  : { status: "not-needed" as const, pages: [] as number[] }
              : { status: "not-requested" as const },
          },
          Buffer.from(arrayBuffer),
        );
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

  const renderSnapshotPage = async (
    snapshotId: string,
    ctx: FetchContext,
    page: number | undefined,
    region?: WebDocumentRegion,
  ): Promise<FetchResult> => {
    const pageNumber = page;
    if (pageNumber === undefined || !Number.isSafeInteger(pageNumber) || pageNumber < 1) {
      return { status: "page-image-unavailable", snapshotId, ...(page !== undefined ? { page } : {}), reason: "a one-based page is required" };
    }
    const validPage = pageNumber;
    if (!deps.pdfPageRenderer) {
      return { status: "page-image-unavailable", snapshotId, page: validPage, reason: "no PDF page renderer is installed" };
    }
    if (region && (!Number.isFinite(region.x) || !Number.isFinite(region.y)
      || !Number.isFinite(region.width) || !Number.isFinite(region.height)
      || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0)) {
      return { status: "page-image-unavailable", snapshotId, page: validPage, reason: "region must contain finite non-negative x/y and positive width/height" };
    }
    const found = deps.materials
      ? await deps.materials.read(ctx.workspaceId, snapshotId, ctx.authority, { includeSource: true }).catch(() => null)
      : null;
    if (!found) return { status: "snapshot-missing", snapshotId };
    if (found.ref.document?.kind !== "pdf") {
      return { status: "page-image-unavailable", snapshotId, page: validPage, reason: "snapshot is not a PDF" };
    }
    if (validPage > found.ref.document.pageCount) {
      return { status: "page-image-unavailable", snapshotId, page: validPage, reason: `page ${validPage} is outside 1..${found.ref.document.pageCount}` };
    }
    if (!found.source) {
      return { status: "page-image-unavailable", snapshotId, page: validPage, reason: "original PDF bytes are unavailable" };
    }
    const policyCheck = checkDomainPolicy(found.ref.finalUrl, ctx.workspaceId, ctx.domainPolicy);
    if (policyCheck.blocked) return { status: "blocked", url: found.ref.finalUrl, reason: "domain-blocked" };
    try {
      const image = await deps.pdfPageRenderer(found.source.bytes, validPage, region, ctx.signal);
      return withReceipt({
        status: "ok",
        url: found.ref.sourceUrl,
        finalUrl: found.ref.finalUrl,
        contentType: found.ref.contentType ?? "application/pdf",
        ...(found.ref.title ? { title: found.ref.title } : {}),
        // The image is a view of the fixed PDF; the receipt must bind the
        // readable snapshot body rather than minting a receipt over an empty
        // string just because this response carries image content.
        markdown: found.body.toString("utf8"),
        bytes: image.data.byteLength,
        fromCache: false,
        rendered: false,
        snapshot: found.ref,
        ...(found.ref.structure ? { structure: found.ref.structure } : {}),
        pageImage: {
          page: validPage,
          mimeType: image.mimeType,
          data: image.data.toString("base64"),
          byteLength: image.data.byteLength,
          ...(region ? { region } : {}),
        },
      }, ctx.workspaceId, ctx.authority, ctx.issueReceipt === true);
    } catch (error) {
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? new DOMException("Web fetch aborted", "AbortError");
      return {
        status: "page-image-unavailable",
        snapshotId,
        page: validPage,
        reason: error instanceof Error ? error.message : "PDF page rendering failed",
      };
    }
  };

  const readSnapshot = async (
    snapshotId: string,
    ctx: FetchContext,
    position?: WebReadPosition,
    view?: WebFetchRequest["view"],
    page?: number,
    region?: WebDocumentRegion,
  ): Promise<FetchResult> => {
    if (view === "page-image") return renderSnapshotPage(snapshotId, ctx, page, region);
    const found = deps.materials
      ? await deps.materials.read(ctx.workspaceId, snapshotId, ctx.authority).catch(() => null)
      : null;
    if (!found) return { status: "snapshot-missing", snapshotId };
    // Re-reading stored material still passes the caller's current domain
    // policy — a snapshot is content, not a stored authorization.
    const policyCheck = checkDomainPolicy(found.ref.finalUrl, ctx.workspaceId, ctx.domainPolicy);
    if (policyCheck.blocked) {
      return { status: "blocked", url: found.ref.finalUrl, reason: "domain-blocked" };
    }
    let markdown = found.body.toString("utf8");
    let range: { startLine: number; endLine: number; totalLines: number } | undefined;
    if (position) {
      const sliced = resolvePosition(markdown, found.ref.structure, position, snapshotId);
      if (!("body" in sliced)) return sliced;
      markdown = sliced.body;
      range = sliced.range;
    }
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
      ...(found.ref.structure ? { structure: found.ref.structure } : {}),
      ...(range ? { range } : {}),
    }, ctx.workspaceId, ctx.authority, ctx.issueReceipt === true);
  };

  const fetchUrl = async (input: WebFetchRequest | string, ctx: FetchContext): Promise<FetchResult> => {
    const request: WebFetchRequest = typeof input === "string" ? { url: input } : input;
    const snapshotId = request.snapshotId?.trim();
    if (snapshotId) return readSnapshot(snapshotId, ctx, request.position, request.view, request.page, request.region);
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

    const positionSlice = (result: FetchResult): FetchResult => {
      if (!request.position || result.status !== "ok") return result;
      const sliced = resolvePosition(
        result.markdown,
        result.structure ?? result.snapshot?.structure,
        request.position,
        result.snapshot?.snapshotId ?? "",
      );
      if (!("body" in sliced)) return sliced;
      const { range: _replacedRange, ...rest } = result;
      return { ...rest, markdown: sliced.body, bytes: sliced.body.length, range: sliced.range };
    };

    const applyView = async (result: FetchResult): Promise<FetchResult> => {
      if (request.view !== "page-image") return result;
      if (result.status !== "ok") return result;
      const resultSnapshotId = result.snapshot?.snapshotId;
      if (!resultSnapshotId) {
        return { status: "page-image-unavailable", snapshotId: "", ...(request.page !== undefined ? { page: request.page } : {}), reason: "the fetched document was not pinned as a snapshot" };
      }
      return renderSnapshotPage(resultSnapshotId, ctx, request.page, request.region);
    };

    // Cached bytes are reusable only after this workspace and request have
    // independently passed their current authorization policies.
    const cacheKey = `${url}:${ctx.render ?? false}:ocr=${request.ocr === true}`;
    if (!request.refresh) {
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        if (cached.result.status === "ok") {
          const cachedPolicyCheck = checkDomainPolicy(cached.result.finalUrl, ctx.workspaceId, ctx.domainPolicy);
          if (cachedPolicyCheck.blocked) {
            return { status: "blocked", url: cached.result.finalUrl, reason: "domain-blocked" };
          }
          const { receipt: _oldReceipt, ...content } = cached.result;
          const derivation = snapshotDerivation(content);
          const rebound = await attachSnapshot(
            { ...content, fromCache: true },
            { ...ctx, forceNewSnapshot: false },
            derivation.pdf,
            derivation.pages,
            derivation.layouts,
            undefined,
            derivation.document,
            cached.sourceBytes,
          );
          return applyView(positionSlice(await withReceipt(rebound, ctx.workspaceId, ctx.authority, ctx.issueReceipt === true)));
        }
        return cached.result;
      }
    }

    const deliver = async (result: FetchResult, rebindSnapshot = true): Promise<FetchResult> => {
      if (result.status !== "ok") return result;
      // The in-flight/cache result may have been produced under another
      // session or thread. Rebind the content snapshot to this caller's
      // authority while reusing the content-addressed body.
      const derivation = snapshotDerivation(result);
      const rebound = rebindSnapshot
        ? await attachSnapshot(result, { ...ctx, forceNewSnapshot: false }, derivation.pdf, derivation.pages, derivation.layouts, undefined, derivation.document, cache.get(cacheKey)?.sourceBytes)
        : result;
      return positionSlice(await withReceipt(rebound, ctx.workspaceId, ctx.authority, ctx.issueReceipt === true));
    };

    // A refresh is intentionally a fresh request: it bypasses both the
    // response cache and in-flight sharing so it can mint a new snapshot.
    if (request.refresh) {
      return applyView(await deliver(await performFetch(url, { ...ctx, forceNewSnapshot: true, ocr: request.ocr === true }), false));
    }

    const sharedKey = `${cacheKey}|${policyKeyFor(ctx.workspaceId, ctx.domainPolicy)}`;
    let shared = inflight.get(sharedKey);
    if (!shared || shared.done || shared.controller.signal.aborted) {
      const controller = new AbortController();
      const entry: SharedFetch = { controller, waiters: 0, done: false, promise: Promise.resolve({ status: "failed", url, reason: "unset" }) };
      entry.promise = performFetch(url, { ...ctx, signal: controller.signal, ocr: request.ocr === true })
        .finally(() => {
          entry.done = true;
          if (inflight.get(sharedKey) === entry) inflight.delete(sharedKey);
        });
      shared = entry;
      inflight.set(sharedKey, shared);
    }
    return applyView(await deliver(await joinShared(shared, ctx.signal)));
  };

  return {
    fetch: fetchUrl,
    cache,
    inflight,
  };
}
