/**
 * Host-owned outbound egress policy — one place that decides how an HTTP(S)
 * request leaves the process and why it failed when it does.
 *
 * Policy modes:
 * - `auto` (default): honor `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` and
 *   `NO_PROXY` (lowercase accepted). Absent env means direct.
 * - `direct`: never use a proxy.
 * - explicit proxy: caller-supplied proxy URL.
 *
 * Invariants:
 * - A malformed or unsupported proxy setting never silently falls back to
 *   direct: the policy snapshot carries `invalid` and requests fail with
 *   `proxy-config-invalid`.
 * - Each request freezes its own policy version; env edits apply to the next
 *   resolution, never mid-request.
 * - SSRF enforcement happens inside the connector lookup so the classified
 *   answer is the address actually dialed (no check-then-fetch gap), and
 *   through the proxy's CONNECT semantics the proxy resolves the target
 *   itself — diagnostics label that `proxy-side` honestly.
 * - Proxy endpoint hosts may be loopback/LAN (that is the whole point of a
 *   local proxy); only the *target* is SSRF-screened.
 * - Credentials embedded in a proxy URL are used for CONNECT auth and are
 *   never copied into errors, logs, or diagnostics.
 */

import { lookup } from "node:dns/promises";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { classifyHostname, classifyIp, type EgressAddressClass } from "./ssrf-policy.js";

export type EgressErrorKind =
  | "dns"
  | "scheme-denied"
  | "private-network"
  | "special-purpose"
  | "proxy-unavailable"
  | "proxy-auth"
  | "proxy-config-invalid"
  | "tls"
  | "connect"
  | "timeout"
  | "cancelled"
  | "unknown";

/** Error with a stable machine-readable classification. */
export class EgressError extends Error {
  readonly kind: EgressErrorKind;
  constructor(kind: EgressErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EgressError";
    this.kind = kind;
  }
}

export type EgressMode = "auto" | "direct" | "proxy";

export interface EgressOverride {
  mode?: EgressMode;
  /** Explicit proxy URL — only used with mode "proxy". */
  proxyUrl?: string;
  /** Comma-separated NO_PROXY semantics, in addition to env. */
  noProxy?: string;
}

export interface EgressPolicy {
  /** Frozen policy revision; every resolution stamps a new version. */
  version: number;
  mode: "direct" | "proxy";
  /** Sanitized proxy origin (scheme://host:port) — never carries credentials. */
  proxyOrigin?: string;
  /** Proxy has CONNECT credentials configured (type only, never the secret). */
  proxyAuth?: "basic";
  noProxy: string[];
  source: "env" | "override" | "none";
  /** Non-empty when configuration is malformed — requests must fail, not go direct. */
  invalid?: string;
}

export interface EgressResolution {
  policy: EgressPolicy;
  /** Resolved dispatcher or a typed failure the caller must surface. */
  dispatcher?: Dispatcher;
  failure?: EgressError;
  /** True when a configured proxy is bypassed for this target (NO_PROXY/loopback). */
  bypassedProxy?: boolean;
}

export type EgressFetch = (
  url: string,
  init?: RequestInit & { dispatcher?: never },
  override?: EgressOverride,
) => Promise<Response>;

export interface EgressRuntime {
  /** Frozen policy for one request (env re-read per call — new version). */
  resolvePolicy(override?: EgressOverride): EgressPolicy;
  /** Policy + dispatcher for a concrete target URL. */
  resolve(url: string, override?: EgressOverride): EgressResolution;
  fetch: EgressFetch;
  /** Read-only diagnosis of a target: policy, decision, resolution class. */
  diagnose(url: string, override?: EgressOverride): Promise<NetworkDiagnosis>;
}

export interface NetworkDiagnosis {
  url: string;
  policy: EgressPolicy;
  /** "allowed" | "blocked" — the static pre-flight decision. */
  decision: "allowed" | "blocked";
  reason?: string;
  /** How the target gets resolved for this request. */
  resolution: "local" | "proxy-side" | "static-literal";
  /** Locally resolved addresses with their classes (diagnostic only). */
  addresses?: Array<{ address: string; class: EgressAddressClass }>;
  lookupError?: string;
}

