// Origin normalizer (TASK-610 §4.1 / §3.3, lane W1-A).
//
// This is the single place origin SYNTAX is decided (plan §3.3):
//  - parse with `new URL()`; reject anything that fails to parse
//  - require `http:` or `https:`; reject `ftp:`, `ws:`, `file:`, `data:`, and
//    any wildcard form (`*`) — checked on the raw input AND again on the
//    canonical host, because URL parsing can DECODE a `*` into existence
//    (TASK-641 lane J). The invariant callers may rely on: this function never
//    returns an origin containing `*`.
//  - reject any path, query, fragment, or userinfo, and any trailing slash
//  - lowercase scheme + host; strip the default port (`:443` on https, `:80`
//    on http) so `https://x.org` and `https://x.org:443` cannot both be
//    registered; preserve non-default ports verbatim (e.g. `:4433`)
//  - refuse `http://` for non-loopback hosts — plain http + `credentials: true`
//    over a network is a credential-leak path; `localhost`/`127.0.0.1` are
//    exempt because browsers treat them as a secure context
//
// IDN / homograph decision: a non-ASCII host (e.g. a Cyrillic look-alike for
// "arcaai.com") is ACCEPTED and normalized to its punycode (ASCII) form via
// `new URL()`'s built-in IDNA algorithm, rather than rejected. This mirrors
// what a real browser sends: the `Origin` header is always the ASCII
// serialization of the host, so a legitimate non-Latin-script domain must
// still be registrable, and rejecting here cannot distinguish a genuine IDN
// domain from a homograph attack anyway — that judgment belongs to domain
// registration/verification policy, not origin syntax normalization.

import { ArgumentInvalidException } from '@arcaai/exceptions';

// ── Browser-extension schemes (TASK-653) ─────────────────────────────────────
//
// An extension page loads from `chrome-extension://<id>` (Chrome/Edge/Brave),
// `moz-extension://<uuid>` (Firefox) or `safari-web-extension://<uuid>` (Safari),
// and a browser sends exactly that as the `Origin` header. These are opaque,
// per-install identifiers, not DNS hosts: there is no apex, no port, no path,
// and the id is a single label (`[a-p]{32}` for Chrome, a hex+hyphen UUID for
// Firefox/Safari). They are all secure contexts, so the http-only-loopback rule
// below does NOT apply to them (that rule guards plaintext-over-a-network
// credential leaks — an extension origin never travels a network at all).
export const EXTENSION_SCHEMES = ['chrome-extension', 'moz-extension', 'safari-web-extension'] as const;
export type ExtensionScheme = (typeof EXTENSION_SCHEMES)[number];
export type OriginScheme = 'http' | 'https' | ExtensionScheme;

/**
 * True for a browser-extension scheme, accepting either the bare form
 * (`'chrome-extension'`) or the WHATWG `url.protocol` form with a trailing colon
 * (`'chrome-extension:'`) — callers hold it in both shapes, so normalize once here.
 */
export function isExtensionScheme(scheme: string): boolean {
  const bare = scheme.endsWith(':') ? scheme.slice(0, -1) : scheme;
  return (EXTENSION_SCHEMES as readonly string[]).includes(bare);
}

/**
 * A single opaque extension-id label: the SAME LDH shape the pattern grammar's
 * `LABEL_PATTERN` enforces (lowercase alphanumeric ends, hyphens only in the
 * middle, no dots, no `*`). Chrome ids (`[a-p]{32}`) and Firefox/Safari UUIDs
 * (hex + hyphens) both satisfy it; the id is lowercased before this runs so a
 * Safari uppercase UUID matches.
 */
const EXTENSION_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_EXTENSION_ID_LENGTH = 128;

export interface NormalizedOrigin {
  /** Canonical `scheme://host[:port]` — default ports stripped. */
  origin: string;
  scheme: OriginScheme;
  host: string;
  /** null when the port is the scheme default. */
  port: number | null;
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'chrome-extension:', 'moz-extension:', 'safari-web-extension:']);

