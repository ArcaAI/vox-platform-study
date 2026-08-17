// Origin PATTERN grammar.
//
// `origin-normalizer.ts` owns EXACT origins and still rejects every `*` — an
// Origin header never contains one, so that rejection is correct and untouched.
// This module owns the separate, explicitly-opted-into concept of a stored
// PATTERN. A stored value is a pattern iff it contains `*`; the two
// forms share the `origin` column and its global-uniqueness guarantee.
//
// Frozen grammar (implemented literally, not re-designed):
//
//   pattern     := <scheme>://<hostPattern>:<portPattern>
//     scheme      := 'http' | 'https'    http ONLY when hostPattern is loopback
//     hostPattern := '*.' <suffix> | <host>
//     portPattern := '*' | <digits>      ALWAYS explicit in canonical form
//   allowAll    := '*'                   owner scope addition — see below
//
// Canonical seed forms: `https://*.bcmch.org:*` · `https://*.taphuynh.dev:*` ·
// `https://*.4bits.vn:*` · `http://localhost:*`.
//
// SECURITY POSTURE — a wildcard delegates credentialed CORS to every subdomain
// that exists now or later, including a dangling DNS record. Everything
// below is written to make the blast radius as small as the grammar allows:
//
//  1. `*` is only ever the leftmost host label and must be followed by `.`.
//  2. A `*.` suffix must carry >= 2 labels, and must not look like a public
//     suffix (see `isLikelyPublicSuffix` — deliberately partial, documented).
//  3. Matching is on a label boundary and NEVER matches the apex.
//  4. Scheme matches exactly; `http` only for loopback host patterns.
//  5. `matchesOriginPattern` never throws — its `origin` argument comes from an
//     attacker-controlled header, and a throw there is a 500.
//
// IDN decision: the `*.` suffix is punycoded through the SAME WHATWG IDNA path
// `normalizeOrigin` uses, so `https://*.ärger.de:*` stores as
// `https://*.xn--rger-koa.de:*`. The incoming `Origin` side is required to be
// ASCII and is NOT run through `new URL()`: a browser only ever sends the ASCII
// serialization, and `new URL()` silently STRIPS tab/newline from a host, which
// would let a smuggled `Origin: https://evil.com\t.bcmch.org` normalize into a
// match. Both sides therefore meet in punycode space, fail-closed.

import { ArgumentInvalidException } from '@arcaai/exceptions';

import { isExtensionScheme, isLoopbackHost, type OriginScheme } from './origin-normalizer';

/**
 * The allow-any-origin token (owner scope addition). Held by the Global tenant
 * in every environment, including production.
 *
 * Exported as a named constant so the admin surface and the registry can
 * special-case it (loud logging on write, explicit handling on resolve) without
 * scattering a bare `'*'` literal across layers.
 */
export const ALLOW_ALL_ORIGIN_PATTERN = '*';

/** Ranks nothing — returned by `patternSpecificity` for an unparseable value. */
const SPECIFICITY_INVALID = 0;
/**
 * The allow-all token ranks strictly BELOW every other valid pattern (the
 * lowest real pattern scores 6: a one-character concrete host). This is
 * load-bearing: the registry resolves an origin to its OWNING tenant, so if the
 * Global-owned `*` row ever outranked `https://*.bcmch.org:*`, an ArcaAI origin
 * would resolve to Global and the binding guard would 404 legitimate ArcaAI
 * traffic.
 */
const SPECIFICITY_ALLOW_ALL = 1;
/**
 * An "any-extension" pattern (`<scheme>://*`) ranks strictly above the
 * allow-all token (1) — it is narrower: it admits only ONE scheme's extensions,
 * not literally every origin — and strictly below the lowest concrete host
 * pattern (a one-character host scores 6). A small fixed rank is enough: it is
 * used for LOG ordering only (union resolution has no precedence on the auth
 * path — see `origin-registry.service.ts`).
 */
const SPECIFICITY_ANY_EXTENSION = 2;
/** Host text dominates the two tie-breakers, which together max out at 3. */
const SPECIFICITY_HOST_WEIGHT = 4;
const SPECIFICITY_EXACT_HOST_BONUS = 2;
const SPECIFICITY_PINNED_PORT_BONUS = 1;

