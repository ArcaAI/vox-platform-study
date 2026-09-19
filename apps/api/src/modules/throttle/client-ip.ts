/**
 * Which address the rate limiter counts a request against.
 *
 * ## The problem this solves (TASK-993 D-1)
 *
 * `@nestjs/throttler` keys every bucket on `req.ip`, and Express `trust proxy`
 * is deliberately OFF in `main.ts`, so `req.ip` is the raw SOCKET PEER. Behind
 * this platform's ingress — `Cloudflare edge → cloudflared → Traefik → pod` —
 * that peer is the Traefik pod address for 100% of traffic, so every client in
 * the world shared ONE bucket per route (`POST /auth/login` at 5/min,
 * platform-wide).
 *
 * ## Why NOT `trust proxy`, and why NOT `X-Forwarded-For`
 *
 * Two separate reasons, and both matter:
 *
 *  1. **`X-Forwarded-For` carries the wrong address here.** Traefik's own TCP
 *     peer is the cloudflared pod, so whatever Traefik appends names
 *     cloudflared, not the browser. Cloudflare's edge stamps the real client
 *     into `CF-Connecting-IP` BEFORE the request enters the tunnel, and that is
 *     the only header on this path that holds it.
 *  2. **`app.set('trust proxy', …)` would trust that header from ANY caller.**
 *     It is a global Express switch with no notion of which hop asserted it, so
 *     turning it on hands every direct caller a private bucket for free.
 *
 * So the trust is expressed here instead, explicitly and narrowly: a claimed
 * client address is believed ONLY when the socket peer is itself a declared
 * ingress. `RATE_LIMIT_TRUSTED_PROXIES` (env tier — deployment topology, see
 * `apps/api/src/config/env.descriptors.ts`) holds that list, and its default is
 * EMPTY, which reproduces today's behaviour exactly: no declared ingress means
 * nothing is trusted and the socket peer is the key.
 */

/** One address, widened to a bigint so v4 and v6 compare the same way. */
interface ParsedIp {
  value: bigint;
  /** 32 for IPv4, 128 for IPv6. Two addresses of different widths never match. */
  bits: number;
}

