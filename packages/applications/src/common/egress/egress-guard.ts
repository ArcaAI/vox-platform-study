// TASK-846 D-3 — SSRF egress guard for tenant-authored connector URLs.
//
// WHY THIS EXISTS. TASK-846 (OD-7) let tenant admins author `McpServer.baseUrl`, and the
// harness worker connects to whatever that field says. Inside a k3s cluster an unconstrained
// URL reaches the Kubernetes API, Vault on loopback, PgBouncer, and the cloud metadata
// endpoint — server-side request forgery with a paying tenant as the attacker.
//
// This module is the WRITE-TIME half (immediate, accurate admin feedback). The CALL-TIME
// half — the one that actually protects, because DNS can change long after the row is
// saved — is `apps/harness/src/harness/tools/egress_guard.py`. The two are independent
// hand-written implementations held together by `tests/fixtures/egress-vectors.json`,
// which both test suites load. A new rule goes in the fixture first.
//
// FOUR PROPERTIES THIS FILE IS OBLIGED TO HAVE:
//
//  1. ALLOW-LIST, DENY-BY-DEFAULT. Never a deny-list — a deny-list loses to the first
//     encoding trick, and the trick only has to work once.
//
//  2. THE RESOLVED ADDRESS IS WHAT IS VALIDATED, not the hostname string.
//     `evil.example.com` resolving to `10.0.0.5` passes any string check ever written.
//     `evaluateEgress` therefore returns the exact addresses it validated in `pinned`,
//     and THE CALLER IS OBLIGED TO CONNECT TO THOSE. Validating a name and then letting
//     the socket layer re-resolve it is the classic DNS-rebinding TOCTOU: the attacker
//     answers the first lookup with a public address and the second with 169.254.169.254.
//
//  3. ANY blocked address in a multi-address answer denies the WHOLE url. Allowing the
//     "good" address of a split answer just invites the attacker to race the connect.
//
//  4. FAIL CLOSED. An unresolvable allow-list, a malformed stored value, a DNS failure
//     and an unparseable IP all DENY. There is no path through this file where "we could
//     not check" becomes "allowed" — which is why `isBlockedAddress` returns `true` for
//     junk rather than throwing.
//
// EXPLICIT CIDRs, NOT A STDLIB `isPrivate` FLAG. The blocked set below is written out so a
// reviewer can audit it against RFC 1918/3927/4193/6598 line by line, and because the
// stdlib notions of "private" differ between Node and Python (Python's `is_private` also
// covers the TEST-NET documentation ranges, which would make half the test fixture
// unusable). Two hand-written implementations can only agree on a table they both state.

import { isIP } from 'node:net';

export type EgressDenyReason =
  /** The stored allow-list could not be read, or is not a string[] — fail closed. */
  | 'allowlist_unavailable'
  /** Not http(s), or the URL did not parse at all. */
  | 'scheme_not_allowed'
  /** Inline `user:pass@` — a credential smell and a cross-parser host-confusion vector. */
  | 'userinfo_not_allowed'
  /** The host is not on the allow-list (deny-by-default). */
  | 'host_not_allowed'
  /** No address to validate (NXDOMAIN, empty answer, or resolver failure). */
  | 'unresolvable'
  /** At least one resolved address falls in a blocked range. */
  | 'blocked_address';

export interface EgressDecision {
  allowed: boolean;
  /**
   * The host only — NEVER the full URL. A connector URL can carry a token in its query
   * string, and this value is written to logs on every rejection.
   */
  host: string;
  reason?: EgressDenyReason;
  /** Admin-facing explanation. Safe to surface in a 400; names no address the caller did not supply. */
  detail?: string;
  /** The validated addresses. The caller MUST connect to these — see property (2). */
  pinned?: string[];
}

/** Resolve a hostname to its addresses. Injected so tests need no DNS and callers can pick a resolver. */
export type HostResolver = (hostname: string) => Promise<string[]>;