const MAX_INPUT_LENGTH = 2048;
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
/** Extension-id cap — the same bound `origin-normalizer` enforces on an exact extension id. */
const MAX_EXTENSION_ID_LENGTH = 128;
const MAX_PORT = 65535;

// Also accept the three browser-extension schemes. Used by BOTH
// `parsePattern` (the write path, for the `<scheme>://*` any-extension pattern)
// and `parseCanonicalOrigin` (the incoming-header path, for an exact extension
// origin), so extension support has to live in this ONE prefix.
const SCHEME_PREFIX_PATTERN = /^(https?|chrome-extension|moz-extension|safari-web-extension):\/\//i;
/** Rejects path, query, fragment, userinfo, percent-encoding and backslash. */
const FORBIDDEN_AUTHORITY_CHARS = ['/', '\\', '?', '#', '@', '%'];
/** LDH label: alphanumeric ends, hyphens only in the middle. */
const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const ALL_DIGITS_PATTERN = /^\d+$/;
const CANONICAL_PORT_PATTERN = /^[1-9]\d{0,4}$/;
const ASCII_ONLY_PATTERN = /^[\x21-\x7e]*$/;

/**
 * Second-level labels that ccTLD registries operate as public suffixes. Paired
 * with a 2-letter TLD this rejects `co.uk`, `com.au`, `co.jp`, `com.vn`,
 * `co.za`, ... from ONE rule, without enumerating pairs.
 */
const SECOND_LEVEL_REGISTRY_LABELS = new Set([
  'ac',
  'asn',
  'biz',
  'co',
  'com',
  'edu',
  'firm',
  'gen',
  'go',
  'gob',
  'gov',
  'gouv',
  'id',
  'in',
  'ind',
  'info',
  'ltd',
  'me',
  'mil',
  'ne',
  'net',
  'nom',
  'or',
  'org',
  'plc',
  'res',
  'sch',
  'web',
]);

/**
 * Shared-hosting suffixes where a wildcard would delegate credentialed CORS to
 * every customer of that platform. Illustrative, NOT exhaustive — see the
 * residual-risk note on `isLikelyPublicSuffix`.
 */
const KNOWN_SHARED_SUFFIXES = new Set([
  'amplifyapp.com',
  'appspot.com',
  'azurewebsites.net',
  'blogspot.com',
  'cloudfront.net',
  'elasticbeanstalk.com',
  'firebaseapp.com',
  'fly.dev',
  'github.io',
  'gitlab.io',
  'glitch.me',
  'herokuapp.com',
  'netlify.app',
  'ngrok-free.app',
  'ngrok.io',
  'onrender.com',
  'pages.dev',
  'repl.co',
  'surge.sh',
  'trycloudflare.com',
  'vercel.app',
  'web.app',
  'workers.dev',
  'wordpress.com',
]);

interface ParsedPattern {
  scheme: OriginScheme;
  /** true for the `*.<suffix>` form; false for a concrete host. */
  wildcard: boolean;
  /**
   * true for the browser-extension `<scheme>://*` form — "any
   * extension of that scheme". A discriminant distinct from `wildcard` (which
   * it also sets) so matching/specificity never confuse it with an http
   * `*.<suffix>` host wildcard: an any-extension pattern has `matchHost: ''`,
   * `port: null`, and does no label-boundary/port logic.
   */
  anyExtension: boolean;
  /** Host text that must match: the suffix when wildcard, else the whole host. Empty for an any-extension pattern. */
  matchHost: string;
  /** null when the port pattern is `*` (matches ANY port). */
  port: number | null;
  canonical: string;
}

/** True iff the stored value is a pattern rather than an exact origin. */
export function isOriginPattern(value: string): boolean {
  return typeof value === 'string' && value.includes('*');
}

/**
 * Validate + canonicalize a pattern.
 *
 * @throws ArgumentInvalidException when the value is not a valid pattern.
 */
