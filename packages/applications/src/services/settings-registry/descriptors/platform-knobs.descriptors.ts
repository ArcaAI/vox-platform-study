// Platform knobs — MIGRATED from env to `global-kv` (TASK-558 lane I).
//
// WHAT CHANGED FROM LANE F. Lane F classified these ten keys and recorded
// `tier: 'env'` + `targetTier: 'global-kv'`, because at that point every one of
// them was still read from `process.env`. Lane I performs the migration the
// `targetTier` recorded: the values now live in `GlobalSetting`, resolved
// through `TenantSettingsService`, and `targetTier` is dropped because `tier`
// is final. The HONESTY RULE is unchanged and still binding — `tier` states
// where the value lives TODAY, so a key whose reader has not moved does not get
// flipped (see `feature-flags.descriptors.ts` for the keys that stayed).
//
// WHY THEY QUALIFIED — plan §9.2 L1: "environment variables are immutable for
// the lifetime of the process. Anything that must change without a restart is
// NOT an env var." Every knob here fails that test: an operator tightening a
// rate limit, widening CORS, or shortening an API-key lifetime should not need
// a redeploy.
//
// ── THE ENV VAR IS NOT GONE — IT IS THE BOOTSTRAP FALLBACK ──────────────────
// Each key keeps its `<KEY>` env variable as a DOCUMENTED first-boot fallback,
// exactly as lane E kept `MINIO_ENDPOINT` behind the SYSTEM storage row: a
// process must be able to come up before the `GlobalSetting` rows exist (fresh
// database, pre-seed, disaster recovery), and two of these knobs are consumed
// before the Nest module graph exists at all. The env value is therefore the
// SEED for the platform row (`seed/11a-platform-knob-settings.ts`) and the last
// resort when no row is readable — and whenever it is the tier that answered,
// that fact is logged (§9.2 L8). `apps/api/src/config/env.schema.ts` keeps
// validating the variables for exactly that reason.
//
// ── SCOPE ASSIGNMENT (plan §13.4) ───────────────────────────────────────────
// Platform-only (`maxScope: 'system'`, `globalOnly: true`) — operational,
// never per-tenant:  logLevel · corsAllowedOrigins · shutdown.*
// Tenant-overridable (`maxScope: 'tenant'`) — the knobs a plan tier
// differentiates:    rateLimit.* · apiKey.maxLifetimeDays · refreshToken.ttlSeconds
//
// ONE ASSIGNMENT §13.4 DID NOT MAKE, decided here on evidence rather than
// guessed: `apiKey.allowQueryParam` is PLATFORM-ONLY. Its only reader is
// `ApiKeyService.extractApiKeyFromRequest`, which runs while the request is
// still ANONYMOUS — it is the step that pulls the credential out in order to
// discover who is calling. There is no tenant to scope it to at that point, so
// `maxScope: 'tenant'` would declare a cascade level that can never be reached.
//
// ── WHY A TENANT SCOPE ON A SECURITY KNOB IS SAFE ───────────────────────────
// `maxScope: 'tenant'` on a rate limit or a credential lifetime would be an
// escalation path if a tenant could LOOSEN it by writing its own row. It
// cannot: `tenant-clamp.ts` declares, per key, which direction is stricter, and
// `TenantSettingsService` refuses the other one — plus the entitlement ceiling
// (§9.3 M2) bounds anything the plan differentiates. A tenant may throttle
// itself harder or shorten its own token lifetimes; it can never do the
// reverse.
//
// ⚠️ ALREADY-MIGRATED SIBLINGS — the rate-limit family has TWO forms live at
// once, which is why it is worth spelling out:
//   `rate-limit.enabled`, `rate-limit.tier.<t>.limit|ttl`  → resolved from
//       `GlobalSetting` at REQUEST time by `RateLimitSettingsService`.
//   `rateLimit.enabled|maxRequests|windowMs`               → the same values as
//       the `default` throttler's BOOTSTRAP baseline, read once by
//       `RateLimitConfigService` to construct the throttler definitions before
//       any DB is reachable, and now ALSO the per-tenant control plane.
// They are not duplicates: one builds the throttler at boot, the other decides
// what it enforces per request per tenant.

import { RATE_LIMIT_TIER_DEFAULTS, RATE_LIMIT_TIERS } from '../../rate-limit/rate-limit.constants';
import { SettingDescriptor } from '../registry.types';

