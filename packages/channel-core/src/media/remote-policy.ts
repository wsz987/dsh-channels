/**
 * Pure SSRF / URL policy utilities. No network I/O of any kind.
 *
 * These functions decide whether a remote media URL may be fetched by the
 * secure host boundary:
 *
 * - require an `http(s)` scheme (https by default; http opt-in)
 * - reject private / loopback / link-local / ULA / unspecified IPs
 * - re-validate hostnames through an injected resolver hook
 * - bound redirect depth
 * - strip auth headers across origins
 *
 * A resolver hook `(host) => ip[]` is injected so tests can run fully offline
 * with fake resolution; production wires the same hook to `node:dns/promises`.
 */

import net from 'node:net';

/**
 * A hostname → IP addresses resolver hook. Tests inject fakes; production can
 * use `node:dns/promises`. Returns IP strings (IPv4 and/or IPv6).
 */
export type Resolver = (host: string) => Promise<readonly string[]>;

/** Raised when a URL is not fetchable under the remote-policy rules. */
export class UnsafeHostError extends Error {
  /** The offending URL. */
  readonly url: string;
  constructor(url: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnsafeHostError';
    this.url = url;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Default maximum redirect hop count (plan §12). */
export const DEFAULT_MAX_REDIRECTS = 5;

/** Parse an IPv4 dotted-quad string to a 32-bit unsigned int, or null. */
function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((p) => p > 255)) return null;
  return (
    ((parts[0]! << 24) >>> 0) +
    ((parts[1]! << 16) >>> 0) +
    ((parts[2]! << 8) >>> 0) +
    parts[3]!
  );
}

function isPrivateIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;

  if (n === 0) return true; // 0.0.0.0

  for (const [base, bits] of [
    [0x0a000000 >>> 0, 8], // 10.0.0.0/8
    [0x7f000000 >>> 0, 8], // 127.0.0.0/8 loopback
    [0xa9fe0000 >>> 0, 16], // 169.254.0.0/16 link-local
    [0xc0a80000 >>> 0, 16], // 192.168.0.0/16
    [0xac100000 >>> 0, 12], // 172.16.0.0/12
  ] as const) {
    const mask = ~((1 << (32 - bits)) - 1) >>> 0;
    if (((n & mask) >>> 0) === base) return true;
  }
  return false;
}

/** Expand an IPv6 literal to a 128-bit bigint, or null. */
function ipv6ToBigInt(ip: string): bigint | null {
  let t = ip.trim();
  if (t.includes('.')) {
    const lastColon = t.lastIndexOf(':');
    const head = t.slice(0, lastColon + 1);
    const tail = t.slice(lastColon + 1);
    const ipv4 = ipv4ToInt(tail);
    if (ipv4 === null) return null;
    const hi = (ipv4 >>> 16) & 0xffff;
    const lo = ipv4 & 0xffff;
    t = head + hi.toString(16) + ':' + lo.toString(16);
  }

  const doubleColon = t.indexOf('::');
  let groups: string[];
  if (doubleColon !== -1) {
    const left = t.slice(0, doubleColon);
    const right = t.slice(doubleColon + 2);
    const leftGroups = left ? left.split(':') : [];
    const rightGroups = right ? right.split(':') : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing < 1) return null;
    groups = [...leftGroups, ...Array<string>(missing).fill('0'), ...rightGroups];
  } else {
    groups = t.split(':');
  }
  if (groups.length !== 8) return null;

  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

function isPrivateIPv6(ip: string): boolean {
  const v = ipv6ToBigInt(ip);
  if (v === null) return false;
  if (v === 0n) return true; // ::/128 unspecified
  if (v === 1n) return true; // ::1 loopback
  // fe80::/10 link-local → top 10 bits 1111111010
  if (v >> 118n === 0x3fan) return true;
  // fc00::/7 ULA → top 7 bits 1111110
  if (v >> 121n === 0x7en) return true;
  return false;
}

/**
 * Return true if `ip` (IPv4 or IPv6 literal string) is a private, loopback,
 * link-local, ULA, or unspecified address that must not be fetched against.
 */