export function normalizeOriginPattern(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ArgumentInvalidException('Origin pattern must be a non-empty string');
  }

  // The allow-all token is matched on the RAW string, exactly. No trimming, no
  // unwrapping: `'* '`, `'**'`, `'"*"'` and every other near-miss must fail
  // loudly rather than silently become allow-all.
  if (raw === ALLOW_ALL_ORIGIN_PATTERN) {
    return ALLOW_ALL_ORIGIN_PATTERN;
  }

  // A `*`-free value is an EXACT origin and belongs to `normalizeOrigin`.
  // Enforcing this keeps `isOriginPattern(normalizeOriginPattern(x))` true.
  if (!raw.includes('*')) {
    throw new ArgumentInvalidException(`Origin pattern must contain a wildcard; use normalizeOrigin for exact origins: ${raw}`);
  }

  return parsePattern(raw).canonical;
}

/** Does `origin` (a canonical exact origin from normalizeOrigin) match `pattern`? */
export function matchesOriginPattern(pattern: string, origin: string): boolean {
  // Hard guarantee: `origin` arrives from an attacker-controlled header, so no
  // input of any shape may throw out of this function.
  try {
    const parsedOrigin = parseCanonicalOrigin(origin);
    if (parsedOrigin === null) {
      return false;
    }

    if (pattern === ALLOW_ALL_ORIGIN_PATTERN) {
      return true;
    }

    const parsed = tryParsePattern(pattern);
    if (parsed === null) {
      return false;
    }

    if (parsedOrigin.scheme !== parsed.scheme) {
      return false;
    }

    // Any-extension pattern: the scheme already matched exactly
    // above, so admit any well-formed extension id. `parseCanonicalOrigin`
    // already proved the origin's host is a single LABEL_PATTERN label with no
    // port and no `*`, so a non-empty host is sufficient — there is no
    // label-boundary or port logic for extensions.
    if (parsed.anyExtension) {
      return parsedOrigin.host.length > 0;
    }

    if (parsed.wildcard) {
      // Label-boundary match: the origin host must END with `'.' + suffix` and
      // carry at least one character before that dot. This is what stops
      // `evilbcmch.org` (no boundary), `bcmch.org` (the apex) and
      // `bcmch.org.evil.com` (suffix not at the end) from matching.
      const boundary = `.${parsed.matchHost}`;
      if (!parsedOrigin.host.endsWith(boundary) || parsedOrigin.host.length <= boundary.length) {
        return false;
      }
    } else if (parsedOrigin.host !== parsed.matchHost) {
      return false;
    }

    if (parsed.port === null) {
      return true; // `*` matches any port, including default/absent.
    }

    // A canonical origin has its scheme-default port stripped, so an absent
    // port means the default.
    const effectivePort = parsedOrigin.port ?? (parsedOrigin.scheme === 'https' ? 443 : 80);
    return effectivePort === parsed.port;
  } catch {
    return false;
  }
}

/**
 * Specificity for precedence — higher wins. Used by the registry to break
 * overlaps: longest suffix wins, ties break by earliest id.
 *
 * "Exact row beats any pattern" is NOT expressed here — exact origins are not
 * patterns, so the registry enforces that by looking up exact rows first.
 */
export function patternSpecificity(pattern: string): number {
  if (pattern === ALLOW_ALL_ORIGIN_PATTERN) {
    return SPECIFICITY_ALLOW_ALL;
  }

  const parsed = tryParsePattern(pattern);
  if (parsed === null) {
    return SPECIFICITY_INVALID;
  }

  // An any-extension pattern has an empty `matchHost`, so the formula below
  // would score it 0 (== unparseable). Give it its own fixed rank instead —
  // above allow-all, below every concrete host.
  if (parsed.anyExtension) {
    return SPECIFICITY_ANY_EXTENSION;
  }

  return (
    parsed.matchHost.length * SPECIFICITY_HOST_WEIGHT +
    (parsed.wildcard ? 0 : SPECIFICITY_EXACT_HOST_BONUS) +
    (parsed.port === null ? 0 : SPECIFICITY_PINNED_PORT_BONUS)
  );
}

// --------------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------------

/**
 * Whitespace (incl. space), C0 controls and DEL. Written as a code-point scan
 * rather than a regex so no raw control byte ever lands in this source file.
 */
function hasWhitespaceOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** Non-throwing wrapper — used by every read path. */
function tryParsePattern(raw: string): ParsedPattern | null {
  try {
    return parsePattern(raw);
  } catch {
    return null;
  }
}