let policyVersionCounter = 0;

const parseProxyUrl = (
  raw: string,
): { uri: string; auth?: "basic"; origin: string } | { error: string } => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: `unparseable proxy URL` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: `unsupported proxy scheme "${url.protocol}" (http/https only)` };
  }
  const origin = `${url.protocol}//${url.host}`;
  if (url.username || url.password) {
    return { uri: origin, auth: "basic", origin };
  }
  return { uri: origin, origin };
};

const envProxyCandidate = (env: NodeJS.ProcessEnv): { raw: string; name: string } | null => {
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    const value = env[name]?.trim();
    if (value) return { raw: value, name };
  }
  return null;
};

const envNoProxy = (env: NodeJS.ProcessEnv): string[] => {
  const raw = env.NO_PROXY ?? env.no_proxy ?? "";
  return raw.split(",").map((e) => e.trim()).filter(Boolean);
};

/**
 * Resolve the egress policy for one request. `override` wins over env; a
 * malformed proxy never degrades into direct mode.
 */
export const resolveEgressPolicy = (
  override?: EgressOverride,
  env: NodeJS.ProcessEnv = process.env,
): EgressPolicy => {
  const base: Omit<EgressPolicy, "mode"> & { mode: EgressPolicy["mode"] } = {
    version: ++policyVersionCounter,
    mode: "direct",
    noProxy: envNoProxy(env),
    source: "none",
  };
  if (override?.noProxy) {
    base.noProxy = [...base.noProxy, ...override.noProxy.split(",").map((e) => e.trim()).filter(Boolean)];
  }

  if (override?.mode === "direct") {
    return { ...base, source: "override" };
  }

  const proxyRaw = override?.mode === "proxy" ? override.proxyUrl ?? "" : envProxyCandidate(env)?.raw ?? "";
  const source = override?.mode === "proxy" ? "override" : proxyRaw ? "env" : "none";
  if (!proxyRaw) {
    return { ...base, source };
  }

  const parsed = parseProxyUrl(proxyRaw);
  if ("error" in parsed) {
    return { ...base, source, invalid: parsed.error };
  }
  return {
    ...base,
    mode: "proxy",
    proxyOrigin: parsed.origin,
    ...(parsed.auth ? { proxyAuth: parsed.auth } : {}),
    source,
  };
};

/** Normalized hostname for NO_PROXY comparison (strip IPv6 brackets/port). */
const hostOf = (url: URL): string => url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

const matchesNoProxy = (url: URL, entries: string[]): boolean => {
  const host = hostOf(url);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const rawEntry of entries) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const [entryHost, entryPort] = entry.includes(":")
      ? [entry.replace(/:\d+$/, "").replace(/^\[|\]$/g, ""), entry.match(/:(\d+)$/)?.[1]]
      : [entry.replace(/^\[|\]$/g, ""), undefined];
    if (entryPort !== undefined && entryPort !== port) continue;
    const suffix = entryHost.startsWith(".") ? entryHost.slice(1) : entryHost;
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
};

const extractCauseCodes = (error: unknown): { codes: Set<string>; messages: string[] } => {
  const codes = new Set<string>();
  const messages: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 4 || value === null || typeof value !== "object") return;
    const err = value as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof err.code === "string") codes.add(err.code);
    if (typeof err.message === "string") messages.push(err.message);
    if (err.cause !== undefined && err.cause !== value) walk(err.cause, depth + 1);
    if (Array.isArray(err.errors)) for (const e of err.errors) walk(e, depth + 1);
  };
  walk(error, 0);
  return { codes, messages };
};

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ENODATA", "ESERVFAIL", "EBADNAME"]);
const TLS_CODES = [
  "CERT_", "ERR_TLS", "UNABLE_TO_", "DEPTH_ZERO", "SELF_SIGNED",
  "SSL_", "TLS_", "EPROTO", "X509",
];
const CONNECT_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT",
]);