/** One entry of the trusted list: an address plus the prefix length to compare. */
export interface TrustedProxy extends ParsedIp {
  prefix: number;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;

/** The IPv4-mapped IPv6 prefix (`::ffff:0:0/96`) Node hands back on a dual-stack listener. */
const V4_MAPPED_PREFIX = 0xffffn;
const V4_MAPPED_SHIFT = 32n;

function parseIpv4(text: string): bigint | null {
  const match = IPV4.exec(text);
  if (!match) return null;

  let value = 0n;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(match[i]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function parseIpv6(text: string): bigint | null {
  if (!text.includes(':')) return null;

  // A trailing dotted quad (`::ffff:10.0.0.1`, `64:ff9b::203.0.113.1`) is legal
  // IPv6 text. Rewrite it into the two hex groups it stands for so the group
  // parser below stays a single loop.
  let head = text;
  const lastColon = head.lastIndexOf(':');
  const trailing = head.slice(lastColon + 1);
  if (trailing.includes('.')) {
    const quad = parseIpv4(trailing);
    if (quad === null) return null;
    head = `${head.slice(0, lastColon + 1)}${((quad >> 16n) & 0xffffn).toString(16)}:${(quad & 0xffffn).toString(16)}`;
  }

  const halves = head.split('::');
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  let groups: string[];
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    // `::` must stand for at least one zero group.
    if (left.length + right.length > 7) return null;
    groups = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  }

  let value = 0n;
  for (const group of groups) {
    if (!IPV6_GROUP.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

/**
 * Strip the decorations Node and operators attach to an address: a bracketed
 * literal (`[::1]:443` arrives as `[::1]`), a scope id (`fe80::1%eth0`), and
 * surrounding whitespace.
 */
function strip(raw: string): string {
  let ip = raw.trim();
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end > 0) ip = ip.slice(1, end);
  }
  const zone = ip.indexOf('%');
  return zone >= 0 ? ip.slice(0, zone) : ip;
}

/**
 * One address as a comparable value, or `null` when the text is not an address.
 *
 * An IPv4-mapped IPv6 address is FOLDED to its IPv4 form. That is not cosmetic:
 * a dual-stack listener reports the peer as `::ffff:10.42.0.5`, and an operator
 * writes the trusted list as `10.42.0.0/16`. Without the fold the two never
 * match and the whole trust check silently never fires.
 */
export function parseIp(raw: string): ParsedIp | null {
  const text = strip(raw);
  if (!text) return null;

  const v4 = parseIpv4(text);
  if (v4 !== null) return { value: v4, bits: 32 };

  const v6 = parseIpv6(text);
  if (v6 === null) return null;

  if (v6 >> V4_MAPPED_SHIFT === V4_MAPPED_PREFIX) {
    return { value: v6 & 0xffffffffn, bits: 32 };
  }
  return { value: v6, bits: 128 };
}

/**
 * Parse `RATE_LIMIT_TRUSTED_PROXIES`: a comma-separated list of CIDR blocks
 * (`10.42.0.0/16`) and bare addresses (`127.0.0.1`, treated as a /32 or /128).
 * Unparseable entries are DROPPED rather than throwing — a typo in a topology
 * variable must not refuse the gateway's boot, and dropping one narrows the
 * trust, which is the safe direction.
 */
export function parseTrustedProxies(raw: string | undefined): TrustedProxy[] {
  if (!raw) return [];

  const parsed: TrustedProxy[] = [];
  for (const entry of raw.split(',')) {
    const text = entry.trim();
    if (!text) continue;

    const slash = text.lastIndexOf('/');
    const address = parseIp(slash >= 0 ? text.slice(0, slash) : text);
    if (!address) continue;

    let prefix = address.bits;
    if (slash >= 0) {
      prefix = Number(text.slice(slash + 1));
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > address.bits) continue;
    }
    parsed.push({ ...address, prefix });
  }
  return parsed;
}

function contains(entry: TrustedProxy, candidate: ParsedIp): boolean {
  if (entry.bits !== candidate.bits) return false;
  const shift = BigInt(entry.bits - entry.prefix);
  return entry.value >> shift === candidate.value >> shift;
}

/** Whether `ip` falls inside any declared ingress block. */
export function isTrustedProxy(ip: string | undefined, trusted: readonly TrustedProxy[]): boolean {
  if (!ip || trusted.length === 0) return false;
  const candidate = parseIp(ip);
  if (!candidate) return false;
  return trusted.some((entry) => contains(entry, candidate));
}

/**
 * The address this request should be counted against, or `undefined` when the
 * caller should fall back to the library's own `req.ip`.
 *
 * The trust check reads the SOCKET peer, not `req.ip`: `req.ip` becomes
 * header-derived the moment anyone enables `trust proxy`, and a trust decision
 * must never rest on a value the client can influence.
 */
export function resolveClientIp(req: Record<string, unknown> | undefined, trusted: readonly TrustedProxy[]): string | undefined {
  if (!req || trusted.length === 0) return undefined;

  const socket = req.socket as { remoteAddress?: unknown } | undefined;
  const peer = typeof socket?.remoteAddress === 'string' ? socket.remoteAddress : typeof req.ip === 'string' ? req.ip : undefined;
  if (!isTrustedProxy(peer, trusted)) return undefined;

  const headers = req.headers as Record<string, string | string[] | undefined> | undefined;
  const header = headers?.['cf-connecting-ip'];
  const claimed = Array.isArray(header) ? header[0] : header;
  if (typeof claimed !== 'string') return undefined;

  // Cloudflare stamps exactly one address; splitting is defence against a
  // middlebox that appends to it rather than a supported format.
  const first = strip(claimed.split(',')[0] ?? '');

  // A value that is not an address must never become a bucket key: tracker
  // cardinality is unbounded memory in the in-memory store and unbounded key
  // count in Redis.
  return first && parseIp(first) ? first : undefined;
}

let cachedRaw: string | undefined;
let cachedList: TrustedProxy[] = [];

/**
 * The declared ingress list, parsed once.
 *
 * Env is immutable for a process lifetime (`09-infrastructure-devops.md` §9.2
 * L1), so this is a constant in production; the raw-string comparison exists so
 * a test can re-declare the topology between suites without a module reset.
 */
export function trustedProxiesFromEnv(): TrustedProxy[] {
  const raw = process.env.RATE_LIMIT_TRUSTED_PROXIES ?? '';
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedList = parseTrustedProxies(raw);
  }
  return cachedList;
}