function parsePattern(raw: string): ParsedPattern {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ArgumentInvalidException('Origin pattern must be a non-empty string');
  }
  if (raw.length > MAX_INPUT_LENGTH) {
    throw new ArgumentInvalidException('Origin pattern is too long');
  }
  if (hasWhitespaceOrControl(raw)) {
    throw new ArgumentInvalidException(`Origin pattern must not contain whitespace or control characters: ${raw}`);
  }

  const schemeMatch = SCHEME_PREFIX_PATTERN.exec(raw);
  if (schemeMatch === null) {
    throw new ArgumentInvalidException(`Origin pattern must start with http:// or https://: ${raw}`);
  }
  const scheme = schemeMatch[1].toLowerCase() as OriginScheme;

  const authority = raw.slice(schemeMatch[0].length);
  if (authority.length === 0) {
    throw new ArgumentInvalidException(`Origin pattern must declare a host: ${raw}`);
  }

  // ── Browser-extension "any-extension" pattern  ───────────────────
  //
  // The ONLY valid extension PATTERN is `<scheme>://*` — "any extension id of
  // this scheme". An exact `<scheme>://<id>` carries no `*` and is
  // `normalizeOrigin`'s job (`normalizeOriginPattern` already rejected any
  // `*`-free value before reaching here). So the authority must be EXACTLY `*`:
  // there is no host-suffix/port/label grammar for extensions, so `*.x`, `ab*`,
  // `*:80`, `**` and a pinned id all fail this single check.
  if (isExtensionScheme(scheme)) {
    if (authority !== ALLOW_ALL_ORIGIN_PATTERN) {
      throw new ArgumentInvalidException(`A browser-extension pattern must be exactly '<scheme>://*': ${raw}`);
    }
    return { scheme, wildcard: true, anyExtension: true, matchHost: '', port: null, canonical: `${scheme}://*` };
  }

  for (const forbidden of FORBIDDEN_AUTHORITY_CHARS) {
    if (authority.includes(forbidden)) {
      throw new ArgumentInvalidException(`Origin pattern must not contain a path, query, fragment, userinfo or percent-encoding: ${raw}`);
    }
  }

  const { hostPattern, portPattern } = splitAuthority(authority, raw);
  const port = parsePortPattern(portPattern, raw);
  const { wildcard, matchHost, canonicalHost } = parseHostPattern(hostPattern, raw);

  // `http` is a credential-leak path over a network; only loopback is exempt,
  // and a wildcard host is never loopback (`*.localhost` already fails the
  // >= 2-label floor).
  if (scheme === 'http' && (wildcard || !isLoopbackHost(canonicalHost))) {
    throw new ArgumentInvalidException(`Plain http:// is only allowed for loopback host patterns (localhost/127.0.0.0/8/::1): ${raw}`);
  }

  const canonical = `${scheme}://${canonicalHost}:${port === null ? '*' : port}`;

  return { scheme, wildcard, anyExtension: false, matchHost, port, canonical };
}

/** Bracket-aware host/port split. The port segment is MANDATORY in a pattern. */
function splitAuthority(authority: string, raw: string): { hostPattern: string; portPattern: string } {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) {
      throw new ArgumentInvalidException(`Origin pattern has an unterminated IPv6 host: ${raw}`);
    }
    const rest = authority.slice(close + 1);
    if (!rest.startsWith(':')) {
      throw new ArgumentInvalidException(`Origin pattern must declare an explicit port (':*' or ':<digits>'): ${raw}`);
    }
    return { hostPattern: authority.slice(0, close + 1), portPattern: rest.slice(1) };
  }

  const separator = authority.indexOf(':');
  if (separator === -1) {
    throw new ArgumentInvalidException(`Origin pattern must declare an explicit port (':*' or ':<digits>'): ${raw}`);
  }
  return {
    hostPattern: authority.slice(0, separator),
    portPattern: authority.slice(separator + 1),
  };
}

/** `*` -> null (any port); digits -> a pinned port. One spelling per port. */
function parsePortPattern(portPattern: string, raw: string): number | null {
  if (portPattern === '*') {
    return null;
  }
  // No leading zeros: `:080` and `:80` must not be two spellings of one port.
  if (!CANONICAL_PORT_PATTERN.test(portPattern)) {
    throw new ArgumentInvalidException(`Origin pattern port must be '*' or 1-${MAX_PORT} without leading zeros: ${raw}`);
  }
  const port = Number(portPattern);
  if (port > MAX_PORT) {
    throw new ArgumentInvalidException(`Origin pattern port must be 1-${MAX_PORT}: ${raw}`);
  }
  return port;
}

