// Platform knobs that are STILL env but belong in `global-kv` (TASK-558 lane F).
//
// HONESTY RULE (the one that shapes this whole file): `tier` states where the
// value lives TODAY, not where the plan wants it. Every key below is read from
// `process.env` by a line this lane verified, so every key below is `tier: 'env'`
// — even though plan §3.2 lists them under `global-kv`. The plan's intent is not
// lost: it is recorded structurally as `targetTier: 'global-kv'`, which makes the
// outstanding migration QUERYABLE rather than a paragraph someone has to reread.
// Lane F classifies; it migrates nothing (F3).
//
// WHY THESE QUALIFY FOR `global-kv` AT ALL — plan §9.2 L1: "environment variables
// are immutable for the lifetime of the process. Anything that must change
// without a restart is NOT an env var." Every knob here fails that test: an
// operator tightening a rate limit, widening CORS, or shortening an API-key
// lifetime should not need a redeploy.
//
// THE MIGRATION EACH DESCRIPTOR IMPLIES (what a later lane must do per key):
//   1. seed/author the `GlobalSetting` row under the dotted key named in
//      `targetTier` note below,
//   2. move the reader from `process.env.X` to the resolved value,
//   3. flip `tier` to `global-kv` and DROP `targetTier`,
//   4. demote the env var to a first-boot fallback, then delete it one release on.
// Step 2 is the load-bearing one — until a reader moves, flipping the tier would
// make this catalog lie.
//
// ⚠️ ALREADY-MIGRATED SIBLINGS — DO NOT CONFUSE THEM WITH THESE.
// The rate-limit family has BOTH forms live at once, which is exactly why it is
// worth spelling out:
//   `rate-limit.enabled`, `rate-limit.tier.<t>.limit|ttl`  → `global-kv`, already
//       resolved from `GlobalSetting` by `RateLimitSettingsService` at REQUEST time.
//   `RATE_LIMIT_ENABLED|MAX_REQUESTS|WINDOW_MS`            → env, read ONCE by
//       `RateLimitConfigService` at MODULE-BOOTSTRAP time to construct the
//       throttler definitions.
// They are not duplicates: the env pair is the bootstrap baseline, the DB keys
// are the live control plane. The tier descriptors below are registered here
// because they were never cataloged, while `rate-limit.enabled` already was
// (`platform-ops.descriptors.ts`).

import { RATE_LIMIT_TIER_DEFAULTS, RATE_LIMIT_TIERS } from '../../rate-limit/rate-limit.constants';
import { EDITABLE_BY_NONE, SettingDescriptor } from '../registry.types';

/** An env-read knob whose eventual home is the `GlobalSetting` KV. */
function pendingGlobalKv(
  key: string,
  dataType: SettingDescriptor['dataType'],
  category: string,
  label: string,
  description: string,
  defaultValue?: unknown,
): SettingDescriptor {
  return {
    key,
    tier: 'env',
    targetTier: 'global-kv',
    dataType,
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: EDITABLE_BY_NONE,
    // Operational knobs: an unset value resolves to the reader's own fallback,
    // which is exactly today's behaviour. Fail-closed would turn a missing knob
    // into a boot failure for something that has always had a default.
    failMode: 'open-to-default',
    category,
    label,
    description,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  };
}