/**
 * A knob whose value now lives in the `GlobalSetting` KV, with its env variable
 * demoted to a bootstrap fallback.
 *
 * `editableBy: 'GlobalSetting'` matches `entitlements.enabled`, the existing
 * `global-kv` exemplar, and is what `SettingsRegistryWriteController`
 * (`@CanManage('GlobalSetting')`) gates on. It is deliberately NOT the `none`
 * sentinel any more: there IS an admin write path now, and a governance test
 * binds `editableBy: 'none'` to `tier: 'env'` in both directions.
 */
function migratedGlobalKv(
  key: string,
  dataType: SettingDescriptor['dataType'],
  scope: 'system' | 'tenant',
  category: string,
  label: string,
  description: string,
  defaultValue?: unknown,
): SettingDescriptor {
  return {
    key,
    tier: 'global-kv',
    dataType,
    sensitivity: 'internal',
    maxScope: scope,
    editableBy: 'GlobalSetting',
    // A platform-only knob is a global-admin surface. A tenant-overridable one
    // is NOT `globalOnly` — a tenant admin must be able to write its own row —
    // but the write lane still requires a global admin for a SYSTEM-scope
    // write, so "tenant-editable" never means "platform-editable".
    ...(scope === 'system' ? { globalOnly: true } : {}),
    // Operational knobs: an unresolved value degrades to the descriptor
    // default, which is the reader's historical fallback — i.e. exactly today's
    // behaviour. Fail-closed would turn a missing row into an outage for
    // something that has always had a default.
    failMode: 'open-to-default',
    category,
    label,
    description,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  };
}

export const PLATFORM_KNOB_SETTINGS: SettingDescriptor[] = [
  // ── Observability / lifecycle — platform-only ─────────────────────────────
  migratedGlobalKv(
    'logLevel',
    'enum',
    'system',
    'Platform Operations',
    'Log level',
    'Gateway log level, applied live by `PlatformKnobsBinder` through `ILoggingService.setLevel` whenever the settings cache refreshes — so an operator can raise verbosity during an incident with no redeploy. `LOG_LEVEL` remains the BOOTSTRAP value: it is read pre-bootstrap in `apps/api/src/main.ts` (before the Nest module graph, therefore before any DB) to seed the Nest logger.',
    'info',
  ),
  migratedGlobalKv(
    'corsAllowedOrigins',
    'string[]',
    'system',
    'Platform Operations',
    'CORS allowed origins',
    'Comma-separated allowed origins for the production CORS policy. `isOriginAllowed` consults this per REQUEST, so the DB value takes effect without a restart — the clearest §9.2 L1 case in this file, and a security-relevant list an operator must be able to tighten immediately. `CORS_ALLOWED_ORIGINS` remains the bootstrap fallback used until the platform row is readable.',
  ),
  migratedGlobalKv(
    'shutdown.timeoutMs',
    'number',
    'system',
    'Platform Operations',
    'Graceful shutdown timeout (ms)',
    'Upper bound on graceful shutdown before the process is forced down. `GracefulShutdownService` resolves it at SHUTDOWN time, not construction time, so a change applies to the next drain without a restart. `SHUTDOWN_TIMEOUT_MS` remains the bootstrap fallback.',
    30000,
  ),
  migratedGlobalKv(
    'shutdown.drainDelayMs',
    'number',
    'system',
    'Platform Operations',
    'Shutdown drain delay (ms)',
    'Delay between failing readiness and closing the server, so a load balancer stops routing before connections drop. Resolved at drain time (see `shutdown.timeoutMs`). `SHUTDOWN_DRAIN_DELAY_MS` remains the bootstrap fallback.',
    5000,
  ),

  // ── Credential / session policy ───────────────────────────────────────────
  migratedGlobalKv(
    'apiKey.maxLifetimeDays',
    'number',
    'tenant',
    'Authentication',
    'API key maximum lifetime (days)',
    "Ceiling on a requested API-key expiry, resolved for the KEY'S TENANT at issue time. UNSET MEANS UNLIMITED — `apikey.service.ts` skips the clamp when no value resolves. A tenant may SHORTEN its own ceiling (or set one where the platform has none) but never lengthen it past the platform value (`tenant-clamp.ts`: lower-is-stricter). `API_KEY_MAX_LIFETIME_DAYS` remains the bootstrap fallback.",
  ),
  migratedGlobalKv(
    'apiKey.allowQueryParam',
    'boolean',
    'system',
    'Authentication',
    'Allow API key in query parameter',
    'When true, an API key may be presented as a query parameter. PLATFORM-ONLY by construction: the only reader is the ANONYMOUS credential-extraction step, which runs before the caller — and therefore the tenant — is known, so there is no tenant scope to resolve it at. Query strings land in access logs and referrers: keep OFF unless a specific integration forces it. `API_KEY_ALLOW_QUERY_PARAM` remains the bootstrap fallback.',
    false,
  ),
  migratedGlobalKv(
    'refreshToken.ttlSeconds',
    'number',
    'tenant',
    'Authentication',
    'Refresh token TTL (seconds)',
    'Refresh-token lifetime, resolved for the ISSUING tenant on every `issue()` — previously read once in the `RefreshTokenService` constructor, so a change needed a restart. A tenant may only SHORTEN it (`tenant-clamp.ts`: lower-is-stricter). A non-finite or non-positive resolved value falls back to the 7-day default. `REFRESH_TOKEN_TTL_SECONDS` remains the bootstrap fallback.',
    7 * 24 * 60 * 60,
  ),

  // ── Rate limiting — the per-tenant control plane ──────────────────────────
  migratedGlobalKv(
    'rateLimit.enabled',
    'boolean',
    'tenant',
    'Platform Operations',
    'Rate limiting enabled',
    'Whether throttling is enforced. A tenant may only move this towards the STRICT end (`tenant-clamp.ts`: true-is-stricter), so a tenant admin can switch throttling ON for itself but can never switch off a protection the platform has enabled. `RATE_LIMIT_ENABLED` remains the module-bootstrap baseline read by `RateLimitConfigService` (`!== "false"`), which only decides whether the throttler is WIRED at boot.',
    true,
  ),
  migratedGlobalKv(
    'rateLimit.maxRequests',
    'number',
    'tenant',
    'Platform Operations',
    'Default tier request limit',
    'Requests per window for the always-on `default` throttler tier, resolved PER TENANT on the hot path by `TieredThrottlerGuard`. A tenant may only LOWER it, and never above its plan entitlement (§9.3 M2 — the entitlement ceiling). `RATE_LIMIT_MAX_REQUESTS` remains the module-bootstrap baseline.',
    RATE_LIMIT_TIER_DEFAULTS.default.limit,
  ),
  migratedGlobalKv(
    'rateLimit.windowMs',
    'number',
    'tenant',
    'Platform Operations',
    'Default tier window (ms)',
    'Window length for the always-on `default` throttler tier, resolved per tenant with `rateLimit.maxRequests`. A LONGER window over the same limit is a TIGHTER budget, so this is the one knob where a tenant may only raise the number (`tenant-clamp.ts`: higher-is-stricter) — otherwise a tenant could set a 1 ms window and make its limit meaningless. `RATE_LIMIT_WINDOW_MS` remains the module-bootstrap baseline.',
    RATE_LIMIT_TIER_DEFAULTS.default.ttl,
  ),
];

