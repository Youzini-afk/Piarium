import { describe, expect, it, afterEach } from "vitest";
import net from "node:net";
import { once } from "node:events";
import { createEgressRuntime, classifyEgressError, resolveEgressPolicy } from "./egress.js";
import { checkSsrf, classifyHostname, classifyIp } from "./ssrf-policy.js";

const PUBLIC_ADDR = { address: "93.184.216.34", family: 4 };

/** Minimal CONNECT proxy stub: records the authority and replies `innerReply`. */
const stubConnectProxy = async (innerReply: string | null) => {
  const authorities: string[] = [];
  const server = net.createServer((socket) => {
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      const line = head.subarray(0, end).toString("utf8").split("\r\n")[0] ?? "";
      const authority = line.match(/^CONNECT\s+(\S+)/)?.[1];
      if (!authority) {
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      authorities.push(authority);
      if (innerReply === null) {
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"proxy\"\r\n\r\n");
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.on("data", () => {
        socket.end(innerReply);
      });
    };
    socket.on("data", onData);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, authorities, close: () => new Promise<void>((r) => server.close(() => r())) };
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("egress policy", () => {
  it("resolves direct when no proxy env is set", () => {
    const p = resolveEgressPolicy(undefined, {});
    expect(p.mode).toBe("direct");
    expect(p.source).toBe("none");
    expect(p.invalid).toBeUndefined();
  });

  it("resolves env proxy and honors precedence + NO_PROXY", () => {
    const p = resolveEgressPolicy(undefined, {
      HTTPS_PROXY: "http://proxy.local:8080",
      NO_PROXY: "internal.example,.corp.test",
    });
    expect(p.mode).toBe("proxy");
    expect(p.proxyOrigin).toBe("http://proxy.local:8080");
    expect(p.noProxy).toEqual(["internal.example", ".corp.test"]);
  });

  it("never degrades an invalid proxy to direct", () => {
    const p = resolveEgressPolicy(undefined, { HTTPS_PROXY: "socks5://127.0.0.1:1080" });
    expect(p.mode).toBe("direct");
    expect(p.invalid).toMatch(/unsupported proxy scheme/);
    const rt = createEgressRuntime({ env: { HTTPS_PROXY: "socks5://127.0.0.1:1080" } });
    const r = rt.resolve("https://example.com/");
    expect(r.failure?.kind).toBe("proxy-config-invalid");
  });

  it("sanitizes proxy credentials out of policy", () => {
    const p = resolveEgressPolicy({ mode: "proxy", proxyUrl: "http://user:s3cret@10.0.0.1:3128" });
    expect(p.proxyOrigin).toBe("http://10.0.0.1:3128");
    expect(p.proxyAuth).toBe("basic");
    expect(JSON.stringify(p)).not.toContain("s3cret");
  });
});

describe("ssrf classification", () => {
  it("classifies fake-IP and reserved ranges as special-purpose", () => {
    expect(classifyIp("198.18.0.5")).toBe("special-purpose");
    expect(classifyIp("198.19.255.255")).toBe("special-purpose");
    expect(classifyIp("240.1.2.3")).toBe("special-purpose");
    expect(classifyIp("255.255.255.255")).toBe("special-purpose");
  });

  it("normalizes IPv6 bracket/zone literals before classification", async () => {
    expect(classifyHostname("[::1]")).toBe("private-network");
    expect(classifyHostname("[fe80::1%eth0]")).toBe("private-network");
    const r = await checkSsrf("http://[::1]:8080/admin");
    expect(r).toEqual({ blocked: true, reason: "private-network" });
  });

  it("classifies IPv4-embedded IPv6 by the embedded address", () => {
    expect(classifyIp("::ffff:127.0.0.1")).toBe("private");
    expect(classifyIp("::ffff:93.184.216.34")).toBe("public");
    expect(classifyIp("64:ff9b::7f00:1")).toBe("private");
    expect(classifyIp("64:ff9b::5db8:d822")).toBe("public");
  });

  it("blocks ftp and non-URL input at the scheme check", async () => {
    expect(await checkSsrf("ftp://example.com/")).toEqual({ blocked: true, reason: "scheme" });
    expect(await checkSsrf("not a url")).toEqual({ blocked: true, reason: "scheme" });
  });
});

describe("connect-path enforcement", () => {
  it("refuses a DNS answer that resolves private — on the dial path", async () => {
    const rt = createEgressRuntime({ env: {}, resolveAll: async () => [{ address: "192.168.1.9", family: 4 }] });
    await expect(rt.fetch("http://internal-name.test/")).rejects.toMatchObject({ kind: "private-network" });
  });

  it("refuses a fake-IP answer as special-purpose, not as a timeout", async () => {
    const rt = createEgressRuntime({ env: {}, resolveAll: async () => [{ address: "198.18.7.7", family: 4 }] });
    await expect(rt.fetch("http://mapped-name.test/")).rejects.toMatchObject({ kind: "special-purpose" });
  });

  it("reports DNS failure distinctly from a policy block", async () => {
    const rt = createEgressRuntime({
      env: {},
      resolveAll: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND x"), { code: "ENOTFOUND" }); },
    });
    await expect(rt.fetch("http://missing.test/")).rejects.toMatchObject({ kind: "dns" });
  });
});

describe("proxy data path", () => {
  it("routes https targets through CONNECT to the configured proxy", async () => {
    const proxy = await stubConnectProxy("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    cleanups.push(proxy.close);
    const rt = createEgressRuntime({ env: { HTTPS_PROXY: proxy.url }, resolveAll: async () => [PUBLIC_ADDR] });
    // TLS to example.com will fail after CONNECT — but the CONNECT authority
    // proves the request went through the proxy endpoint.
    await expect(rt.fetch("https://target.example/")).rejects.toThrow();
    expect(proxy.authorities).toEqual(["target.example:443"]);
  });

  it("classifies a proxy 407 CONNECT as proxy-auth", async () => {
    const proxy = await stubConnectProxy(null);
    cleanups.push(proxy.close);
    const rt = createEgressRuntime({ env: { HTTPS_PROXY: proxy.url }, resolveAll: async () => [PUBLIC_ADDR] });
    await expect(rt.fetch("https://target.example/")).rejects.toMatchObject({ kind: "proxy-auth" });
  });

  it("classifies an unreachable proxy as proxy-unavailable, not connect", async () => {
    const rt = createEgressRuntime({ env: { HTTPS_PROXY: "http://127.0.0.1:1" }, resolveAll: async () => [PUBLIC_ADDR] });
    await expect(rt.fetch("https://target.example/")).rejects.toMatchObject({ kind: "proxy-unavailable" });
  });

  it("bypasses the proxy for NO_PROXY targets", async () => {
    const proxy = await stubConnectProxy("HTTP/1.1 200 OK\r\n\r\n");
    cleanups.push(proxy.close);
    const rt = createEgressRuntime({
      env: { HTTPS_PROXY: proxy.url, NO_PROXY: "target.example" },
      resolveAll: async () => [PUBLIC_ADDR],
    });
    const r = rt.resolve("https://target.example/");
    expect(r.bypassedProxy).toBe(true);
    await expect(rt.fetch("https://target.example/")).rejects.toThrow();
    expect(proxy.authorities).toEqual([]);
  });

  it("still refuses literal private targets in proxy mode", () => {
    const rt = createEgressRuntime({ env: { HTTPS_PROXY: "http://127.0.0.1:3128" } });
    expect(rt.resolve("http://192.168.0.1/").failure?.kind).toBe("private-network");
    expect(rt.resolve("http://198.18.2.2/").failure?.kind).toBe("special-purpose");
  });
});

describe("diagnose", () => {
  it("reports resolution and classes without fetching", async () => {
    const rt = createEgressRuntime({
      env: {},
      resolveAll: async () => [PUBLIC_ADDR, { address: "93.184.216.35", family: 4 }],
    });
    const d = await rt.diagnose("https://example.com/x");
    expect(d.decision).toBe("allowed");
    expect(d.resolution).toBe("local");
    expect(d.addresses).toEqual([
      { address: "93.184.216.34", class: "public" },
      { address: "93.184.216.35", class: "public" },
    ]);
  });

  it("labels proxy mode as proxy-side resolution", async () => {
    const rt = createEgressRuntime({ env: { HTTPS_PROXY: "http://127.0.0.1:3128" } });
    const d = await rt.diagnose("https://example.com/");
    expect(d.decision).toBe("allowed");
    expect(d.resolution).toBe("proxy-side");
    expect(d.policy.proxyOrigin).toBe("http://127.0.0.1:3128");
  });

  it("reports a blocked literal decision with the reason", async () => {
    const rt = createEgressRuntime({ env: {} });
    const d = await rt.diagnose("http://127.0.0.1:9/");
    expect(d.decision).toBe("blocked");
    expect(d.reason).toContain("private-network");
  });
});

describe("classifyEgressError", () => {
  it("maps TLS and timeout codes", () => {
    expect(classifyEgressError(Object.assign(new Error("x"), { cause: Object.assign(new Error("bad"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) })).kind).toBe("tls");
    expect(classifyEgressError(Object.assign(new Error("x"), { cause: Object.assign(new Error("t"), { code: "UND_ERR_CONNECT_TIMEOUT" }) })).kind).toBe("connect");
    expect(classifyEgressError(Object.assign(new Error("x"), { cause: Object.assign(new Error("t"), { code: "ECONNREFUSED" }) }), "proxy").kind).toBe("proxy-unavailable");
  });
});