/**
 * Map an arbitrary fetch failure into a typed egress error. `mode` decides
 * whether a socket-level connect failure means "proxy-unavailable" or
 * "connect" — in proxy mode every dial targets the proxy endpoint, so a
 * refusal there is the proxy being down.
 */
export const classifyEgressError = (error: unknown, mode: "direct" | "proxy" = "direct"): EgressError => {
  if (error instanceof EgressError) return error;
  // undici wraps connector-callback failures — a typed EgressError raised in
  // secureLookup survives only inside the cause chain.
  {
    let cursor: unknown = error;
    for (let depth = 0; depth < 4 && cursor !== null && typeof cursor === "object"; depth += 1) {
      if (cursor instanceof EgressError) return cursor;
      cursor = (cursor as { cause?: unknown }).cause;
    }
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new EgressError("cancelled", "request aborted");
  }
  const { codes, messages } = extractCauseCodes(error);
  const joined = messages.join(" ").toLowerCase();
  for (const code of codes) {
    if (DNS_CODES.has(code)) return new EgressError("dns", `DNS resolution failed (${code})`, { cause: error });
    if (TLS_CODES.some((t) => code.includes(t))) {
      return new EgressError("tls", `TLS failure (${code})`, { cause: error });
    }
  }
  if (joined.includes("proxy") && (joined.includes("407") || joined.includes("authentication"))) {
    return new EgressError("proxy-auth", "proxy authentication failed (407)", { cause: error });
  }
  for (const code of codes) {
    if (CONNECT_CODES.has(code)) {
      return new EgressError(
        mode === "proxy" ? "proxy-unavailable" : "connect",
        mode === "proxy" ? `proxy connection failed (${code})` : `connection failed (${code})`,
        { cause: error },
      );
    }
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new EgressError("cancelled", "request aborted");
  }
  return new EgressError("unknown", error instanceof Error ? error.message : "fetch failed", { cause: error });
};

export const EGRESS_TIMEOUT = "egress-timeout";