export const PLATFORM_KNOB_SETTINGS: SettingDescriptor[] = [
  // ── Observability / lifecycle ─────────────────────────────────────────────
  pendingGlobalKv(
    'logLevel',
    'enum',
    'Platform Operations',
    'Log level',
    'Gateway log level. Read PRE-BOOTSTRAP in `apps/api/src/main.ts` (before the Nest module graph, therefore before `loadEnv()` has read `.env.dev`), so today it sees HOST env only — plan §2.2 secondary defect, fixed by lane B/D. Migration also has to move that read behind the validated schema (plan §4 B5).',
    'info',
  ),
  pendingGlobalKv(
    'corsAllowedOrigins',
    'string[]',
    'Platform Operations',
    'CORS allowed origins',
    'Comma-separated allowed origins. Also a pre-bootstrap read in `main.ts` + `cors.config.ts`. A security-relevant list an operator should be able to tighten without a redeploy — the clearest §9.2 L1 case in this file.',
  ),
  pendingGlobalKv(
    'shutdown.timeoutMs',
    'number',
    'Platform Operations',
    'Graceful shutdown timeout (ms)',
    'Upper bound on graceful shutdown before the process is forced down (`GracefulShutdownService`).',
    30000,
  ),
  pendingGlobalKv(
    'shutdown.drainDelayMs',
    'number',
    'Platform Operations',
    'Shutdown drain delay (ms)',
    'Delay between failing readiness and closing the server, so a load balancer stops routing before connections drop.',
    5000,
  ),

  // ── Credential / session policy ───────────────────────────────────────────
  pendingGlobalKv(
    'apiKey.maxLifetimeDays',
    'number',
    'Authentication',
    'API key maximum lifetime (days)',
    'Ceiling on a requested API-key expiry. UNSET MEANS UNLIMITED — `apikey.service.ts` parses it to `null` and skips the clamp. A security ceiling with an unbounded default is precisely the kind of policy an admin should be able to set live.',
  ),
  pendingGlobalKv(
    'apiKey.allowQueryParam',
    'boolean',
    'Authentication',
    'Allow API key in query parameter',
    'When true, an API key may be presented as a query parameter (compared strictly against `"true"`, so anything else is false). Query strings land in access logs and referrers — keep OFF unless a specific integration forces it.',
    false,
  ),
  pendingGlobalKv(
    'refreshToken.ttlSeconds',
    'number',
    'Authentication',
    'Refresh token TTL (seconds)',
    'Refresh-token lifetime. Read ONCE in the `RefreshTokenService` constructor, so a change needs a restart today; a non-finite or non-positive value silently falls back to the 7-day default.',
    7 * 24 * 60 * 60,
  ),

  // ── Rate limiting: the env BOOTSTRAP baselines ────────────────────────────
  pendingGlobalKv(
    'rateLimit.enabled',
    'boolean',
    'Platform Operations',
    'Rate limiting enabled (bootstrap)',
    'Module-bootstrap switch read by `RateLimitConfigService` as `!== "false"`, so anything other than the literal string `false` leaves throttling ON. The LIVE control plane is the already-cataloged `rate-limit.enabled` global-kv key; this env var only decides whether the throttler is wired at boot.',
    true,
  ),
  pendingGlobalKv(
    'rateLimit.maxRequests',
    'number',
    'Platform Operations',
    'Default tier request limit (bootstrap)',
    'Requests per window for the `default` throttler tier at module bootstrap. Superseded at request time by the `rate-limit.tier.default.limit` global-kv key below.',
    RATE_LIMIT_TIER_DEFAULTS.default.limit,
  ),
  pendingGlobalKv(
    'rateLimit.windowMs',
    'number',
    'Platform Operations',
    'Default tier window (ms) (bootstrap)',
    'Window length for the `default` throttler tier at module bootstrap. Superseded at request time by the `rate-limit.tier.default.ttl` global-kv key below.',
    RATE_LIMIT_TIER_DEFAULTS.default.ttl,
  ),
];

/**
 * The rate-limit TIER policy keys — genuinely `global-kv` TODAY.
 *
 * `RateLimitSettingsService` already resolves each of these from `GlobalSetting`
 * via `IAppSettingsService.getValueWithDefault`, falling back to
 * `RATE_LIMIT_TIER_DEFAULTS`. They were simply never CATALOGED, so they were
 * invisible to `GET /admin/settings/catalog` and unreachable through the
 * registry write surface — the same gap `platform-ops.descriptors.ts` closed for
 * the rate-limit master switch.
 *
 * Registering them changes ZERO behaviour: every default is read from
 * `RATE_LIMIT_TIER_DEFAULTS`, the same constant the service falls back to, so a
 * read that misses the DB resolves exactly as it does today. Keys are built with
 * the service's own key builders' grammar (`rate-limit.tier.<tier>.<limit|ttl>`)
 * — a hyphenated legacy namespace that predates the plan §3.3 dotted-lowerCamel
 * convention and is therefore NOT env-name-mapped (renaming it would orphan
 * every already-written `GlobalSetting` row).
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