/** IPv4 ranges that must never be reachable from a tenant-authored URL. */
const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network" — reaches localhost on many stacks
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // RFC 6598 carrier-grade NAT — routable inside cloud/cluster fabrics
  ['127.0.0.0', 8], // loopback — Vault, PgBouncer, sidecars
  ['169.254.0.0', 16], // RFC 3927 link-local — THE cloud metadata endpoint
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // RFC 2544 benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255 broadcast
];

/** IPv6 ranges blocked outright (embedded-IPv4 forms are unwrapped separately). */
const BLOCKED_IPV6: ReadonlyArray<readonly [string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // RFC 6666 discard-only
  ['fc00::', 7], // RFC 4193 unique-local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];

function parseIPv4(value: string): Uint8Array | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    // Reject empty, non-numeric, and leading-zero forms (`0177.0.0.1` is octal elsewhere).
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part[0] === '0') return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

function parseIPv6(value: string): Uint8Array | null {
  let text = value;
  // A zone index (`fe80::1%eth0`) never survives into a connect target here.
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const expand = (segment: string): number[] | null => {
    if (segment === '') return [];
    const groups: number[] = [];
    const tokens = segment.split(':');
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      // A trailing dotted-quad (`::ffff:10.0.0.1`) occupies the last two groups.
      if (token.includes('.')) {
        if (i !== tokens.length - 1) return null;
        const v4 = parseIPv4(token);
        if (!v4) return null;
        groups.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(token)) return null;
      groups.push(parseInt(token, 16));
    }
    return groups;
  };

  const head = expand(halves[0]!);
  const tail = halves.length === 2 ? expand(halves[1]!) : [];
  if (head === null || tail === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null; // `::` must elide at least one group
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = groups[i]! >> 8;
    bytes[i * 2 + 1] = groups[i]! & 0xff;
  }
  return bytes;
}

function inRange(address: Uint8Array, network: Uint8Array, prefix: number): boolean {
  let bitsLeft = prefix;
  for (let i = 0; i < address.length && bitsLeft > 0; i++) {
    const take = Math.min(8, bitsLeft);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((address[i]! & mask) !== (network[i]! & mask)) return false;
    bitsLeft -= take;
  }
  return true;
}

function isBlockedIPv4(bytes: Uint8Array): boolean {
  return BLOCKED_IPV4.some(([network, prefix]) => inRange(bytes, parseIPv4(network)!, prefix));
}

/**
 * The IPv4 address embedded in an IPv6 one, or `null`.
 *
 * Every one of these is a real bypass if left unwrapped: `::ffff:169.254.169.254` and
 * `64:ff9b::a9fe:a9fe` both reach the metadata endpoint on a dual-stack host.
 */
function embeddedIPv4(bytes: Uint8Array): Uint8Array | null {
  const zeros = (from: number, to: number): boolean => bytes.slice(from, to).every((b) => b === 0);

  // ::ffff:0:0/96 — IPv4-mapped
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12, 16);
  // 64:ff9b::/96 — RFC 6052 NAT64 well-known prefix
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12)) return bytes.slice(12, 16);
  // 2002::/16 — 6to4, the embedded v4 is bytes 2..5
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.slice(2, 6);
  // ::/96 — deprecated IPv4-compatible (`::` and `::1` are caught by BLOCKED_IPV6 first)
  if (zeros(0, 12)) return bytes.slice(12, 16);
  return null;
}

/**
 * Is this literal address in a range a tenant-authored URL must never reach?
 *
 * An UNPARSEABLE value returns `true`. That is deliberate: this predicate sits on a
 * security path, and "I could not tell" must mean "no".
 */
export function isBlockedAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return isBlockedIPv4(v4);

  const v6 = parseIPv6(address);
  if (!v6) return true; // unparseable ⇒ blocked

  if (BLOCKED_IPV6.some(([network, prefix]) => inRange(v6, parseIPv6(network)!, prefix))) return true;

  const embedded = embeddedIPv4(v6);
  return embedded ? isBlockedIPv4(embedded) : false;
}

