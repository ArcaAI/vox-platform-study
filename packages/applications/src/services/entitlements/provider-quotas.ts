/**
 * TASK-998 OD-4 — per-provider cloud-ASR capacity quotas: shape, validation and
 * the two-tier merge.
 *
 * > "platform admin will set minute volume by enabled provider globally OR
 * >  specific by tenant that has Pro plan and above"
 *
 * Pure: no NestJS, no DB, no Redis, so the precedence contract is exhaustively
 * unit-testable independently of the service that enforces it — the same shape
 * as `enforcement.ts` and `rate-limit-resolver.ts`.
 *
 * ## Two dimensions, because the vendor enforces two different things
 *
 * | Dimension              | Protects                                              | Checked at              |
 * |------------------------|-------------------------------------------------------|-------------------------|
 * | `requestsPerMinute`    | the sync-REST per-minute cap (Sarvam 60/100/4000)     | batch job create        |
 * | `maxConcurrentStreams` | the concurrent-WebSocket cap (Sarvam 20/100/100)      | streaming session open  |
 *
 * `requestsPerMinute` still binds even though a live consultation is now ONE
 * persistent socket rather than N requests: BATCH transcription stays on REST.
 * `maxConcurrentStreams` is the dimension that binds for LIVE work.
 *
 * ## Precedence — tenant → platform default, per DIMENSION
 *
 * Widening happens ONLY on absence, and it happens per dimension rather than
 * per provider entry, so a tenant allocated its own concurrency does not
 * silently lose the platform's rate default by omitting it.
 *
 * Unresolved at both tiers = `null` = UNLIMITED (no enforcement). That is the
 * seeded state of every plan: the control exists so the platform CAN bound its
 * vendor account, not because a bound is priced today.
 */

/** The two capacity dimensions. */
export const PROVIDER_QUOTA_DIMENSIONS = ['requestsPerMinute', 'maxConcurrentStreams'] as const;
export type ProviderQuotaDimension = (typeof PROVIDER_QUOTA_DIMENSIONS)[number];

/** One provider's resolved capacity. `null` = unlimited for that dimension. */
export interface ProviderQuota {
  /** Vendor sync-REST calls per minute. Enforced at batch-job create. */
  requestsPerMinute: number | null;
  /** Vendor simultaneous streaming sockets. Enforced at session open. */
  maxConcurrentStreams: number | null;
}

/** A `{ provider: quota }` map as stored in `sttProviderQuotas` / resolved. */
export type ProviderQuotaMap = Readonly<Record<string, ProviderQuota>>;

/** Nothing bounded — what an unmentioned provider resolves to. */
export const UNLIMITED_PROVIDER_QUOTA: ProviderQuota = Object.freeze({
  requestsPerMinute: null,
  maxConcurrentStreams: null,
});

/**
 * Read one dimension out of an untyped stored entry.
 *
 * Anything that is not a non-negative finite integer reads as "no opinion"
 * rather than as a limit. A stored value cannot be trusted to be well-typed
 * (JSONB), and a garbled entry must NOT become an accidental cap of 0 on a
 * clinical path — the safe direction for a malformed limit is not to enforce
 * it. The WRITE path (`validateProviderQuotaMap`) is where a malformed value is
 * rejected loudly; this reader is the last line and it fails open on purpose.
 */
function readDimension(entry: unknown, dimension: ProviderQuotaDimension): number | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const value = (entry as Record<string, unknown>)[dimension];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

/** The raw stored map as an object, or `{}` for anything unusable. */
function asRecord(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

/**
 * Normalize one stored `sttProviderQuotas` value into a typed map. Unknown
 * providers are preserved (this is a reader, not a gate — the write path owns
 * the allow-list) so a provider added to `CLOUD_BYO_PROVIDERS.stt` after a row
 * was written still resolves.
 */
export function parseProviderQuotaMap(raw: unknown): ProviderQuotaMap {
  const source = asRecord(raw);
  const out: Record<string, ProviderQuota> = {};
  for (const [provider, entry] of Object.entries(source)) {
    out[provider] = {
      requestsPerMinute: readDimension(entry, 'requestsPerMinute'),
      maxConcurrentStreams: readDimension(entry, 'maxConcurrentStreams'),
    };
  }
  return out;
}

/**
 * Merge the tenant allocation over the platform default, per dimension, over
 * the UNION of both tiers' providers.
 *
 * `tenantRaw` / `planRaw` are the two rows' `sttProviderQuotas` columns exactly
 * as Prisma returns them.
 */
export function resolveProviderQuotas(tenantRaw: unknown, planRaw: unknown): ProviderQuotaMap {
  const tenant = parseProviderQuotaMap(tenantRaw);
  const plan = parseProviderQuotaMap(planRaw);

  const providers = new Set([...Object.keys(plan), ...Object.keys(tenant)]);
  const out: Record<string, ProviderQuota> = {};
  for (const provider of providers) {
    const t = tenant[provider];
    const p = plan[provider];
    out[provider] = {
      // `??` and not `||`: `0` is a real, enforceable allocation ("this tenant
      // may not use this provider's capacity at all"), and `0 || x` would
      // silently widen it back to the platform default.
      requestsPerMinute: t?.requestsPerMinute ?? p?.requestsPerMinute ?? null,
      maxConcurrentStreams: t?.maxConcurrentStreams ?? p?.maxConcurrentStreams ?? null,
    };
  }
  return out;
}

/** One provider's entry out of a resolved map; unmentioned = unlimited. */
export function providerQuotaFor(quotas: ProviderQuotaMap, provider: string | null | undefined): ProviderQuota {
  if (!provider) return UNLIMITED_PROVIDER_QUOTA;
  return quotas[provider] ?? UNLIMITED_PROVIDER_QUOTA;
}

/**
 * WRITE-path validation. Returns a list of human-readable problems; `[]` means
 * the value is storable. The caller (the entitlements service) turns a
 * non-empty list into a 400 — keeping the throw out of this module is what lets
 * the precedence tests run without NestJS.
 *
 * `allowedProviders` MUST be `CLOUD_BYO_PROVIDERS.stt`, passed in rather than
 * imported, so this module has one source of provider truth and no second copy
 * of the list.
 */
export function validateProviderQuotaMap(raw: unknown, allowedProviders: readonly string[]): string[] {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return ['`sttProviderQuotas` must be an object keyed by provider id (or null to clear it).'];
  }

  const problems: string[] = [];
  for (const [provider, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowedProviders.includes(provider)) {
      problems.push(`Unknown STT provider '${provider}'. Allowed: ${allowedProviders.join(', ')}.`);
      continue;
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`'${provider}' must be an object with ${PROVIDER_QUOTA_DIMENSIONS.join(' and/or ')}.`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!(PROVIDER_QUOTA_DIMENSIONS as readonly string[]).includes(key)) {
        problems.push(`'${provider}.${key}' is not a capacity dimension. Allowed: ${PROVIDER_QUOTA_DIMENSIONS.join(', ')}.`);
      }
    }
    for (const dimension of PROVIDER_QUOTA_DIMENSIONS) {
      const value = record[dimension];
      if (value === undefined || value === null) continue; // absent = inherit
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        problems.push(`'${provider}.${dimension}' must be a non-negative integer, or null/absent to inherit the platform default.`);
      }
    }
  }
  return problems;
}