export const createEgressRuntime = (options: {
  env?: NodeJS.ProcessEnv;
  /** DNS resolver override — tests only; production uses `dns.promises.lookup`. */
  resolveAll?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
} = {}): EgressRuntime => {
  const env = options.env ?? process.env;
  const resolveAll = options.resolveAll ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));

  // SSRF on the connect path: the classified answer is the address the
  // socket actually dials. Any private/special answer refuses the connect;
  // DNS failure propagates as a typed "dns" error instead of a policy block.
  type ConnectLookupCallback = (
    err: Error | null,
    address?: string | Array<{ address: string; family: number }>,
    family?: number,
  ) => void;
  const secureLookup = (hostname: string, lookupOptions: { all?: boolean }, callback: ConnectLookupCallback): void => {
    void resolveAll(hostname).then(
      (addresses) => {
        if (!addresses.length) {
          callback(new EgressError("dns", `DNS resolution returned no addresses for ${hostname}`));
          return;
        }
        for (const addr of addresses) {
          const cls = classifyIp(addr.address);
          if (cls !== "public") {
            callback(new EgressError(
              cls === "private" ? "private-network" : "special-purpose",
              `target resolves to a ${cls === "private" ? "private" : "special-purpose"} address (${addr.address})`,
            ));
            return;
          }
        }
        if ("all" in lookupOptions && lookupOptions.all) {
          callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
          return;
        }
        callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (error) => callback(classifyEgressError(error)),
    );
  };

  const directDispatcher = new Agent({
    connect: { lookup: secureLookup as never },
  });

  const proxyDispatchers = new Map<string, Dispatcher>();
  const proxyDispatcherFor = (policy: EgressPolicy, rawUrl: string): Dispatcher => {
    const key = rawUrl;
    const cached = proxyDispatchers.get(key);
    if (cached) return cached;
    const parsed = new URL(rawUrl);
    const token = parsed.username || parsed.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`).toString("base64")}`
      : undefined;
    const dispatcher = new ProxyAgent({
      uri: policy.proxyOrigin!,
      ...(token ? { token } : {}),
    });
    proxyDispatchers.set(key, dispatcher);
    return dispatcher;
  };

  const resolve = (targetUrl: string, override?: EgressOverride): EgressResolution => {
    const policy = resolveEgressPolicy(override, env);
    const failure = (kind: EgressErrorKind, message: string): EgressResolution => ({
      policy,
      failure: new EgressError(kind, message),
    });

    let url: URL;
    try {
      url = new URL(targetUrl);
    } catch {
      return failure("scheme-denied", "unparseable URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return failure("scheme-denied", `unsupported scheme "${url.protocol}"`);
    }
    // Static hostname screening applies in every mode — literal/private
    // targets are refused before any socket opens.
    const staticClass = classifyHostname(url.hostname);
    if (staticClass) return failure(staticClass === "scheme" ? "scheme-denied" : staticClass, `hostname is ${staticClass}`);

    if (policy.invalid) {
      return failure("proxy-config-invalid", `proxy configuration invalid: ${policy.invalid}`);
    }
    if (policy.mode !== "proxy") {
      return { policy, dispatcher: directDispatcher };
    }
    if (matchesNoProxy(url, policy.noProxy)) {
      return { policy, dispatcher: directDispatcher, bypassedProxy: true };
    }
    // NOTE: explicit proxy URI keeps credentials — dispatcher cache is
    // keyed on the raw URL so rotated credentials build a fresh agent.
    const rawProxy = override?.mode === "proxy" ? override.proxyUrl! : envProxyCandidate(env)?.raw ?? "";
    return { policy, dispatcher: proxyDispatcherFor(policy, rawProxy) };
  };

  const fetch = (async (
    targetUrl: string,
    init: RequestInit & { dispatcher?: never } = {},
    override?: EgressOverride,
  ): Promise<Response> => {
    const resolved = resolve(targetUrl, override);
    if (resolved.failure) throw resolved.failure;
    const signal = init.signal ?? undefined;
    if (signal?.aborted) {
      throw signal.reason === EGRESS_TIMEOUT
        ? new EgressError("timeout", "request timed out")
        : new EgressError("cancelled", "request aborted");
    }
    try {
      return await undiciFetch(targetUrl, {
        ...init,
        signal: signal as never,
        dispatcher: resolved.dispatcher!,
      } as never) as unknown as Response;
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason === EGRESS_TIMEOUT
          ? new EgressError("timeout", "request timed out")
          : classifyEgressError(signal.reason ?? error, resolved.policy.mode);
      }
      const classified = classifyEgressError(error, resolved.policy.mode);
      // A 407 surfaced by the proxy CONNECT handshake is proxy auth.
      if (classified.kind === "unknown" && /407/.test(classified.message)) {
        throw new EgressError("proxy-auth", "proxy authentication failed (407)", { cause: error });
      }
      throw classified;
    }
  }) as EgressFetch;

  const diagnose = async (targetUrl: string, override?: EgressOverride): Promise<NetworkDiagnosis> => {
    const resolved = resolve(targetUrl, override);
    const policy = resolved.policy;
    if (resolved.failure) {
      return {
        url: targetUrl,
        policy,
        decision: "blocked",
        reason: `${resolved.failure.kind}: ${resolved.failure.message}`,
        resolution: "static-literal",
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return { url: targetUrl, policy, decision: "blocked", reason: "unparseable URL", resolution: "static-literal" };
    }
    if (policy.mode === "proxy" && !resolved.bypassedProxy) {
      // Target DNS happens inside the proxy — report that honestly instead of
      // pretending local answers prove the fetch path.
      return {
        url: targetUrl,
        policy,
        decision: "allowed",
        resolution: "proxy-side",
      };
    }
    try {
      const addresses = await resolveAll(hostOf(parsed));
      return {
        url: targetUrl,
        policy,
        decision: "allowed",
        resolution: "local",
        addresses: addresses.map((a) => ({ address: a.address, class: classifyIp(a.address) })),
      };
    } catch (error) {
      return {
        url: targetUrl,
        policy,
        decision: "allowed",
        resolution: "local",
        lookupError: error instanceof Error ? error.message : "lookup failed",
      };
    }
  };

  return { resolvePolicy: (override) => resolveEgressPolicy(override, env), resolve, fetch, diagnose };
};
