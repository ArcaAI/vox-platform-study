import { Inject, Injectable, Logger } from '@nestjs/common';
import { IRedisCacheService } from '../baseServices/redis/redis-cache.service';

/**
 * JwtRevocationService (TASK-295 / C-4)
 *
 * Maintains a Redis-backed set of revoked JWT `jti` claims. When the
 * `/auth/revoke-impersonation` endpoint is invoked, the current request's
 * `jti` is added with a TTL bounded by the original token `exp` so the
 * revocation entry self-cleans once the token would have naturally expired.
 *
 * `JwtStrategy.validate` calls `isRevoked(payload.jti)` on every request
 * and refuses the token when the `jti` is present in the set.
 *
 * Wire-format:
 *   Redis key:   `jwt-revoked:<jti>` → "1"
 *   Redis TTL:   max(1, floor(exp - now)) seconds. We always set a positive
 *                TTL so the value cannot persist indefinitely; expired-but-
 *                still-buffered tokens get a minimum 1 s safety window.
 */

export const JWT_REVOCATION_KEY_PREFIX = 'jwt-revoked:';
const MIN_REVOCATION_TTL_SECONDS = 1;

export interface IJwtRevocationService {
  revoke(jti: string, expEpochSeconds: number | undefined): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
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

  async isRevoked(jti: string): Promise<boolean> {
    if (!jti) return false;
    try {
      const value = await this.cache.get(this.key(jti));
      return value !== null;
    } catch (error) {
      this.logger.warn({
        message: 'Failed to check revocation status; treating as not revoked',
        jti,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private key(jti: string): string {
    return `${JWT_REVOCATION_KEY_PREFIX}${jti}`;
  }
}
