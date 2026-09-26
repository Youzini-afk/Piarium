/**
 * SSRF policy for web fetch — blocks private, loopback, and reserved network ranges.
 *
 * Reuses the same IP classification logic as the preview proxy runtime
 * (lib/preview/proxy-runtime.ts `isBlockedExternalHost`) and tunnel auth
 * (lib/platform/tunnel-auth.ts `isPrivateOrLoopbackIp`), extracted here
 * for use by the harness web fetch service.
 *
 * The URL check is intentionally static: scheme rules and hostname/literal
 * classification only. DNS answers are classified on the actual connection
 * path (see lib/harness/egress.ts `secureLookup`) so the checked result is
 * the same address the socket dials — no check-then-fetch gap. `checkSsrf`
 * therefore never reports a DNS failure as "private-network".
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type SsrfBlockReason = "private-network" | "scheme" | "special-purpose";

export interface SsrfCheckResult {
  blocked: boolean;
  reason?: SsrfBlockReason;
}

export type EgressAddressClass = "public" | "private" | "special-purpose";

/**
 * Normalize an IP literal as it may appear inside a URL hostname:
 * strip IPv6 brackets, drop zone ids (`fe80::1%eth0`), lowercase.
 */
const normalizeIpLiteral = (host: string): string => {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const zone = h.indexOf("%");
  if (zone >= 0) h = h.slice(0, zone);
  return h;
};

const classifyIpv4 = (ip: string): EgressAddressClass => {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return "public";
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 0 || a === 127 || a === 10) return "private";
  if (a === 169 && b === 254) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  // Special-purpose ranges a consumer sees when a resolver answers with
  // synthetic mappings (Clash/v2ray fake-IP uses 198.18.0.0/15) or that can
  // never route publicly. Reported separately so the failure surfaces the
  // real reason instead of a misleading "private network" label.
  if (a === 198 && (b === 18 || b === 19)) return "special-purpose";
  if (a >= 240) return "special-purpose"; // 240.0.0.0/4 reserved + broadcast
  return "public";
};

const classifyIpv6 = (ip: string): EgressAddressClass => {
  const h = normalizeIpLiteral(ip);
  if (h === "::1" || h === "::") return "private";
  // IPv4-embedded forms reach whatever the embedded v4 address reaches —
  // classify the embedded address so a mapped public host stays reachable
  // while a mapped private one is still refused.
  const mapped = h.match(/^::ffff:(?:0:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return classifyIpv4(mapped[1]!);
  if (h.includes("::ffff:")) return "private"; // hex-form mapped address
  const nat64 = h.match(/^64:ff9b::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (nat64) return classifyIpv4(nat64[1]!);
  // NAT64 hex form: 64:ff9b::HHHH:HHHH embeds the v4 in the last two groups.
  const nat64Hex = h.match(/^64:ff9b::(?:0:)*([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (nat64Hex) {
    const hi = parseInt(nat64Hex[1]!, 16);
    const lo = parseInt(nat64Hex[2]!, 16);
    return classifyIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  if (h.startsWith("64:ff9b::")) return "special-purpose";
  const to6 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})/);
  if (to6) {
    const a = parseInt(to6[1]!, 16);
    const b = parseInt(to6[2]!, 16);
    return classifyIpv4(`${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`);
  }
  if (h.startsWith("fe80")) return "private"; // fe80::/10 link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return "private"; // fc00::/7 ULA
  if (h.startsWith("ff")) return "special-purpose"; // ff00::/8 multicast
  return "public";
};

/** Classify a resolved IP address. */
export const classifyIp = (ip: string): EgressAddressClass => {
  const normalized = normalizeIpLiteral(ip);
  const kind = isIP(normalized);
  if (kind === 4) return classifyIpv4(normalized);
  if (kind === 6) return classifyIpv6(normalized);
  return "public";
};

/**
 * Static hostname classification — names and literals only, no DNS.
 * Returns the block reason when the hostname itself is forbidden.
 */
export const classifyHostname = (hostname: string): SsrfBlockReason | null => {
  const host = normalizeIpLiteral(hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return "private-network";
  }
  if (isIP(host) === 0) return null; // ordinary DNS name — resolved on connect
  const cls = classifyIp(host);
  if (cls === "private") return "private-network";
  if (cls === "special-purpose") return "special-purpose";
  return null;
};

/**
 * Resolve a hostname and report the class of every answer. Used by the
 * read-only diagnostics surface; the enforcement path classifies inside the
 * connector lookup instead.
 */
export const resolveAddressClasses = async (
  hostname: string,
): Promise<Array<{ address: string; class: EgressAddressClass }>> => {
  const host = normalizeIpLiteral(hostname);
  if (isIP(host) > 0) return [{ address: host, class: classifyIp(host) }];
  const addresses = await lookup(host, { all: true, verbatim: true });
  return addresses.map((addr) => ({ address: addr.address, class: classifyIp(addr.address) }));
};

/**
 * Check if a URL is safe to fetch — static decision only.
 * - Must be http: or https:
 * - Hostname literals/names must not be private or special-purpose.
 *   DNS results are enforced on the connect path (egress runtime).
 */
export const checkSsrf = async (url: string): Promise<SsrfCheckResult> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { blocked: true, reason: "scheme" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { blocked: true, reason: "scheme" };
  }

  const hostnameClass = classifyHostname(parsed.hostname);
  if (hostnameClass) {
    return { blocked: true, reason: hostnameClass };
  }

  return { blocked: false };
};

/**
 * Check if a URL's hostname matches the same origin as another URL.
 * Used for redirect following — only same-hostname redirects are auto-followed.
 */
export const isSameHost = (url1: string, url2: string): boolean => {
  try {
    const u1 = new URL(url1);
    const u2 = new URL(url2);
    return u1.hostname === u2.hostname;
  } catch {
    return false;
  }
};
