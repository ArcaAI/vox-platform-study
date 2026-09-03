/**
 * CORS origin admission for the API gateway (env-var allow-list removed).
 *
 * ONE RULE: an origin is admitted iff it is REGISTERED — a `TenantAllowedOrigin`
 * row, reachable here through `IOriginRegistry`. There is no
 * wildcard, no scheme-based catch-all, no hostname compiled into this file, and
 * no environment variable anywhere in the
 * decision. Not as an allow-list, and not as a behavioural branch.
 *
 * WHAT THIS FILE DELETED, and why each deletion matters:
 *
 *   • `https_sdk_allowed` — production admitted ANY `https://` origin.
 *     The `corsAllowedOrigins` allow-list was decorative: tightening it changed
 *     nothing an operator could observe. This is the vulnerability the ticket
 *     exists to close, and `cors.config.test.ts` locks it shut.
 *   • the hardcoded `app./dashboard./admin.arcaai.com` + staging domains, and
 *     the `compat-playground.taphuynh.dev` literal — adding an origin
 *     required a code review, a build and a deploy: restart-bound config.
 *     Origins are rows now.
 *   • every tunnel/preview wildcard (`.ngrok.io`, `.vercel.app`, `.netlify.app`,
 *     `.loca.lt`, `.surge.sh`, `.repl.co`, `.gitpod.io`, `.codesandbox.io`,
 *     `.cloudflare.com`) — a suffix match on a shared multi-tenant hosting
 *     domain admits every OTHER tenant of that host too.
 *   • the `CORS_ALLOWED_ORIGINS` bootstrap fallback — retired
 *     by owner directive: "we do NOT use any ENV VARS for CORS values
 *     declaration and do NOT control CORS Allowed List using any ENV VARS."
 *     The `TenantAllowedOrigin` table is now the ONLY source of truth. The
 *     consequence is stated plainly there and repeated here because it is the
 *     load-bearing behavior change: an unreachable or not-yet-loaded registry
 *     now DENIES every browser origin instead of falling back to env. That is
 *     the safe direction, and it is a hard dependency rather than a soft one.
 *   • the `development`-only LOOPBACK allowance and its `isLoopbackOrigin`
 *     helper — the LAST environment variable participating in a
 *     CORS decision. It admitted `localhost` / `127.0.0.0/8` / `::1` whenever
 *     `NODE_ENV === 'development'`, overriding a registry that had just said
 *     no, so a developer's admission rule and everyone else's were different
 *     code. Owner directive: "no env var may
 *     participate in any CORS decision — not as an allow-list, and not as a
 *     behavioural branch."
 *
 *     WHAT REPLACES IT: SYSTEM-tenant rows for all six loopback spellings —
 *     `localhost`, `127.0.0.1` and `[::1]`, each on http and https.
 *     They are ordinary registry
 *     rows and take the ordinary path, so local development and production are
 *     decided by the same three lines. Do NOT re-add a code fallback "just in
 *     case" the rows are missing — a hardcoded env-independent branch is the
 *     same defect wearing a different hat, and it would make the seed's
 *     correctness untestable by making its absence invisible.
 *
 *     THE COST, stated so it is not rediscovered during an outage:
 *     an environment with no loopback row refuses EVERY browser origin,
 *     loopback included, recoverable only by writing a row. That is why those
 *     rows are guaranteed by a MIGRATION
 *     (`20260808160000_task_641_bootstrap_loopback_origins`) rather than by the
 *     `RUN_SEED`-gated seed, and why those seed rows are load-bearing rather than a nicety.
 *     There are SIX of them, not two: the deleted branch used `isLoopbackHost`,
 *     covering `localhost` ∪ `127.0.0.0/8` ∪ `::1` on EITHER scheme, so
 *     `https://localhost:*`, `https://127.0.0.1:*`, `http://[::1]:*` and
 *     `https://[::1]:*` are seeded alongside the two http rows. `127.0.0.2`-
 *     `127.0.0.255` stay uncovered — the pattern grammar cannot express them
 *     (see the migration's residual-gap note); register such an address as its
 *     own exact row.
 *
 * WHAT SURVIVED, and why each survival matters:
 *
 *   1. No `Origin` header → ALLOW. Server-to-server calls, curl, and every
 *      internal caller send none. Denying them breaks non-browser traffic
 *      wholesale, and it buys nothing: CORS is a browser mechanism, and a
 *      client that can omit the header can equally forge it. The real tenant
 *      isolation control is `OriginTenantBindingGuard`, post-auth.
 *   2. `logCorsDecision`'s `NODE_ENV`/`LOG_LEVEL` read — the only `process.env`
 *      left in this file, and deliberately kept. It selects LOG VERBOSITY, not
 *      admission: both of that function's branches return `allowed` unchanged,
 *      so no value of either variable can move an origin from refused to
 *      admitted. No env var governs the CORS decision; deleting a diagnostic would
 *      cost the operator their only per-origin trace and buy nothing. The
 *      guard in `cors.config.task641.test.ts` excises exactly that function and
 *      asserts over everything else — so this exception is narrow, explicit,
 *      and mechanically enforced rather than a matter of reviewer memory.
 *
 * CORS is advisory. Everything here is browser-enforced and proves nothing
 * about a non-browser caller — it narrows the blast radius of a hostile page,
 * it is not an authorization boundary.
 *
 * ── THE SWITCH — NOW DEFAULT-ON ──
 *
 * Everything described so far is gated behind ONE platform switch,
 * `origin.enforcementEnabled` (`global-kv`, `globalOnly`, DEFAULT **`true`**).
 * Read the history, because this file used to say the
 * opposite and the reversal is deliberate:
 *
 *   The switch originally shipped DEFAULT `false` on the owner directive
 *   "make sure by default (apply to all tenants including SYSTEM, GLOBAL) no
 *    origin checks, ALL is ALLOWED for calling and using our APIs".
 *
 *   A later owner directive reversed it — "no default is off".
 *   Enforcement is now ON in every environment, for every tenant, with no row
 *   present and no opt-in step. The descriptor default lives in
 *   `platform-ops.descriptors.ts` (`origin.enforcementEnabled`); this file only
 *   READS whatever the binder resolves.
 *
 * While the switch is false — an operator turning it off, not a default any
 * more — `isOriginAllowed` admits every origin WITHOUT consulting the registry,
 * `OriginTenantBindingGuard` passes every request, and the STT WS handshake
 * accepts every origin. None of the machinery above is removed either way, and
 * flipping the switch takes effect live, with no redeploy.
 *
 * WHAT STOPS THIS LOCKING EVERYONE OUT. Default-ON plus no env
 * fallback plus no dev branch plus opt-in `RUN_SEED` would mean an
 * environment that skipped the seed refuses EVERY browser origin, loopback
 * included. The six SYSTEM loopback rows are therefore guaranteed by a
 * MIGRATION — `20260808160000_task_641_bootstrap_loopback_origins` — the same
 * mechanism that guarantees the SYSTEM tenant row itself, so every environment
 * has them whether or not it seeds. Do NOT re-introduce a code-level fallback
 * to "protect" against a missing row; that is the loopback branch wearing a different hat, and
 * it would make the migration's correctness untestable.
 *
 * There remains ONE genuinely permissive window, and it is a property of this
 * process rather than of the platform: until `PlatformKnobsBinder` installs the
 * resolver, `isOriginEnforcementEnabled()` returns false (see below). That is
 * the pre-boot gap, measured in the module-graph startup, not a posture.
 *
 * `credentials: false` (see `buildCorsOptions`) is unchanged and stays
 * unchanged: allow-all origins WITH credentials is a cross-origin READ
 * primitive, and enforcement-on does not create a need for cookies.
 */
