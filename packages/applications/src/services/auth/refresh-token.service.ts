import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';

/**
 * RefreshTokenService (TASK-307 W1.1 — audit 04 §C-1 / C-12 / D-10)
 *
 * Closes the BLOCKER refresh-token forgery finding from the API-gateway
 * audit. The legacy `refresh_<userId>_<ts>_<random>` format was forgeable
 * because the random component was never persisted server-side — the
 * `userId` between the underscores was the only thing the refresh
 * handler trusted.
 *
 * This service replaces that pattern with the RFC 6749 §10.4
 * "refresh-token rotation" pattern used by Auth0 / Okta:
 *
 *   - `issue(...)`    — generate an opaque base64url token, hash it with
 *                       SHA-256, and persist the hash in Redis with
 *                       `{userId, tenantId, jti, family, expiresAt}`.
 *   - `consume(...)`  — single-use: look up the hash, delete the active
 *                       row, write a "consumed" marker, return the
 *                       recorded session attributes.
 *   - `revokeFamily(.)`— delete every member of a refresh-token family
 *                        (used on logout AND on reuse-detection).
 *
 * Family semantics: every login creates a new family id; every refresh
 * threads the same family id through. If a previously-consumed token is
 * ever presented again, the consumed-marker → family revocation kicks in
 * and ALL outstanding tokens in that family are revoked. This is the
 * defence against attackers who exfiltrated a refresh token before the
 * legitimate user rotated it.
 *
 * Wire-format (Redis keys, all TTL-bounded):
 *   refresh-token:<sha256(token)>              → JSON record
 *   refresh-token-family:<family>:<sha256>     → "1" (membership marker)
 *   refresh-token-consumed:<sha256>            → "<family>"
 *
 * TTL is configurable via `REFRESH_TOKEN_TTL_SECONDS` env var; default
 * 7 days (`604800`) per the user-locked decision in
 * `docs/implementation/TASK-307-API-Gateway-Hardening/README.md` §1.5.
 *
 * Documented trade-offs (TASK-307 W7.A — carryover from W1 review):
 *
 *   - **Sliding TTL via rotation.** Every successful `consume()` issues
 *     a fresh token whose TTL is `Date.now() + REFRESH_TOKEN_TTL_SECONDS`.
 *     A session that rotates indefinitely therefore persists beyond the
 *     nominal 7-day window. This is intentional UX (Auth0 / Okta share
 *     the same behaviour) — it is NOT a TTL leak. Sessions stop only
 *     when (a) the user logs out (`revokeFamily`), (b) reuse is detected
 *     (auto-revoke of the family), or (c) the user is disabled
 *     server-side. See TASK-307 §10 deferrals for the "absolute family
 *     lifetime" follow-up if a hard cap is ever needed.
 *
 *   - **Atomic `consume()` flip via Lua (TASK-310 W7.A.4 / AC-2).** The
 *     active → consumed transition is collapsed into a single
 *     `EVAL`-driven script (`REFRESH_TOKEN_CONSUME_LUA`) so the
 *     GET / DEL / DEL / SETEX sequence runs as one atomic Redis op.
 *     This closes the microsecond race window that previously made two
 *     concurrent `consume()` calls each return the same record (legit
 *     rotation + attacker replay both winning). Race-replay covered by
 *     the `Promise.all([consume(t), consume(t)])` unit test.
 *
 *   - **`REFRESH_TOKEN_TTL_SECONDS` read via `process.env` in the
 *     constructor** (see implementation). `IConfigService` is the
 *     canonical typed-config wrapper, but the cache service this
 *     module depends on (`IRedisCacheService`) already injects
 *     `IConfigService` for its own connection setup — adding a second
 *     injection here purely for TTL parsing is more wiring than the
 *     single env-var lookup needs. The `// eslint-disable-next-line
 *     turbo/no-undeclared-env-vars` is the project convention for this
 *     pattern (see `apps/api/src/main.ts`). Deferred as a §10 nit; the
 *     compatibility contract is unchanged either way.
 */

