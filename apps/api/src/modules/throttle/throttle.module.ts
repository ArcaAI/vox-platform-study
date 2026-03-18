import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { RateLimitConfigService } from './rate-limit-config.service';

/**
 * Configures distributed rate limiting with Redis-backed storage.
 *
 * Named throttlers:
 *   - default  : 100 req / 60s (general API usage)
 *   - strict   : 10 req / 60s  (auth endpoints, brute-force protection)
 *   - heavy    : 20 req / 60s  (summary generation, AI processing)
 *   - relaxed  : 300 req / 60s (health probes, monitoring)
 *
 * Controllers override via @Throttle() or skip via @SkipThrottle().
 * Env overrides: RATE_LIMIT_ENABLED, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS
 */
@Module({
    imports: [
        ThrottlerModule.forRootAsync({
            useFactory: () => {
                const configService = new RateLimitConfigService();

                if (!configService.isEnabled()) {
                    return { throttlers: [] };
                }

                return {
                    throttlers: configService.getThrottlerModuleConfig(),
                };
            },
        }),
    ],
    providers: [
        RateLimitConfigService,
        {
            provide: APP_GUARD,
            useClass: ThrottlerGuard,
        },
    ],
    exports: [RateLimitConfigService],
})
export class ThrottleConfigModule {}
