/**
 * CORS origin admission for the API gateway (TASK-610 lane W3-A; env-var
 * removal — TASK-610 §4A.1, W5-C).
 *
 * ONE RULE: an origin is admitted iff it is REGISTERED — a `TenantAllowedOrigin`
 * row, reachable here through `IOriginRegistry` (plan §3.0, FR-3). There is no
 * wildcard, no scheme-based catch-all, no hostname compiled into this file, and
 * — since §4A.1 — no environment variable anywhere in the decision.
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
 *   • the `CORS_ALLOWED_ORIGINS` bootstrap fallback (formerly FR-6) — retired
 *     by owner directive §4A.1: "we do NOT use any ENV VARS for CORS values
 *     declaration and do NOT control CORS Allowed List using any ENV VARS."
 *     The `TenantAllowedOrigin` table is now the ONLY source of truth. The
 *     consequence is stated plainly there and repeated here because it is the
 *     load-bearing behavior change: an unreachable or not-yet-loaded registry
 *     now DENIES every browser origin instead of falling back to env. That is
 *     the safe direction, and it is a hard dependency rather than a soft one.
 *
 * WHAT SURVIVED, and why each survival matters:
 *
 *   1. No `Origin` header → ALLOW. Server-to-server calls, curl, and every
 *      internal caller send none. Denying them breaks non-browser traffic
 *      wholesale, and it buys nothing: CORS is a browser mechanism, and a
 *      client that can omit the header can equally forge it. The real tenant
 *      isolation control is `OriginTenantBindingGuard` (FR-4), post-auth.
 *   2. A `development`-only LOOPBACK allowance — the one remaining `NODE_ENV`
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
 * not loaded", NOT "the registry is empty" — though since §4A.1 the two are
 * treated identically at the DECISION (both DENY): there is no fallback tier
 * left for them to diverge into. The binder still collapses an empty index to
 * `null` rather than handing over a technically-loaded-but-empty index,
 * because the DISTINCTION is preserved one layer up, in the log reason: a
 * `null` registry produces `origin_registry_unavailable` (nothing loaded
 * platform-wide — a systemic signal), while a loaded registry answering "no"
 * for one origin produces `origin_registry_miss` (an ordinary, expected,
 * per-origin refusal). See `PlatformKnobsBinder.installOriginRegistryResolver`.
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
 * Allowances stay behind the debug gate. A refusal does not: closing the
 * catch-all (D-3) means a previously-working origin now 4xx's, and §4.8's
 * rollout depends on that being findable with one grep. Two DISTINCT reasons
 * are surfaced at `warn` (never collapsed into one message — TASK-610 §4A.1):
 *
 *   • `origin_registry_miss`        — the registry is loaded and answered
 *     "no" for THIS origin. Ordinary, expected, actionable by registering it.
 *   • `origin_registry_unavailable` — the registry has nothing loaded at all
 *     (not installed, not yet refreshed, or the lookup threw). Every browser
 *     origin is being refused, not just this one — the signal an operator
 *     needs to distinguish "register this origin" from "the registry itself
 *     is down; check the database".
 *
 * Each is deduped per distinct origin rather than gated, so the first
 * occurrence of either is always visible without the volume being
 * attacker-controlled.
 */
function logCorsDecision(origin: string | undefined, allowed: boolean, reason: string): boolean {
  const isRefusalWorthReporting = !allowed && (reason === 'origin_registry_miss' || reason === 'origin_registry_unavailable');

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
 * (not installed, not loaded, or broken) — `isOriginAllowed` denies on `null`.
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
      message: 'Origin registry lookup failed — denying (no bootstrap fallback since TASK-610 §4A.1)',
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

  // `registered === null`: the registry is unavailable — not installed, not
  // yet loaded (including "loaded but empty", per the binder's collapse), or
  // the lookup threw. FAIL CLOSED. There is no bootstrap allow-list to fall
  // back to any more (TASK-610 §4A.1, owner directive: no env var ever
  // controls the CORS allow-list) — an unreachable database now means every
  // browser origin is refused until the registry recovers. That is the safe
  // direction, deliberately, not an accident of a deleted branch.
  return logCorsDecision(origin, false, 'origin_registry_unavailable');
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