export const REFRESH_TOKEN_KEY_PREFIX = 'refresh-token:';
export const REFRESH_TOKEN_FAMILY_KEY_PREFIX = 'refresh-token-family:';
export const REFRESH_TOKEN_CONSUMED_KEY_PREFIX = 'refresh-token-consumed:';

const REFRESH_TOKEN_RAW_BYTES = 48;
const REFRESH_FAMILY_RAW_BYTES = 16;
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/**
 * TASK-310 W7.A.4 (AC-2) — atomic consume Lua script.
 *
 * Inputs:
 *   KEYS[1] = active-token key   (e.g. `refresh-token:<sha256>`)
 *   KEYS[2] = consumed-marker key (e.g. `refresh-token-consumed:<sha256>`)
 *   ARGV[1] = family-member key prefix (`refresh-token-family:`)
 *   ARGV[2] = `:<sha256>` suffix used to compose the family-member key
 *   ARGV[3] = current epoch seconds (for remaining-TTL calculation)
 *
 * Returns:
 *   - the persisted JSON record (string) when the active row existed and
 *     was consumed by this call.
 *   - `false` when the active row was missing (Redis returns false → ioredis
 *     surfaces it as `null` to the JS caller).
 *
 * Behaviour:
 *   - Decodes the record via `cjson.decode`. If the JSON is missing
 *     `family` / `expiresAt`, drops the active row (corrupt) and returns
 *     false so the caller surfaces a 401 — same outcome as the legacy
 *     try/catch around `JSON.parse`.
 *   - Computes `remainingTtl = max(1, expiresAt - now)` so the consumed
 *     marker only lives as long as the legitimate active row would have.
 *   - DELs the active row + the family-member marker, then SETEXes the
 *     consumed-marker key to the family id so reuse-detection still works.
 *
 * The script is sent verbatim per call (no SCRIPT LOAD / EVALSHA). The
 * call frequency for refresh-token consumes is low and the script body
 * is small (~25 lines including blank lines), so the EVALSHA cache hit
 * is not worth the extra `NOSCRIPT` fallback complexity.
 */
export const REFRESH_TOKEN_CONSUME_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return false
end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' or type(record.family) ~= 'string' or type(record.expiresAt) ~= 'number' then
  redis.call('DEL', KEYS[1])
  return false
end
local memberKey = ARGV[1] .. record.family .. ARGV[2]
local now = tonumber(ARGV[3])
local remainingTtl = record.expiresAt - now
if remainingTtl < 1 then
  remainingTtl = 1