function parseHostPattern(hostPattern: string, raw: string): { wildcard: boolean; matchHost: string; canonicalHost: string } {
  if (hostPattern.length === 0) {
    throw new ArgumentInvalidException(`Origin pattern must declare a host: ${raw}`);
  }

  if (!hostPattern.includes('*')) {
    const canonicalHost = canonicalizeHost(hostPattern, raw);
    return { wildcard: false, matchHost: canonicalHost, canonicalHost };
  }

  // FLOOR 1 — `*` only as the leftmost label, and only when followed by `.`.
  // `hostPattern.indexOf('*', 1)` catches `**.x.com`, `*.*.com`, `a.*.b` and
  // `*.bcmch.org*` in one check.
  if (!hostPattern.startsWith('*.') || hostPattern.indexOf('*', 1) !== -1) {
    throw new ArgumentInvalidException(`A wildcard is only allowed as the leftmost host label, written '*.': ${raw}`);
  }

  const suffix = canonicalizeHost(hostPattern.slice(2), raw);
  const labels = suffix.split('.');

  // FLOOR 2 — a `*.` suffix must carry >= 2 labels (rejects `*.vn`, `*.com`).
  if (labels.length < 2) {
    throw new ArgumentInvalidException(`A wildcard suffix must carry at least 2 labels (e.g. '*.bcmch.org', not '*.org'): ${raw}`);
  }
  // An all-numeric last label means an IP-shaped suffix, never a registrable
  // domain (`*.1.2.3.4`).
  if (ALL_DIGITS_PATTERN.test(labels[labels.length - 1])) {
    throw new ArgumentInvalidException(`A wildcard suffix must not be an IP address: ${raw}`);
  }
  if (isLikelyPublicSuffix(suffix)) {
    throw new ArgumentInvalidException(`A wildcard suffix must be a registrable domain, not a public suffix: ${raw}`);
  }

  return { wildcard: true, matchHost: suffix, canonicalHost: `*.${suffix}` };
}

/**
 * Lowercase + punycode a CONCRETE host (never contains `*`) through the same
 * WHATWG IDNA path `normalizeOrigin` uses, then validate its labels ourselves.
 *
 * The self-validation is not redundant: `new URL()` runs with
 * UseSTD3ASCIIRules=false, so it happily returns `bcmch..org`, `-bad.org`,
 * `bcmch_org.com` and `bcmch.org.` unchanged.
 */
function canonicalizeHost(host: string, raw: string): string {
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) {
    throw new ArgumentInvalidException(`Origin pattern host is empty or too long: ${raw}`);
  }

  let ascii: string;
  try {
    ascii = new URL(`https://${host}/`).hostname.toLowerCase();
  } catch {
    throw new ArgumentInvalidException(`Origin pattern host is not a valid host: ${raw}`);
  }

  if (ascii.length === 0 || ascii.length > MAX_HOST_LENGTH || !ASCII_ONLY_PATTERN.test(ascii)) {
    throw new ArgumentInvalidException(`Origin pattern host is not a valid host: ${raw}`);
  }

  // IPv6 literals keep their bracketed form and have no DNS labels.
  if (ascii.startsWith('[')) {
    if (!ascii.endsWith(']')) {
      throw new ArgumentInvalidException(`Origin pattern host is not a valid host: ${raw}`);
    }
    return ascii;
  }

  for (const label of ascii.split('.')) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH || !LABEL_PATTERN.test(label)) {
      throw new ArgumentInvalidException(`Origin pattern host has an invalid DNS label: ${raw}`);
    }
  }

  return ascii;
}

/**
 * Best-effort public-suffix rejection WITHOUT a public-suffix list.
 *
 * RESIDUAL RISK — this is deliberately PARTIAL and cannot be made complete by
 * hand. claims the ">= 2 labels" floor rejects `*.co.uk`; it does not
 * (`co.uk` is two labels), so this heuristic carries that stated intent. It
 * catches (a) a 2-label suffix whose TLD is a 2-letter ccTLD and whose second
 * level is a known registry label, and (b) a short list of shared-hosting
 * suffixes. It will NOT catch every entry of the real PSL — e.g. an unlisted
 * platform suffix, or a private-section entry. A wildcard over such a suffix
 * still delegates credentialed CORS to every tenant of that platform. The
 * complete fix is a maintained PSL (`tldts`/`psl`) at write time; until then,
 * a super admin approving a wildcard row must check the suffix by hand.
 */
