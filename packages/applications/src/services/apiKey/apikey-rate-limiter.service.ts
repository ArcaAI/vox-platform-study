import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { IRedisCacheService } from '../baseServices/redis';

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    limit: number;
    resetAt: Date;
}

export const IApiKeyRateLimiter = Symbol('IApiKeyRateLimiter');

@Injectable()
export class ApiKeyRateLimiter {
    private readonly logger = new Logger(ApiKeyRateLimiter.name);
    private readonly WINDOW_MS = 60_000;

    constructor(
        @Optional() @Inject(IRedisCacheService) private readonly redis?: IRedisCacheService,
    ) {}

    async checkRateLimit(
        apiKeyId: string,
        tenantId: string,
        limit: number,
    ): Promise<RateLimitResult> {
        if (!limit || limit <= 0) {
            return { allowed: true, remaining: Infinity, limit: 0, resetAt: new Date() };
        }

        if (!this.redis?.isConnected()) {
            this.logger.warn({ message: 'Rate limiting skipped — Redis unavailable' });
            return { allowed: true, remaining: limit, limit, resetAt: new Date() };
        }

        const now = Date.now();
        const windowKey = `ratelimit:${tenantId}:${apiKeyId}:${Math.floor(now / this.WINDOW_MS)}`;

        try {
            const current = await this.redis.incr(windowKey);
            if (current === 1) {
                await this.redis.expire(windowKey, Math.ceil(this.WINDOW_MS / 1000) + 1);
            }

            const resetAt = new Date((Math.floor(now / this.WINDOW_MS) + 1) * this.WINDOW_MS);

            return {
                allowed: current <= limit,
                remaining: Math.max(0, limit - current),
                limit,
                resetAt,
            };
        } catch (error) {
            this.logger.error({
                message: 'Rate limit check failed',
                apiKeyId,
                error: error instanceof Error ? error.message : String(error),
            });
            return { allowed: true, remaining: limit, limit, resetAt: new Date() };
        }
    }
}
