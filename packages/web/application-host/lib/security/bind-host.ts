// @ts-nocheck
import net from 'node:net';

const stripIpv6Brackets = (value) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const normalizeIpv4MappedAddress = (host) => {
  const normalized = stripIpv6Brackets(host);
  const match = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return match ? match[1] : normalized;
};

const ALL_NUMERIC_DOTTED_RE = /^\d+(?:\.\d+)*$/;

/** Normalize a Node TCP bind host without resolving it or narrowing valid DNS names. */
export const normalizeBindHost = (host) => {
  if (typeof host !== 'string') return null;
  const trimmed = host.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('[') || trimmed.endsWith(']')) {
    if (!(trimmed.startsWith('[') && trimmed.endsWith(']'))) return null;
    const address = trimmed.slice(1, -1);
    return net.isIP(address) === 6 ? address : null;
  }
  if (net.isIP(trimmed) !== 0) return trimmed;
  if (ALL_NUMERIC_DOTTED_RE.test(trimmed)) return null;
  if (/[\s/:\\@?#]/u.test(trimmed)) return null;

  const hostname = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  if (!hostname || hostname.length > 253 || hostname.split('.').some((label) => !label)) return null;
  return trimmed;
};

const isLoopbackIpv4 = (host) => {
  if (net.isIP(host) !== 4) return false;
  const first = Number.parseInt(host.split('.')[0] || '', 10);
  return first === 127;
};

export const isLoopbackBindHost = (host) => {
  const normalized = normalizeIpv4MappedAddress(host);
  if (!normalized) return false;
  if (normalized === 'localhost') return true;
  if (isLoopbackIpv4(normalized)) return true;
  return net.isIP(normalized) === 6 && normalized === '::1';
};

export const isNetworkExposedBindHost = (host) => !isLoopbackBindHost(host);

export const getInvalidBindHostErrorMessage = (host) =>
  `Invalid Piarium bind host: ${JSON.stringify(host)}. Use a hostname or IP address without a URL scheme, port, or path.`;

export const isUnsafeUnauthenticatedLanAllowed = (env = process.env) =>
  env?.PIARIUM_ALLOW_UNAUTHENTICATED_LAN === 'true';

export const getUnauthenticatedLanErrorMessage = (host) =>
  `Piarium refuses to bind to ${host || 'a network-exposed host'} without UI authentication. `
  + 'Set --ui-password or PIARIUM_UI_PASSWORD before exposing it over LAN, '
  + 'or set PIARIUM_ALLOW_UNAUTHENTICATED_LAN=true to accept the risk.';
