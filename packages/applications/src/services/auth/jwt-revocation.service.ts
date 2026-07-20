import { Inject, Injectable, Logger } from '@nestjs/common';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';

/**
 * JwtRevocationService (TASK-295 / C-4; extended by TASK-541)
 *
 * Redis-backed revocation authority for issued access tokens. Two independent
 * revocation axes:
 *
 * 1. **Per-token (`jti`)** — `revoke()` / `checkRevoked()`. Used by
 *    `/auth/logout` and `/auth/revoke-impersonation` to kill ONE token.
 *    Wire-format: `jwt-revoked:<jti>` → `"1"`, TTL bounded by the token `exp`
 *    so the entry self-cleans once the token would have expired anyway.
 *
 * 2. **Per-user not-before (TASK-541 A4)** — `revokeAllForUser()` /
 *    `getUserNotBefore()`. Kills EVERY token already issued to a user without
 *    having to track their jtis. Set when a user is disabled, suspended or
 *    soft-deleted; `JwtStrategy` refuses any token whose `iat` predates the
 *    stamp. Wire-format: `auth:user-nbf:<userId>` → `"<epochSeconds>"`.
 *
 * Both consumers (`JwtStrategy`, `AuthService`) go through this one service —
 * there is deliberately no second revocation implementation to keep in sync.
 */

export const JWT_REVOCATION_KEY_PREFIX = 'jwt-revoked:';
export const USER_NBF_KEY_PREFIX = 'auth:user-nbf:';
const MIN_REVOCATION_TTL_SECONDS = 1;

/**
 * TTL for a per-user not-before stamp. MUST exceed the longest access-token
 * lifetime (`JWT_EXPIRES_IN`, default `1h`) — once the stamp expires, tokens
 * issued before it become acceptable again. 24 h gives a 24× margin over the
 * default while keeping the keyspace bounded.
 */
export const USER_NBF_TTL_SECONDS = 24 * 60 * 60;

/**
 * Result of a revocation lookup.
 *
 * `degraded` is true when the backing store could NOT be consulted (Redis down
 * or erroring). It is surfaced instead of being folded into `revoked` so the
 * CALLER owns the fail-open/fail-closed posture — see `JwtStrategy`, which
 * fails open for ordinary tokens (availability) and closed for impersonation
 * tokens (privilege).
 */
export interface RevocationCheck {
  revoked: boolean;
  degraded: boolean;
}

/** Result of a per-user not-before lookup. `notBefore` is epoch SECONDS. */
export interface UserNotBeforeCheck {
  notBefore: number | null;
  degraded: boolean;
}

export interface IJwtRevocationService {
  revoke(jti: string, expEpochSeconds: number | undefined): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
  checkRevoked(jti: string): Promise<RevocationCheck>;
  revokeAllForUser(userId: string): Promise<void>;
  getUserNotBefore(userId: string): Promise<UserNotBeforeCheck>;
}

export const IJwtRevocationService = Symbol('IJwtRevocationService');

@Injectable()
export class JwtRevocationService implements IJwtRevocationService {
  private readonly logger = new Logger(JwtRevocationService.name);

  constructor(@Inject(IRedisCacheService) private readonly cache: IRedisCacheService) {}

  async revoke(jti: string, expEpochSeconds: number | undefined): Promise<void> {
    if (!jti) return;

    const nowSeconds = Math.floor(Date.now() / 1000);
    let ttl: number;
    if (typeof expEpochSeconds === 'number' && Number.isFinite(expEpochSeconds)) {
      ttl = Math.max(MIN_REVOCATION_TTL_SECONDS, Math.floor(expEpochSeconds - nowSeconds));
    } else {
      ttl = MIN_REVOCATION_TTL_SECONDS;
    }

    try {
      await this.cache.setex(this.key(jti), ttl, '1');
      this.logger.debug({ message: 'JWT jti revoked', jti, ttl });
    } catch (error) {
      this.logger.warn({
        message: 'Failed to revoke jti',
        jti,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Back-compat wrapper: collapses a degraded lookup to "not revoked".
   * Prefer {@link checkRevoked} on enforcement paths so the degraded state
   * is visible to the policy decision.
   */
  async isRevoked(jti: string): Promise<boolean> {
    const { revoked } = await this.checkRevoked(jti);
    return revoked;
  }

  async checkRevoked(jti: string): Promise<RevocationCheck> {
    if (!jti) return { revoked: false, degraded: false };

    try {
      const value = await this.cache.get(this.key(jti));
      return { revoked: value !== null, degraded: false };
    } catch (error) {
      this.logger.warn({
        message: 'Revocation lookup failed; reporting degraded',
        jti,
        error: error instanceof Error ? error.message : String(error),
      });
      return { revoked: false, degraded: true };
    }
  }

  /**
   * TASK-541 A4 — invalidate every access token already issued to `userId`.
   *
   * Best-effort by contract: a Redis failure is logged at ERROR (it leaves a
   * disabled user's outstanding token live until its own `exp`) but never
   * throws, because the caller is mid-mutation — failing the user-disable
   * write itself would be strictly worse than a delayed token death.
   */
  async revokeAllForUser(userId: string): Promise<void> {
    if (!userId) return;

    const nowSeconds = Math.floor(Date.now() / 1000);
    try {
      await this.cache.setex(this.userNbfKey(userId), USER_NBF_TTL_SECONDS, String(nowSeconds));
      this.logger.debug({ message: 'All tokens revoked for user', userId, notBefore: nowSeconds });
    } catch (error) {
      this.logger.error({
        message: 'Failed to stamp user not-before; outstanding tokens stay valid until exp',
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getUserNotBefore(userId: string): Promise<UserNotBeforeCheck> {
    if (!userId) return { notBefore: null, degraded: false };

    try {
      const value = await this.cache.get(this.userNbfKey(userId));
      if (value === null) return { notBefore: null, degraded: false };

      const parsed = Number.parseInt(value, 10);
      // A malformed value must not read as epoch 0 — that would silently
      // accept every token instead of rejecting stale ones.
      return { notBefore: Number.isFinite(parsed) ? parsed : null, degraded: false };
    } catch (error) {
      this.logger.warn({
        message: 'User not-before lookup failed; reporting degraded',
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { notBefore: null, degraded: true };
    }
  }

  private key(jti: string): string {
    return `${JWT_REVOCATION_KEY_PREFIX}${jti}`;
  }

  private userNbfKey(userId: string): string {
    return `${USER_NBF_KEY_PREFIX}${userId}`;
  }
}