end
redis.call('DEL', KEYS[1])
redis.call('DEL', memberKey)
redis.call('SETEX', KEYS[2], remainingTtl, record.family)
return raw
`.trim();

export interface IssuedRefreshToken {
  rawToken: string;
  family: string;
  expiresAt: number;
}

export interface ConsumedRefreshToken {
  userId: string;
  tenantId: string;
  jti: string;
  family: string;
}

export interface IssueRefreshTokenInput {
  userId: string;
  tenantId: string;
  jti: string;
  /** Optional — supply to continue an existing family (rotation). */
  family?: string;
}

export interface IRefreshTokenService {
  issue(input: IssueRefreshTokenInput): Promise<IssuedRefreshToken>;
  consume(rawToken: string): Promise<ConsumedRefreshToken>;
  revokeFamily(family: string): Promise<void>;
}

export const IRefreshTokenService = Symbol('IRefreshTokenService');

interface PersistedRecord {
  userId: string;
  tenantId: string;
  jti: string;
  family: string;
  expiresAt: number;
}

@Injectable()
export class RefreshTokenService implements IRefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);
  private readonly ttlSeconds: number;

  constructor(@Inject(IRedisCacheService) private readonly cache: IRedisCacheService) {
    const rawTtl = process.env.REFRESH_TOKEN_TTL_SECONDS;
    const parsed = rawTtl ? Number(rawTtl) : NaN;
    this.ttlSeconds = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TTL_SECONDS;
  }

  async issue(input: IssueRefreshTokenInput): Promise<IssuedRefreshToken> {
    const rawToken = crypto.randomBytes(REFRESH_TOKEN_RAW_BYTES).toString('base64url');
    const family = input.family ?? crypto.randomBytes(REFRESH_FAMILY_RAW_BYTES).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    const hash = this.hash(rawToken);

    const record: PersistedRecord = {
      userId: input.userId,
      tenantId: input.tenantId ?? '',
      jti: input.jti,
      family,
      expiresAt,
    };

    await this.cache.setex(this.key(hash), this.ttlSeconds, JSON.stringify(record));
    await this.cache.setex(this.familyMemberKey(family, hash), this.ttlSeconds, '1');

    return { rawToken, family, expiresAt };
  }

  async consume(rawToken: string): Promise<ConsumedRefreshToken> {
    if (!rawToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const hash = this.hash(rawToken);

    // TASK-310 W7.A.4 (AC-2): atomic GET / DEL / DEL / SETEX via Lua.
    // Redis serialises EVAL scripts, so two concurrent `consume()` calls
    // race-replay deterministically: exactly one observes the active row
    // and wins, the other sees null and falls through to the reuse-
    // detection branch below.
    const raw = (await this.cache.eval(
      REFRESH_TOKEN_CONSUME_LUA,
      2,
      this.key(hash),
      this.consumedKey(hash),
      REFRESH_TOKEN_FAMILY_KEY_PREFIX,
      `:${hash}`,
      String(Math.floor(Date.now() / 1000)),
    )) as string | null;

    if (raw === null) {
      // Either the token is unknown/expired, OR it was consumed earlier
      // (by this call's loser sibling, by a previous flip, or by an
      // attacker replay). The consumed-marker pins the family we need
      // to revoke.
      const reusedFamily = await this.cache.get(this.consumedKey(hash));
      if (reusedFamily) {
        this.logger.warn({
          message: 'Refresh token reuse detected — revoking entire family (RFC 6749 §10.4)',
          family: reusedFamily,
        });
        await this.revokeFamily(reusedFamily);
      }
      throw new UnauthorizedException('Invalid refresh token');
    }

    let record: PersistedRecord;
    try {
      record = JSON.parse(raw) as PersistedRecord;
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return {
      userId: record.userId,
      tenantId: record.tenantId,
      jti: record.jti,
      family: record.family,
    };
  }

  async revokeFamily(family: string): Promise<void> {
    if (!family) return;

    // TASK-307 W7.A.1 — switched from blocking `KEYS` to non-blocking
    // `SCAN` (cursor iteration). The previous implementation called
    // `cache.keys(pattern)`, which Redis services as O(N) over the
    // entire keyspace and BLOCKS the server thread for the duration —
    // a 1M-key store can stall every other Redis client for tens of
    // milliseconds. `scan()` walks the keyspace in 200-key chunks via
    // cursor without holding the lock.
    const memberPrefix = `${REFRESH_TOKEN_FAMILY_KEY_PREFIX}${family}:`;
    const memberKeys = await this.cache.scan(`${memberPrefix}*`);
    if (memberKeys.length === 0) return;

    const tokenKeys: string[] = [];
    for (const memberKey of memberKeys) {
      const hash = memberKey.substring(memberPrefix.length);
      tokenKeys.push(this.key(hash));
    }
    await this.cache.delMany([...memberKeys, ...tokenKeys]);
  }

  private hash(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  private key(hash: string): string {
    return `${REFRESH_TOKEN_KEY_PREFIX}${hash}`;
  }

  private familyMemberKey(family: string, hash: string): string {
    return `${REFRESH_TOKEN_FAMILY_KEY_PREFIX}${family}:${hash}`;
  }

  private consumedKey(hash: string): string {
    return `${REFRESH_TOKEN_CONSUMED_KEY_PREFIX}${hash}`;
  }
}