/** Throws ArgumentInvalidException on any malformed / disallowed origin. */
export function normalizeOrigin(raw: string): NormalizedOrigin {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ArgumentInvalidException('Origin must be a non-empty string');
  }

  // Reject wildcard forms outright, before parsing — `new URL('https://*')`
  // parses "successfully" (hostname `*`), so this cannot be left to the
  // parser/host checks below.
  //
  // This RAW check is necessary but NOT sufficient: see the canonical re-check
  // after parsing (TASK-641 lane J).
  if (raw.includes('*')) {
    throw new ArgumentInvalidException(`Origin must not contain a wildcard: ${raw}`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ArgumentInvalidException(`Origin is not a valid URL: ${raw}`);
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new ArgumentInvalidException(
      `Origin scheme must be http, https or a browser-extension scheme (chrome-extension, moz-extension, safari-web-extension): ${raw}`,
    );
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new ArgumentInvalidException(`Origin must not contain userinfo: ${raw}`);
  }

  // `new URL()` normalizes a bare trailing slash's pathname to '/' — treat
  // that (and the empty-pathname case) as "no path" and accept it; anything
  // longer is a real path and must be rejected.
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new ArgumentInvalidException(`Origin must not contain a path: ${raw}`);
  }
  if (url.search.length > 0) {
    throw new ArgumentInvalidException(`Origin must not contain a query string: ${raw}`);
  }
  if (url.hash.length > 0) {
    throw new ArgumentInvalidException(`Origin must not contain a fragment: ${raw}`);
  }

  const scheme = url.protocol.slice(0, -1) as OriginScheme;
  // WHATWG URL already lowercases the host and strips a scheme-default port
  // (`:443` on https, `:80` on http) during parsing FOR SPECIAL (http/https)
  // schemes, so `url.hostname` and `url.port` are already canonical there.
  //
  // Extension schemes are NON-special, so their host is an OPAQUE host: it is
  // NOT lowercased, NOT IDNA-processed, and any port present is preserved as-is
  // — the extension branch below handles lowercasing and forbids a port.
  const host = url.hostname;
  const port = url.port === '' ? null : Number(url.port);

  // WILDCARD RE-CHECK ON THE CANONICAL HOST (TASK-641 lane J).
  //
  // The raw guard above runs BEFORE `new URL()`, and parsing is not
  // value-preserving: WHATWG URL percent-decodes `%2A`/`%2a` and IDNA/NFKC-folds
  // fullwidth `＊` (U+FF0A) into an ASCII `*` inside the host. So
  // `https://%2A.evil.com` and `https://＊.evil.com` both pass the raw guard and
  // parse to hostname `*.evil.com`.
  //
  // That is a privilege escalation, not a cosmetic leak: nothing downstream ever
  // re-reads the raw input. `origin-registry.service.ts` classifies a STORED row
  // with `isOriginPattern(storedOrigin)` — "a value is a pattern iff it contains
  // `*`" — so a row admitted here as an EXACT origin is later evaluated by
  // `matchesOriginPattern` as a genuine wildcard, granting credentialed CORS to
  // every subdomain of the attacker's apex.
  //
  // The invariant this enforces: `normalizeOrigin` NEVER returns an origin
  // containing `*`. Checking the canonical host (rather than only `raw`) is what
  // makes that true for every present and future encoding the URL parser folds,
  // and it also guarantees `isLoopbackHost` below is never handed a wildcard.
  // `scheme` is constrained to http/https and `port` is WHATWG-normalized
  // digits, so the host is the only channel a `*` can arrive through.
  if (host.includes('*')) {
    throw new ArgumentInvalidException(`Origin must not contain a wildcard (decoded from an encoded form): ${raw}`);
  }

  // ── Browser-extension branch (TASK-653) ────────────────────────────────────
  //
  // An extension origin is `<scheme>://<id>` — a single opaque id label, never a
  // DNS host. It differs from the http/https path in two deliberate ways:
  //   • A PORT is forbidden. Browsers never attach one; a non-special scheme's
  //     parser will happily accept `chrome-extension://id:80`, so reject it
  //     explicitly rather than silently store a spurious port.
  //   • The http-only-loopback rule is SKIPPED. That rule stops plaintext CORS
  //     credentials leaking over a network; an extension origin is a secure
  //     context that never crosses a network, so the rule is irrelevant here.
  // The id is lowercased (Safari sends uppercase UUIDs — lowercasing both store
  // and lookup keeps matching consistent) and validated as a single LDH label.
  if (isExtensionScheme(scheme)) {
    if (host.length === 0) {
      throw new ArgumentInvalidException(`Browser-extension origin must declare an id: ${raw}`);
    }
    if (port !== null) {
      throw new ArgumentInvalidException(`Browser-extension origin must not carry a port: ${raw}`);
    }
    const id = host.toLowerCase();
    if (id.length > MAX_EXTENSION_ID_LENGTH || !EXTENSION_ID_PATTERN.test(id)) {
      throw new ArgumentInvalidException(
        `Browser-extension id must be a single label of ${MAX_EXTENSION_ID_LENGTH} chars or fewer (a-z, 0-9, hyphen; no dots): ${raw}`,
      );
    }
    return { origin: `${scheme}://${id}`, scheme, host: id, port: null };
  }

  if (scheme === 'http' && !isLoopbackHost(host)) {
    throw new ArgumentInvalidException(`Plain http:// is only allowed for loopback hosts (localhost/127.0.0.0/8/::1): ${raw}`);
  }

  const origin = port === null ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;

  return { origin, scheme, host, port };
}

const IPV4_LOOPBACK_PATTERN = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();

  if (normalized === 'localhost') {
    return true;
  }
  if (normalized === '::1' || normalized === '[::1]') {
    return true;
  }

  const match = IPV4_LOOPBACK_PATTERN.exec(normalized);
  if (!match) {
    return false;
  }
  // Guard the 127.0.0.0/8 octets are each a valid 0-255 byte (exact match,
  // no trailing garbage — the regex anchors already rule out substrings like
  // "127.0.0.1.evil.com" or "localhost.evil.com").
  return match.slice(1).every((octet) => Number(octet) <= 255);
}
