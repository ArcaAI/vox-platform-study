/**
 * The internal service-to-service call contract ( +).
 *
 * ONE place that answers both halves of "how does an internal HTTP hop identify
 * itself", so a tenth caller cannot reintroduce the gap the first nine had:
 *
 *  1. **WHO is calling** — `X-Service-Token`, carrying the single shared
 *     `INTERNAL_ACCESS_TOKEN` (owner decision D-D, 2026-08-17). Resolution
 *     order and the legacy per-service fallback live in
 *     {@link resolveInternalAccessToken}.
 *  2. **WHOSE work it is** — `X-Tenant-Id`, MANDATORY on every internal request
 *     that carries tenant-scoped work (owner directive 2026-08-16). An absent
 *     header is a defect in the CALLER, never something the callee papers over
 *     with a default.
 *
 * ### Why a sentinel exists
 *
 * Some internal work genuinely has no tenant — a platform-wide job queue, a
 * by-slug model-weight lookup, a control-plane pull. Before this contract those
 * calls were INDISTINGUISHABLE from a header dropped in transit, and the
 * receiver had to guess. Guessing is what made the failure mode invisible:
 * because tenants may only TIGHTEN relative to SYSTEM, resolving SYSTEM on an
 * absent header silently downgrades a tenant that chose a stricter posture to
 * the platform floor, with no error raised anywhere.
 *
 * So tenant-less work now DECLARES itself: it sends `X-Tenant-Id:
 * tenantless:<reason>`. Absence is then unambiguously a bug.
 *
 * The value is deliberately NOT UUID-shaped, so a future bug that treats it as
 * a real tenant id is caught by an existing `z.string().uuid()` / `isUuid()`
 * check instead of silently addressing some tenant's rows. It is also never
 * `50000000-…` — that is a CUSTOMER tenant (the platform-admin playground),
 * never a fallback tier.
 */

/** Header carrying the shared internal access token (owner decision D-D). */
export const SERVICE_TOKEN_HEADER = 'X-Service-Token';

/** Header carrying tenant identity on the gateway↔python-service hops. */
export const TENANT_ID_HEADER = 'X-Tenant-Id';

/** Prefix marking a DECLARED tenant-less internal call. Never a UUID. */
export const TENANTLESS_PREFIX = 'tenantless:';

/**
 * The sanctioned tenant-less reasons. A reason slug is REQUIRED (not a bare
 * `tenantless` marker) so a log line naming the value explains itself without
 * cross-referencing this ticket.
 */
export const TENANTLESS = {
  /** Platform-wide job queue with no per-tenant column in its envelope. */
  JOB_QUEUE: `${TENANTLESS_PREFIX}job-queue`,
  /** By-slug, worker-process-resident model-weight resolution. */
  WORKER_WEIGHTS: `${TENANTLESS_PREFIX}worker-weights`,
  /** `internal/effective-config` pulls + service self-registration. */
  CONTROL_PLANE: `${TENANTLESS_PREFIX}control-plane`,
  /**
   * A platform-operator action with no working tenant selected — e.g. a
   * SUPER_ADMIN driving the AI playground cross-tenant. Legitimately has no
   * tenant, and must NOT be mistaken for a dropped header.
   */
  PLATFORM_OPERATOR: `${TENANTLESS_PREFIX}platform-operator`,
} as const;

export type TenantlessReason = (typeof TENANTLESS)[keyof typeof TENANTLESS];

/** True when `value` is a declared tenant-less marker rather than a tenant id. */
export function isTenantlessMarker(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(TENANTLESS_PREFIX);
}

/**
 * The value to put in `X-Tenant-Id` for an internal call.
 *
 * A real tenant id wins. When there is none, the caller must say WHY — hence the
 * required `fallback` argument: there is deliberately no overload that lets a
 * caller omit the header, because "omitted" is exactly the ambiguity this
 * contract removes.
 */
export function tenantHeaderValue(tenantId: string | null | undefined, fallback: TenantlessReason): string {
  const trimmed = typeof tenantId === 'string' ? tenantId.trim() : '';
  return trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Build the header set for an internal service-to-service call.
 *
 * Both headers are ALWAYS present. `X-Service-Token` is sent even when empty
 * (fail-closed: the receiver rejects it rather than the hop silently downgrading
 * to unauthenticated HTTP), matching `AiInferenceClient`'s existing posture.
 */
export function internalServiceHeaders(options: {
  serviceToken: string;
  tenantId: string | null | undefined;
  tenantlessReason: TenantlessReason;
  extra?: Record<string, string>;
}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    [SERVICE_TOKEN_HEADER]: options.serviceToken,
    [TENANT_ID_HEADER]: tenantHeaderValue(options.tenantId, options.tenantlessReason),
    ...(options.extra ?? {}),
  };
}

/**
 * The literal `scripts/env-sync.mts` writes into `.env.sample` for every secret, and
 * `scripts/generate-env-file.sh` leaves behind for any credential it cannot synthesize. It
 * means "no operator has filled this in" — the ABSENCE of a value, not a value.
 */
export const PLACEHOLDER_SECRET = 'CHANGE_ME';

/**
 * A secret's value, or `''` when it is absent or still the unfilled placeholder.
 *
 * Needed because the sentinel is a NON-EMPTY string, so every `if (x)` / `x || fallback` guard
 * around a secret silently accepts it and stops looking. On the `SECRETS_PROVIDER=env` path
 * `getSecretOptional` returns whatever the env file holds verbatim, so an unfilled
 * `INTERNAL_ACCESS_TOKEN=CHANGE_ME` would be PRESENTED as the credential on every internal hop
 * and rejected by every peer. `scripts/vault-seed-secrets.sh` already refuses to write this
 * value for the same reason; this is the read side of that same rule.
 *
 * The Python services share one definition of this in `hope_env.placeholders`; the two must
 * agree, which is why both spell the sentinel out rather than inferring it.
 */
export function realSecret(value: string | undefined | null): string {
  if (typeof value !== 'string') return '';
  return value.trim() === PLACEHOLDER_SECRET ? '' : value;
}

/**
 * Resolve the token to PRESENT on an internal hop (owner decision D-D).
 *
 * The canonical credential is the ONE shared `INTERNAL_ACCESS_TOKEN`. The legacy
 * per-service `*_SERVICE_TOKEN` is consulted only as a zero-cost
 * backward-compatibility fallback, so an environment that has not yet been
 * migrated keeps working; it is expected to be dropped once the shared token is
 * deployed everywhere.
 *
 * `''` (rather than a throw) when neither is configured — that is the local-dev /
 * hermetic-CI bypass every Python `ServiceAuthMiddleware` already implements.
 */
export async function resolveInternalAccessToken(
  secrets: { getSecretOptional(key: string): Promise<string | undefined> } | undefined,
  legacyKey: string,
): Promise<string> {
  const shared = realSecret(await secrets?.getSecretOptional('INTERNAL_ACCESS_TOKEN'));
  if (shared) return shared;
  return realSecret(await secrets?.getSecretOptional(legacyKey));
}