/**
 * The rate-limit TIER policy keys — `global-kv` since before this ticket.
 *
 * `RateLimitSettingsService` already resolves each of these from `GlobalSetting`
 * via `IAppSettingsService`, falling back to `RATE_LIMIT_TIER_DEFAULTS`. They
 * were simply never CATALOGED, so they were invisible to
 * `GET /admin/settings/catalog` and unreachable through the registry write
 * surface — the same gap `platform-ops.descriptors.ts` closed for the
 * rate-limit master switch.
 *
 * Keys use the service's own key builders' grammar
 * (`rate-limit.tier.<tier>.<limit|ttl>`) — a hyphenated legacy namespace that
 * predates the plan §3.3 dotted-lowerCamel convention and is therefore NOT
 * env-name-mapped (renaming it would orphan every already-written row).
 *
 * They stay `maxScope: 'system'`: the per-tenant lane for the `default` tier is
 * `rateLimit.maxRequests` / `rateLimit.windowMs` above, and the non-default
 * tiers (strict/heavy/relaxed) gate brute-force-sensitive routes whose limits
 * are a platform safety property, not a plan feature.
 */
export const RATE_LIMIT_TIER_SETTINGS: SettingDescriptor[] = RATE_LIMIT_TIERS.flatMap<SettingDescriptor>((tier) => [
  {
    key: `rate-limit.tier.${tier}.limit`,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: `Rate limit — ${tier} tier request limit`,
    description: `Requests permitted per window for the '${tier}' throttler tier. Falls back to the code baseline when no row exists.`,
    default: RATE_LIMIT_TIER_DEFAULTS[tier].limit,
  },
  {
    key: `rate-limit.tier.${tier}.ttl`,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: `Rate limit — ${tier} tier window (ms)`,
    description: `Window length in milliseconds for the '${tier}' throttler tier. Falls back to the code baseline when no row exists.`,
    default: RATE_LIMIT_TIER_DEFAULTS[tier].ttl,
  },
]);
