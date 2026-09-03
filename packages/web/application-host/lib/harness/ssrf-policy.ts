/**
 * SSRF policy for web fetch — blocks private, loopback, and reserved network ranges.
 *
 * Reuses the same IP classification logic as the preview proxy runtime
 * (lib/preview/proxy-runtime.ts `isBlockedExternalHost`) and tunnel auth
 * (lib/platform/tunnel-auth.ts `isPrivateOrLoopbackIp`), extracted here
 * for use by the harness web fetch service.
 *
 * This module does DNS resolution + IP pinning to prevent DNS rebinding attacks.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type SsrfBlockReason = "private-network" | "scheme";

export interface SsrfCheckResult {
  blocked: boolean;
  reason?: SsrfBlockReason;
}

/**
 * Check if a hostname is a private/loopback/reserved address.
 * Works on both IP literals and hostnames (does DNS resolution).
 */
const isPrivateHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;

  // IPv4 literal
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  // IPv6 literal
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    if (host.startsWith("fe80")) return true;
    if (host.startsWith("fc") || host.startsWith("fd")) return true;
    if (host.includes("::ffff:")) return true;
    return false;
  }

  return false;
};

/**
 * Resolve a hostname and check if any resolved address is private/reserved.
 * This prevents DNS rebinding attacks where a hostname resolves to a public IP
 * initially but later resolves to a private IP.
 */
export const isPrivateResolvedAddress = async (hostname: string): Promise<boolean> => {
  // If it's already an IP literal, check directly
  if (isIP(hostname) > 0) {
    return isPrivateHostname(hostname);
  }

  try {
    const addresses = await lookup(hostname, { all: true });
    return addresses.some((addr) => isPrivateHostname(addr.address));
  } catch {
    // DNS resolution failed — block by default (conservative)
    return true;
  }
};

/**
 * Check if a URL is safe to fetch.
 * - Must be http: or https:
 * - Hostname must not resolve to private/reserved ranges
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

  const isPrivate = await isPrivateResolvedAddress(parsed.hostname);
  if (isPrivate) {
    return { blocked: true, reason: "private-network" };
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
