/**
 * CORS origin admission for the API gateway (TASK-610 lane W3-A).
 *
 * ONE RULE: an origin is admitted iff it is REGISTERED — a `TenantAllowedOrigin`
 * row, reachable here through `IOriginRegistry` (plan §3.0, FR-3). There is no
 * wildcard, no scheme-based catch-all, and no hostname compiled into this file.
 *
 * WHAT THIS FILE DELETED, and why each deletion matters:
 *
 *   • `https_sdk_allowed` (D-3) — production admitted ANY `https://` origin.
 *     The `corsAllowedOrigins` allow-list was decorative: tightening it changed
 *     nothing an operator could observe. This is the vulnerability the ticket
 *     exists to close, and `cors.config.test.ts` locks it shut.
 *   • the hardcoded `app./dashboard./admin.arcaai.com` + staging domains, and
 *     the `compat-playground.taphuynh.dev` literal (D-2) — adding an origin
 *     required a code review, a build and a deploy: the §9.2 L1 anti-pattern.
 *     Origins are rows now.
 *   • every tunnel/preview wildcard (`.ngrok.io`, `.vercel.app`, `.netlify.app`,
 *     `.loca.lt`, `.surge.sh`, `.repl.co`, `.gitpod.io`, `.codesandbox.io`,
 *     `.cloudflare.com`) — a suffix match on a shared multi-tenant hosting
 *     domain admits every OTHER tenant of that host too.
 *
 * WHAT SURVIVED, and why each survival matters:
 *
 *   1. No `Origin` header → ALLOW. Server-to-server calls, curl, and every
 *      internal caller send none. Denying them breaks non-browser traffic
 *      wholesale, and it buys nothing: CORS is a browser mechanism, and a
 *      client that can omit the header can equally forge it. The real tenant
 *      isolation control is `OriginTenantBindingGuard` (FR-4), post-auth.
 *   2. The bootstrap fallback (FR-6) — `CORS_ALLOWED_ORIGINS`, consulted only
 *      while the registry reports itself unloaded. A gateway whose database is
 *      unreachable must still serve.
 *   3. A `development`-only LOOPBACK allowance — the one remaining `NODE_ENV`
 *      branch, kept so a fresh clone with an empty database can still run the
 *      SDK playground on `http://localhost:5173`. It is scoped to loopback
 *      hosts only (`localhost` / `127.0.0.0/8` / `::1`), which browsers treat
 *      as a secure context, and it is unreachable in staging/production.
 *
 * CORS is advisory. Everything here is browser-enforced and proves nothing
 * about a non-browser caller — it narrows the blast radius of a hostile page,
 * it is not an authorization boundary.
 */
import { isLoopbackHost, normalizeOrigin, type OriginIndexResolver } from '@arcaai/applications';
import { Logger } from '@nestjs/common';

const corsLogger = new Logger('CORS');

/**
 * The registry accessor, installed by `PlatformKnobsBinder` once the Nest
 * module graph is up. This module cannot inject a provider — `main.ts` imports
 * it before the graph exists — so the indirection is unavoidable.
 *
 * `null` (no resolver, or a resolver returning `null`) means "the registry is
 * not loaded", NOT "the registry is empty". The binder collapses an empty
 * index to `null` precisely so an unreadable or unseeded table lands on the
 * documented bootstrap fallback below instead of refusing every browser origin
 * on the platform (plan §3.8).
 */
let originRegistryResolver: OriginIndexResolver | null = null;

/** Install the DB-backed origin registry accessor. Called once from `PlatformKnobsBinder`. */
export function setOriginRegistryResolver(resolver: OriginIndexResolver | null): void {
  originRegistryResolver = resolver;
}

/**
 * Distinct refused origins already reported at `warn`, so a hostile client
 * cannot turn the diagnostic below into a log flood. Capped: past the cap the
 * decision still happens, it just stops being announced.
 */
const reportedRefusals = new Set<string>();
const REPORTED_REFUSAL_CAP = 100;

/**
 * Structured CORS decision log — the operator's only diagnostic.
 *
 * Allowances stay behind the debug gate. A REGISTRY MISS does not: closing the
 * catch-all (D-3) means a previously-working origin now 4xx's, and §4.8's
 * rollout depends on that being findable with one grep for
 * `origin_registry_miss`. It is deduped per distinct origin rather than
 * gated, so the first occurrence is always visible without the volume being
 * attacker-controlled.
 */