function isLikelyPublicSuffix(suffix: string): boolean {
  if (KNOWN_SHARED_SUFFIXES.has(suffix)) {
    return true;
  }

  const labels = suffix.split('.');
  if (labels.length !== 2) {
    return false;
  }
  const [secondLevel, tld] = labels;
  // Only 2-letter ccTLDs run second-level registries at scale; this keeps
  // legitimate 2-label domains such as `4bits.vn` and `taphuynh.dev` valid.
  if (tld.length !== 2 || !LABEL_PATTERN.test(tld) || ALL_DIGITS_PATTERN.test(tld)) {
    return false;
  }
  return SECOND_LEVEL_REGISTRY_LABELS.has(secondLevel);
}

interface ParsedOrigin {
  scheme: OriginScheme;
  host: string;
  port: number | null;
}

/**
 * Lenient, NEVER-throwing parse of an incoming `Origin`. Deliberately does not
 * use `new URL()`: it strips tab/newline from a host, which would let a
 * smuggled header normalize into a match. Anything non-ASCII, wildcarded or
 * structurally odd returns null (fail closed).
 */
function parseCanonicalOrigin(origin: string): ParsedOrigin | null {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > MAX_INPUT_LENGTH) {
    return null;
  }
  if (!ASCII_ONLY_PATTERN.test(origin)) {
    return null;
  }

  const schemeMatch = SCHEME_PREFIX_PATTERN.exec(origin);
  if (schemeMatch === null) {
    return null;
  }
  const scheme = schemeMatch[1].toLowerCase() as OriginScheme;

  const authority = origin.slice(schemeMatch[0].length);
  if (authority.length === 0) {
    return null;
  }
  // A `*` in an Origin header is never legitimate — defence in depth so a
  // pattern can never be satisfied by an origin that is itself a pattern.
  if (authority.includes('*')) {
    return null;
  }
  for (const forbidden of FORBIDDEN_AUTHORITY_CHARS) {
    if (authority.includes(forbidden)) {
      return null;
    }
  }

  // ── Incoming browser-extension origin  ───────────────────────────
  //
  // `<scheme>://<id>` — a single opaque id label, no port, no brackets. The
  // authority must be exactly a lowercased LABEL_PATTERN label (a port's `:`, an
  // IPv6 `[`, a dot-splitting host all fail `LABEL_PATTERN`). Lowercased so an
  // uppercase Safari UUID matches a stored `<scheme>://*` pattern. Never throws
  // — returns null on anything malformed, like the http/https path below.
  if (isExtensionScheme(scheme)) {
    const id = authority.toLowerCase();
    if (id.length === 0 || id.length > MAX_EXTENSION_ID_LENGTH || !LABEL_PATTERN.test(id)) {
      return null;
    }
    return { scheme, host: id, port: null };
  }

  let hostPart: string;
  let portPart: string | null;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) {
      return null;
    }
    hostPart = authority.slice(0, close + 1);
    const rest = authority.slice(close + 1);
    if (rest.length === 0) {
      portPart = null;
    } else if (rest.startsWith(':')) {
      portPart = rest.slice(1);
    } else {
      return null;
    }
  } else {
    const separator = authority.indexOf(':');
    if (separator === -1) {
      hostPart = authority;
      portPart = null;
    } else {
      hostPart = authority.slice(0, separator);
      portPart = authority.slice(separator + 1);
    }
  }

  let port: number | null = null;
  if (portPart !== null) {
    if (!CANONICAL_PORT_PATTERN.test(portPart)) {
      return null;
    }
    port = Number(portPart);
    if (port > MAX_PORT) {
      return null;
    }
  }

  const host = hostPart.toLowerCase();
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) {
    return null;
  }
  if (host.startsWith('[')) {
    return host.endsWith(']') ? { scheme, host, port } : null;
  }
  for (const label of host.split('.')) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH || !LABEL_PATTERN.test(label)) {
      return null;
    }
  }

  return { scheme, host, port };
}
