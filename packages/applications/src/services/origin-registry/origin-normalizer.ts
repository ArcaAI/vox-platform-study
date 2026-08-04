// Origin normalizer (TASK-610 §4.1 / §3.3, lane W1-A).
//
// This is the single place origin SYNTAX is decided (plan §3.3):
//  - parse with `new URL()`; reject anything that fails to parse
//  - require `http:` or `https:`; reject `ftp:`, `ws:`, `file:`, `data:`, and
//    any wildcard form (`*`)
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

export interface NormalizedOrigin {
  /** Canonical `scheme://host[:port]` — default ports stripped. */
  origin: string;
  scheme: 'http' | 'https';
  host: string;
  /** null when the port is the scheme default. */
  port: number | null;
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Throws ArgumentInvalidException on any malformed / disallowed origin. */
export function normalizeOrigin(raw: string): NormalizedOrigin {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ArgumentInvalidException('Origin must be a non-empty string');
  }

  // Reject wildcard forms outright, before parsing — `new URL('https://*')`
  // parses "successfully" (hostname `*`), so this cannot be left to the
  // parser/host checks below.
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
    throw new ArgumentInvalidException(`Origin scheme must be http or https: ${raw}`);
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

  const scheme = url.protocol.slice(0, -1) as 'http' | 'https';
  // WHATWG URL already lowercases the host and strips a scheme-default port
  // (`:443` on https, `:80` on http) during parsing, so `url.hostname` and
  // `url.port` are already canonical here.
  const host = url.hostname;
  const port = url.port === '' ? null : Number(url.port);

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