export function isPrivateIp(ip: string): boolean {
  const trimmed = ip.trim();
  if (net.isIPv4(trimmed)) return isPrivateIPv4(trimmed);
  if (net.isIPv6(trimmed)) return isPrivateIPv6(trimmed);
  return false;
}

/** Strip brackets from a bracketed IPv6 hostname literal, if present. */
export function stripBrackets(hostname: string): string {
  if (hostname.length >= 2 && hostname[0] === '[' && hostname[hostname.length - 1] === ']') {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/** Options for `assertSafeMediaUrl`. */
export interface AssertSafeMediaUrlOptions {
  /**
   * Permit the insecure http:// scheme. Defaults to false — https is the only
   * allowed scheme unless this is explicitly enabled.
   */
  allowHttp?: boolean;
  /**
   * Hostname → IP resolver hook. When provided, every DNS name is resolved
   * and rejected if ANY resolved address is unsafe. Omit to skip resolution
   * (still rejects IP-literal URLs).
   */
  resolver?: Resolver;
}

/**
 * Validate that `url` is fetchable by the secure media boundary.
 *
 * - Must be http(s); `allowHttp` opts a naked `http` scheme in.
 * - IP-literal hosts are checked directly against `isPrivateIp`.
 * - Hostnames are resolved through the injected `resolver` and rejected if any
 *   address is unsafe (DNS rebinding defense, plan §12).
 *
 * Pure and offline when no resolver is injected. Throws `UnsafeHostError` on
 * any violation. Resolves the validated `URL` otherwise.
 */
export async function assertSafeMediaUrl(
  url: string,
  options: AssertSafeMediaUrlOptions = {},
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeHostError(url, `invalid URL: ${url}`);
  }

  const protocol = parsed.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new UnsafeHostError(url, `non-http scheme "${protocol}" is not allowed`);
  }
  if (protocol === 'http:' && !options.allowHttp) {
    throw new UnsafeHostError(url, 'http scheme requires explicit allowHttp');
  }

  const host = stripBrackets(parsed.hostname);
  if (net.isIP(host) !== 0) {
    if (isPrivateIp(host)) {
      throw new UnsafeHostError(url, `unsafe IP host "${host}"`);
    }
    return parsed;
  }

  if (options.resolver) {
    let ips: readonly string[];
    try {
      ips = await options.resolver(host);
    } catch (err) {
      throw new UnsafeHostError(
        url,
        `unable to resolve host "${host}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const ip of ips) {
      if (isPrivateIp(ip)) {
        throw new UnsafeHostError(url, `host "${host}" resolves to unsafe IP "${ip}"`);
      }
    }
  }

  return parsed;
}

/** Auth-bearing header names forwarded to media hosts only on the same origin. */
export const AUTH_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'cookie2',
]);

/** True when two origins are protocol+host+port identical. */
export function sameOrigin(a: string, b: string): boolean {
  let ua: URL;
  let ub: URL;
  try {
    ua = new URL(a);
    ub = new URL(b);
  } catch {
    return false;
  }
  return ua.protocol === ub.protocol && ua.hostname === ub.hostname && ua.port === ub.port;
}

/**
 * Return a copy of `headers` with auth-bearing headers removed when the
 * redirect target origin differs from the source origin.
 *
 * - Same origin → the copy is unchanged.
 * - Cross origin → Authorization / Proxy-Authorization / Cookie / Cookie2 are
 *   dropped (preventing bearer/cookie leakage across CDN hops).
 *
 * @param headers       The request headers currently being forwarded.
 * @param sourceOrigin  The origin the request started from (e.g. `https://a.com`).
 * @param targetOrigin  The origin the next hop is going to.
 */
export function stripCrossOriginAuthHeader(
  headers: Headers,
  sourceOrigin: string,
  targetOrigin: string,
): Headers {
  const out = new Headers();
  if (sameOrigin(sourceOrigin, targetOrigin)) {
    headers.forEach((v, k) => out.set(k, v));
    return out;
  }
  headers.forEach((v, k) => {
    if (!AUTH_HEADER_NAMES.has(k.toLowerCase())) {
      out.set(k, v);
    }
  });
  return out;
}