/** The 16/4-byte form of an address literal, as a comparable string; `null` if not an IP. */
function canonicalAddress(value: string): string | null {
  const v4 = parseIPv4(value);
  if (v4) return `v4:${v4.join('.')}`;
  const v6 = parseIPv6(value);
  if (v6) return `v6:${Array.from(v6).join('.')}`;
  return null;
}

/**
 * Does `host` match the allow-list?
 *
 * An entry is either an exact host, or a leading-dot suffix (`.tools.example.org`) that
 * matches that domain AND any subdomain of it. The leading dot is what makes the match
 * LABEL-AWARE rather than a substring test: without it `tools.example.org` would also
 * match `eviltools.example.org`, which is a registerable domain an attacker can own.
 *
 * An entry that is an IP LITERAL is compared by its parsed bytes, not by its text. The
 * same IPv6 address has many spellings (`::ffff:10.0.0.1` == `::ffff:a00:1`,
 * `2002:0a00:0001::1` == `2002:a00:1::1`) and the URL parser hands us the normalised one,
 * so a text comparison would silently fail to match an entry an operator did write. That
 * direction is a false DENIAL rather than a bypass — the address check still runs either
 * way — but a security control nobody can configure correctly gets turned off.
 */
function hostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const hostAddress = canonicalAddress(host);
  return allowedHosts.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === '') return false;
    if (entry.startsWith('.')) return host === entry.slice(1) || host.endsWith(entry);
    if (hostAddress !== null) return canonicalAddress(entry) === hostAddress;
    return host === entry;
  });
}

function deny(host: string, reason: EgressDenyReason, detail: string): EgressDecision {
  return { allowed: false, host, reason, detail };
}

/**
 * Decide whether `rawUrl` may be contacted, and with which addresses.
 *
 * `allowedHosts` comes from the `mcp.egress.allowedHosts` registry key. `null`/`undefined`
 * (the control plane has no opinion) and any malformed stored value DENY — an unreadable
 * security control is never an open one.
 */
export async function evaluateEgress(
  rawUrl: string,
  allowedHosts: readonly string[] | null | undefined,
  resolveHost: HostResolver,
): Promise<EgressDecision> {
  if (!Array.isArray(allowedHosts) || allowedHosts.some((entry) => typeof entry !== 'string')) {
    return deny(
      '',
      'allowlist_unavailable',
      'The platform egress allow-list (`mcp.egress.allowedHosts`) is unset or malformed. Outbound connectors are refused until a platform administrator configures it.',
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return deny('', 'scheme_not_allowed', 'The URL could not be parsed. Provide an absolute http(s) URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return deny('', 'scheme_not_allowed', `Scheme '${url.protocol.replace(':', '')}' is not permitted; use http or https.`);
  }

  if (url.username !== '' || url.password !== '') {
    return deny('', 'userinfo_not_allowed', 'Credentials embedded in the URL are not permitted. Use `authRef` (a Vault path) instead.');
  }

  // WHATWG lowercases the hostname and normalises numeric IPv4 forms; IPv6 literals
  // arrive bracketed.
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === '') return deny('', 'scheme_not_allowed', 'The URL has no host.');

  if (!hostAllowed(host, allowedHosts)) {
    return deny(host, 'host_not_allowed', `Host '${host}' is not on the platform egress allow-list. Ask a platform administrator to add it.`);
  }

  // A literal address needs no lookup — and must not get one, or we would validate a
  // different thing from the one we were given.
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await resolveHost(host);
    } catch {
      return deny(host, 'unresolvable', `Host '${host}' could not be resolved, so its address could not be checked.`);
    }
    if (addresses.length === 0) {
      return deny(host, 'unresolvable', `Host '${host}' did not resolve to any address.`);
    }
  }

  // Property (3): ANY blocked address denies the whole URL.
  const blocked = addresses.filter((address) => isBlockedAddress(address));
  if (blocked.length > 0) {
    return deny(
      host,
      'blocked_address',
      `Host '${host}' resolves to an address in a restricted range (private, loopback, link-local/metadata, or multicast). Connectors may only reach external services.`,
    );
  }

  return { allowed: true, host, pinned: addresses };
}
