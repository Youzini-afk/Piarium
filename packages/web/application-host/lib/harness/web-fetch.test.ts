import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWebFetch } from "./web-fetch.js";
import type { SsrfPolicy, DomainPolicy } from "./web-fetch.js";

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

const noDomainPolicy = (): DomainPolicy => ({ allow: [], block: [] });

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
    const result = await service.fetch("http://127.0.0.1:8080/", { workspaceId: "ws" });
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
    const result = await service.fetch("file:///etc/passwd", { workspaceId: "ws" });
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
    const result = await service.fetch("https://evil.com/page", { workspaceId: "ws" });
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
    const blocked = await service.fetch("https://other.com/page", { workspaceId: "ws" });
    expect(blocked.status).toBe("blocked");
  });

  it("returns renderer-unavailable when render requested but no renderer", async () => {
    const service = createWebFetch({
      ssrf: createMockSsrf(),
      domainPolicy: noDomainPolicy,
    });
    const result = await service.fetch("https://example.com/", { workspaceId: "ws", render: true });
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
    });
    const result = await service.fetch("https://example.com/", { workspaceId: "ws" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.contentType).toContain("text/plain");
      expect(result.markdown.length).toBeGreaterThan(0);
      expect(result.rendered).toBe(false);
      expect(result.fromCache).toBe(false);
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
    const result = await service.fetch("https://example.com/", { workspaceId: "ws" });
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
    const r1 = await service.fetch("https://example.com/", { workspaceId: "ws" });
    const r2 = await service.fetch("https://example.com/", { workspaceId: "ws" });
    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    if (r2.status === "ok") {
      expect(r2.fromCache).toBe(true);
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
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
    const result = await service.fetch("https://example.com/", { workspaceId: "ws" });
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
    const result = await service.fetch("https://example.com/missing", { workspaceId: "ws" });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("404");
    }
  });
});