import { type OriginIndexResolver } from '@arcaai/applications';
import { Logger } from '@nestjs/common';
import { CORS_ALLOWED_HEADERS, CORS_EXPOSED_HEADERS } from './cors.headers';

const corsLogger = new Logger('CORS');

/**
 * The registry accessor, installed by `PlatformKnobsBinder` once the Nest
 * module graph is up. This module cannot inject a provider — `main.ts` imports
 * it before the graph exists — so the indirection is unavoidable.
 *
 * `null` (no resolver, or a resolver returning `null`) means "the registry is
 * not loaded", NOT "the registry is empty" — though since the two are
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
 * The `origin.enforcementEnabled` accessor, installed by `PlatformKnobsBinder`
 * for the same reason the registry one is: this module is imported by `main.ts`
 * before the Nest module graph exists, so it cannot inject `TenantSettingsService`.
 *
 * `null` — no resolver installed — means PERMISSIVE. This
 * is NO LONGER the platform default (the descriptor defaults `true`); it is the
 * PRE-BOOT state of this process, in force only from module load until
 * `PlatformKnobsBinder.onModuleInit` runs. Read it as "nobody has told this
 * process the answer yet", not as "enforcement is off".
 *
 * The direction is still deliberate, and still the opposite of the registry
 * resolver's: an absent registry denies (there is no allow-list to consult),
 * an absent enforcement switch admits (this process cannot yet know the
 * posture, and guessing `true` would refuse traffic on the strength of a
 * guess). Once the binder is up, the descriptor default `true` applies.
 */
