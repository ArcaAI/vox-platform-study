import { Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { RateLimitOptions } from '../../../decorators/gateway-decorators';

/**
 * Rate limit result interface
 */
export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetTime: Date;
    totalHits: number;
}

/**
 * Rate limiting service using Redis sliding window algorithm
 */
@Injectable()
export class RateLimitingService {
    private readonly logger = new Logger(RateLimitingService.name);
    private redis: Redis;

    constructor() {
        // Redis connection will be injected via module
        // For now, this is a placeholder - actual Redis instance will be provided by RedisServiceModule
    }

    /**
     * Set Redis instance (called by module)
     */
    setRedisInstance(redis: Redis): void {
        this.redis = redis;
    }

    /**
     * Check if request is within rate limit using sliding window algorithm
     * @param key - Unique identifier for the rate limit (user ID, IP, etc.)
     * @param options - Rate limit configuration
     * @returns Rate limit result
     */
    async checkRateLimit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
        const windowKey = `rate_limit:${key}:${Math.floor(Date.now() / options.windowMs)}`;
        const previousWindowKey = `rate_limit:${key}:${Math.floor(Date.now() / options.windowMs) - 1}`;

        try {
            // Use Redis pipeline for atomic operations
            const pipeline = this.redis.pipeline();

            // Get current window count
            pipeline.get(windowKey);
            // Get previous window count
            pipeline.get(previousWindowKey);
            // Increment current window
            pipeline.incr(windowKey);
            // Set expiration for current window
            pipeline.expire(windowKey, Math.ceil(options.windowMs / 1000) * 2);

            const results = await pipeline.exec();

            if (!results) {
                throw new Error('Redis pipeline execution failed');
            }

            const currentCount = parseInt(results[0]?.[1]?.toString() || '0');
            const previousCount = parseInt(results[1]?.[1]?.toString() || '0');
            const newCount = parseInt(results[2]?.[1]?.toString() || '1');

            // Calculate sliding window rate
            const windowProgress = (Date.now() % options.windowMs) / options.windowMs;
            const estimatedCount = previousCount * (1 - windowProgress) + newCount;

            const allowed = estimatedCount <= options.requests;
            const remaining = Math.max(0, options.requests - Math.ceil(estimatedCount));
            const resetTime = new Date(Math.ceil(Date.now() / options.windowMs) * options.windowMs);

            // Log rate limit events for monitoring
            if (!allowed) {
                this.logger.warn({
                    message: 'Rate limit exceeded',
                    key,
                    currentCount: Math.ceil(estimatedCount),
                    limit: options.requests,
                    windowMs: options.windowMs,
                });
            }

            return {
                allowed,
                remaining,
                resetTime,
                totalHits: Math.ceil(estimatedCount),
            };
        } catch (error) {
            this.logger.error({
                message: 'Rate limiting check failed',
                key,
                error: error instanceof Error ? error.message : String(error),
            });

            // Fail open - allow request if Redis is unavailable
            return {
                allowed: true,
                remaining: options.requests,
                resetTime: new Date(Date.now() + options.windowMs),
                totalHits: 0,
            };
        }
    }

    /**
     * Check multiple rate limits for a user (per-user, per-IP, global)
     * @param identifiers - Object with different identifiers
     * @param userLimits - Rate limits for different categories
     * @returns Combined rate limit result
     */
    async checkMultipleRateLimits(
        identifiers: {
            userId?: string;
            ip: string;
            apiKey?: string;
            endpoint?: string;
        },
        userLimits: {
            perUser?: RateLimitOptions;
            perIP?: RateLimitOptions;
            perApiKey?: RateLimitOptions;
            perEndpoint?: RateLimitOptions;
            global?: RateLimitOptions;
        }
    ): Promise<RateLimitResult> {
        const checks: Promise<RateLimitResult>[] = [];

        // Check user-specific rate limit
        if (identifiers.userId && userLimits.perUser) {
            checks.push(this.checkRateLimit(`user:${identifiers.userId}`, userLimits.perUser));
        }

        // Check IP-based rate limit
        if (userLimits.perIP) {
            checks.push(this.checkRateLimit(`ip:${identifiers.ip}`, userLimits.perIP));
        }

        // Check API key rate limit
        if (identifiers.apiKey && userLimits.perApiKey) {
            checks.push(this.checkRateLimit(`apikey:${identifiers.apiKey}`, userLimits.perApiKey));
        }

        // Check endpoint-specific rate limit
        if (identifiers.endpoint && userLimits.perEndpoint) {
            checks.push(this.checkRateLimit(`endpoint:${identifiers.endpoint}`, userLimits.perEndpoint));
        }

        // Check global rate limit
        if (userLimits.global) {
            checks.push(this.checkRateLimit('global', userLimits.global));
        }

        try {
            const results = await Promise.all(checks);

            // Find the most restrictive result
            const restrictiveResult = results.reduce((most, current) => {
                if (!current.allowed) return current;
                if (!most.allowed) return most;
                return current.remaining < most.remaining ? current : most;
            });

            return restrictiveResult;
        } catch (error) {
            this.logger.error({
                message: 'Multiple rate limit check failed',
                userId: identifiers.userId,
                ip: identifiers.ip,
                apiKey: identifiers.apiKey,
                endpoint: identifiers.endpoint,
                error: error instanceof Error ? error.message : String(error),
            });

            // Fail open
            return {
                allowed: true,
                remaining: 100,
                resetTime: new Date(Date.now() + 60000),
                totalHits: 0,
            };
        }
    }

    /**
     * Reset rate limit for a specific key (admin operation)
     * @param key - Rate limit key to reset
     * @returns Success status
     */
    async resetRateLimit(key: string): Promise<boolean> {
        try {
            const pattern = `rate_limit:${key}:*`;
            const keys = await this.redis.keys(pattern);

            if (keys.length > 0) {
                await this.redis.del(...keys);
                this.logger.log({
                    message: 'Rate limit reset',
                    key,
                    deletedKeys: keys.length,
                });
            }

            return true;
        } catch (error) {
            this.logger.error({
                message: 'Failed to reset rate limit',
                key,
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        }
    }

    /**
     * Get current rate limit status without incrementing
     * @param key - Rate limit key
     * @param options - Rate limit configuration
     * @returns Current status
     */
    async getRateLimitStatus(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
        const windowKey = `rate_limit:${key}:${Math.floor(Date.now() / options.windowMs)}`;
        const previousWindowKey = `rate_limit:${key}:${Math.floor(Date.now() / options.windowMs) - 1}`;

        try {
            const pipeline = this.redis.pipeline();
            pipeline.get(windowKey);
            pipeline.get(previousWindowKey);

            const results = await pipeline.exec();

            if (!results) {
                throw new Error('Redis pipeline execution failed');
            }

            const currentCount = parseInt(results[0]?.[1]?.toString() || '0');
            const previousCount = parseInt(results[1]?.[1]?.toString() || '0');

            const windowProgress = (Date.now() % options.windowMs) / options.windowMs;
            const estimatedCount = previousCount * (1 - windowProgress) + currentCount;

            const allowed = estimatedCount < options.requests;
            const remaining = Math.max(0, options.requests - Math.ceil(estimatedCount));
            const resetTime = new Date(Math.ceil(Date.now() / options.windowMs) * options.windowMs);

            return {
                allowed,
                remaining,
                resetTime,
                totalHits: Math.ceil(estimatedCount),
            };
        } catch (error) {
            this.logger.error({
                message: 'Failed to get rate limit status',
                key,
                windowMs: options.windowMs,
                error: error instanceof Error ? error.message : String(error),
            });

            // Return permissive status on error
            return {
                allowed: true,
                remaining: options.requests,
                resetTime: new Date(Date.now() + options.windowMs),
                totalHits: 0,
            };
        }
    }
}