function logCorsDecision(origin: string | undefined, allowed: boolean, reason: string): boolean {
  const isRefusalWorthReporting = !allowed && (reason === 'origin_registry_miss' || reason === 'bootstrap_env_allowlist_miss');

  if (isRefusalWorthReporting && origin && !reportedRefusals.has(origin) && reportedRefusals.size < REPORTED_REFUSAL_CAP) {
    reportedRefusals.add(origin);
    corsLogger.warn({
      message: 'CORS refused an unregistered origin — register it as a TenantAllowedOrigin row if this is a legitimate caller',
      origin,
      reason,
    });
    return allowed;
  }

  if (process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV === 'development') {
    corsLogger.debug({
      message: 'CORS decision',
      origin: origin || 'none',
      allowed,
      reason,
    });
  }
  return allowed;
}

/**
 * `true`/`false` when the registry answered, `null` when it is unavailable
 * (not installed, not loaded, or broken) and the bootstrap fallback applies.
 *
 * NEVER throws. The argument is an attacker-controlled request header; a
 * malformed value must be "not registered", never an unhandled 500 inside the
 * `cors` middleware.
 */
function queryRegistry(origin: string): boolean | null {
  if (!originRegistryResolver) return null;
  try {
    const registry = originRegistryResolver();
    if (!registry) return null;
    return registry.has(origin) === true;
  } catch (error) {
    corsLogger.warn({
      message: 'Origin registry lookup failed — falling back to the CORS_ALLOWED_ORIGINS bootstrap allow-list',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** The `development`-only loopback allowance (see the header, survival #3). */
function isLoopbackOrigin(origin: string): boolean {
  try {
    // `normalizeOrigin` is the single source of truth for origin syntax, so
    // this branch cannot drift from what the registry accepts: it rejects
    // `ftp:`/`ws:`/`file:`, wildcards, paths, userinfo, and hosts that merely
    // START with a loopback label (`localhost.evil.example.com`).
    return isLoopbackHost(normalizeOrigin(origin).host);
  } catch {
    return false;
  }
}

/** The bootstrap allow-list (FR-6): env only — a DB-backed value is worthless when the DB is why we are here. */
export function isBootstrapAllowed(origin: string): boolean {
  const configured = process.env.CORS_ALLOWED_ORIGINS;
  if (!configured) return false;
  return configured
    .split(',')
    .map((entry) => entry.trim())
    .includes(origin);
}

/**
 * The single origin decision, shared by the CORS callback and by any WebSocket
 * handshake that wants the same posture (browsers exempt WS from CORS — see
 * D-6).
 */
export function isOriginAllowed(origin: string | undefined, nodeEnv: string): boolean {
  if (!origin) {
    return logCorsDecision(origin, true, 'no_origin_provided');
  }

  const registered = queryRegistry(origin);

  if (registered === true) {
    return logCorsDecision(origin, true, 'origin_registry_match');
  }

  if (nodeEnv === 'development' && isLoopbackOrigin(origin)) {
    return logCorsDecision(origin, true, 'development_loopback');
  }

  if (registered === false) {
    return logCorsDecision(origin, false, 'origin_registry_miss');
  }

  return isBootstrapAllowed(origin)
    ? logCorsDecision(origin, true, 'bootstrap_env_allowlist_match')
    : logCorsDecision(origin, false, 'bootstrap_env_allowlist_miss');
}

export type CorsOriginCallback = (err: Error | null, allow?: boolean) => void;

/**
 * Value passed to `app.enableCors({ origin })`.
 *
 * Every environment returns the SAME callback: the registry is the single
 * decision point, so there is no per-environment allow-list to express as a
 * RegExp any more. (It must not return `true` — with `credentials: true` the
 * spec forbids a wildcard, so a browser would reject that response anyway.)
 */
export function getCorsOrigins(nodeEnv: string): (origin: string | undefined, callback: CorsOriginCallback) => void {
  return (origin: string | undefined, callback: CorsOriginCallback) => {
    callback(null, isOriginAllowed(origin, nodeEnv));
  };
}