let originEnforcementResolver: (() => boolean) | null = null;

/** Latch so a failing enforcement lookup logs once per outage, not once per request. */
let enforcementLookupFailureReported = false;

/** Install the settings-backed enforcement accessor. Called once from `PlatformKnobsBinder`. */
export function setOriginEnforcementResolver(resolver: (() => boolean) | null): void {
  originEnforcementResolver = resolver;
}

/**
 * THE single source of truth for "is origin enforcement on?" — read by all
 * THREE enforcement points (this file's `isOriginAllowed`, `OriginTenantBindingGuard`,
 * and `SttWsGateway`'s handshake). They import this accessor rather than each
 * resolving the setting themselves: this ticket has already been bitten twice by
 * one rule living in two places, and a switch that is off for the HTTP
 * gate but on for the WS gate is exactly the kind of split that ships silently.
 *
 * FALSE (permissive) whenever no resolver is installed or it throws. Resolved
 * PER CALL, so a settings write applies with no restart — and never memoized,
 * because a memoized `true` could not be turned back off.
 *
 * NEVER throws, and never fails INTO enforcement: a broken settings cache must
 * not be able to start refusing every browser origin on the platform.
 */
export function isOriginEnforcementEnabled(): boolean {
  if (!originEnforcementResolver) return false;
  try {
    const enabled = originEnforcementResolver() === true;
    // Arm the diagnostic again, so the FIRST failure of each outage episode is
    // reported rather than only the first of the process's lifetime.
    enforcementLookupFailureReported = false;
    return enabled;
  } catch (error) {
    // This runs on the per-request hot path; without the latch a settings
    // outage would emit one warn per request.
    if (enforcementLookupFailureReported) return false;
    enforcementLookupFailureReported = true;
    corsLogger.warn({
      message: 'Origin enforcement lookup failed — treating enforcement as DISABLED (permissive), the declared open-to-default failure mode',
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
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
 * catch-all means a previously-working origin now 4xx's, and the
 * rollout depends on that being findable with one grep. Two DISTINCT reasons
 * are surfaced at `warn` (never collapsed into one message):
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
      message: 'Origin registry lookup failed — denying (no bootstrap fallback since)',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The single origin decision, shared by the CORS callback and by any WebSocket
 * handshake that wants the same posture (browsers exempt WS from CORS — see
 * D-6).
 *
 * `_nodeEnv` is INERT and kept only because `main.ts` → `buildCorsOptions` →
 * `getCorsOrigins` thread it through and `isOriginAllowed` is re-exported from
 * `main.ts`. Since the last env-var branch was removed, no value
 * of it can change any verdict — pinned by "returns the same verdict for every
 * value of the nodeEnv argument" in `cors.config.task641.test.ts`. Dropping the
 * parameter is a wider signature change than the deletion needs; it is a
 * cleanup for whoever next touches `main.ts`'s CORS wiring.
 */
export function isOriginAllowed(origin: string | undefined, _nodeEnv: string): boolean {
  // Origin-enforcement switch, checked FIRST and short-circuiting everything below,
  // including the registry lookup. Placing it here rather than inside
  // `queryRegistry` is deliberate: with enforcement off there must be no
  // registry read at all, so a registry outage, an unseeded table and a hostile
  // origin are all indistinguishable — every one of them is simply admitted.
  if (!isOriginEnforcementEnabled()) {
    return logCorsDecision(origin, true, 'enforcement_disabled');
  }

  if (!origin) {
    return logCorsDecision(origin, true, 'no_origin_provided');
  }

  const registered = queryRegistry(origin);

  if (registered === true) {
    return logCorsDecision(origin, true, 'origin_registry_match');
  }

  if (registered === false) {
    return logCorsDecision(origin, false, 'origin_registry_miss');
  }

  // `registered === null`: the registry is unavailable — not installed, not
  // yet loaded (including "loaded but empty", per the binder's collapse), or
  // the lookup threw. FAIL CLOSED. There is no bootstrap allow-list to fall
  // back to any more (owner directive: no env var ever
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
 * RegExp any more. It stays a CALLBACK rather than a static `true`/`false`: the
 * switch is resolved PER REQUEST, so neither posture may be baked into the
 * wiring. Hard-coding either one would mean an operator's write could not take
 * effect without a redeploy, which is the whole point of a live switch —
 * and that property matters in both directions now that
 * enforcement is the default.
 */
export function getCorsOrigins(nodeEnv: string): (origin: string | undefined, callback: CorsOriginCallback) => void {
  return (origin: string | undefined, callback: CorsOriginCallback) => {
    callback(null, isOriginAllowed(origin, nodeEnv));
  };
}

/** The options object handed to `app.enableCors()` — assembled here so it is testable. */
export interface CorsOptions {
  origin: (origin: string | undefined, callback: CorsOriginCallback) => void;
  credentials: boolean;
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
}

/**
 * Assemble the gateway's CORS options.
 *
 * Extracted from `main.ts`'s `bootstrap()` closure for the same reason the
 * origin decision was: a value inside that closure is unreachable to a test,
 * and `credentials` is now a security-load-bearing value rather than a default
 * nobody looks at.
 *
 * ── WHY `credentials: false` ────────────────────────────────────────
 *
 * `credentials: true` PLUS a reflected arbitrary origin is a cross-origin READ
 * primitive: any site a logged-in user visits can issue authenticated requests
 * to this gateway AND READ THE RESPONSES, PHI included. That is not a
 * hypothetical; it is the standard consequence of allowing credentials while
 * reflecting the caller's origin. Enforcement-off produced exactly that shape by
 * default; flipping enforcement on narrows the window to
 * "whenever an operator turns enforcement off" plus this process's pre-boot
 * gap — narrower, but not gone, so `credentials: false` stays (H-4).
 *
 * With `credentials: false`, browsers do not attach cookies cross-origin, and
 * Bearer-token auth is unaffected — the SDK sets the `Authorization` header
 * explicitly, and a hostile page can neither read nor forge it. Two facts were
 * verified before making this change:
 *
 *   • NOTHING reads `req.session`. `express-session` is mounted in `main.ts`
 *     and has no consumers anywhere in `apps/api`.
 *   • NO client sends cookies. Neither `AgenticClient` nor any other SDK or app
 *     transport sets `credentials: 'include'` / `withCredentials`, and the SSO
 *     legs are cookie-free too: the OIDC/SAML `state` is a signed JWT carried in
 *     the URL, and the callback is a top-level navigation, not a CORS fetch.
 *
 * So this costs nothing and removes the exfiltration path. **Open CORS without
 * credentials is an ordinary public-API posture; open CORS with credentials is
 * a data-leak path.** If a future flow ever genuinely needs cross-origin
 * cookies, `origin.enforcementEnabled` must be turned ON *before* `credentials`
 * is turned back on — never the other way round.
 */
export function buildCorsOptions(nodeEnv: string): CorsOptions {
  return {
    origin: getCorsOrigins(nodeEnv),
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
  };
}
