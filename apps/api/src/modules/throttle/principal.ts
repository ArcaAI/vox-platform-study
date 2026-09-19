/**
 * Who a request is counted against, INSIDE its tenant (TASK-993 OD-2).
 *
 * ## Why a second identity at all
 *
 * The tenant id answers "whose budget does this spend". It does not answer
 * "which caller spent it", and with a single tenant-wide counter it could not:
 * one looping integration, one stuck poller or one browser tab in a reconnect
 * storm consumed the whole tenant's minute and every other doctor on that
 * tenant got a 429 they did nothing to earn.
 *
 * ## The trust rule is the tenant's, verbatim
 *
 * `TieredThrottlerGuard` already proves the tenant from the credential itself
 * because that claim decides which COUNTER a request spends. The principal is
 * decided by exactly the same act of proof and is never derived separately:
 *
 *   - **JWT** — the `id` claim of a payload whose HS256 signature just
 *     verified. An unsigned or forged token yields no tenant, so it yields no
 *     principal either.
 *   - **API key / service-account token** — the peek that proved the tenant is
 *     a hit against a blob written by a SUCCESSFUL authentication, so a peek
 *     that answered a tenant has already established that this exact
 *     credential string is real. The principal is that string's fingerprint.
 *
 * A credential that cannot be proven has no principal and rides the platform
 * IP-keyed lane, exactly as anonymous traffic does.
 *
 * ## Why a fingerprint rather than the credential
 *
 * The bucket key reaches Redis and, on a 429, the throttler's own diagnostics.
 * A raw API key must never land in either. SHA-256 truncated to 132 bits is
 * not reversible and is fixed-width, so the Redis key size is bounded whatever
 * the credential's length.
 */

import { createHash } from 'node:crypto';

/**
 * 22 base64url characters = 132 bits of a SHA-256 digest. Far past any
 * collision concern for a per-tenant bucket namespace, and short enough that
 * the Redis key stays small.
 */
const FINGERPRINT_CHARS = 22;

/** A stable, non-reversible id for a credential string. */
export function credentialFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('base64url').slice(0, FINGERPRINT_CHARS);
}

/**
 * The caller a request was PROVEN to come from.
 *
 * `tenantId === null` is untrusted traffic (ranks 4-5, IP-keyed).
 * `principalId === null` means the credential proved a tenant but not a
 * distinguishable caller — today only a JWT that carries `tenantId` and no
 * `id`. Such a request still spends the tenant's aggregate, it simply has no
 * second bucket; the alternative (inventing a shared "anonymous-in-tenant"
 * principal) would put unrelated callers in one bucket and refuse them for
 * each other's traffic.
 */
export interface TrustedCaller {
  tenantId: string | null;
  principalId: string | null;
}

export const UNTRUSTED_CALLER: TrustedCaller = Object.freeze({ tenantId: null, principalId: null });

/** Principal id for a human session — the verified `id` claim. */
export const userPrincipal = (userId: string): string => `u:${userId}`;

/** Principal id for an API key, from the key's own fingerprint. */
export const apiKeyPrincipal = (rawKey: string): string => `k:${credentialFingerprint(rawKey)}`;

/**
 * Principal id for a service-account token.
 *
 * KNOWN LIMIT, deliberately accepted: the token is exchanged fresh roughly
 * every 15 minutes, so this id rotates with it — about 15 windows of stability
 * at the 60 s default. That is ample for the fairness property this lane
 * exists to create (a runaway loop does not re-exchange), and closing it would
 * mean widening `IServiceAccountService.peekTenantForRateLimit` to return the
 * account id, which belongs to that service's lane rather than this one.
 * Recorded as a TASK-993 follow-up.
 */
export const serviceAccountPrincipal = (token: string): string => `s:${credentialFingerprint(token)}`;
