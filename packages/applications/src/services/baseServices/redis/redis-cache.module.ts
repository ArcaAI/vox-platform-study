import { DynamicModule, Global, Module } from '@nestjs/common';
import { RedisCacheService, IRedisCacheService } from './redis-cache.service';
import { ConfigModule, IConfigService } from '../_meta/config';

/**
 * Redis Cache Module
 * 
 * Provides Redis caching capabilities for the application.
 * This module is separate from the BullMQ Redis module to allow
 * independent caching operations.
 * 
 * @example
 * ```typescript
 * // In app.module.ts
 * @Module({
 *   imports: [
 *     RedisCacheModule.register(),
 *   ],
 * })
 * export class AppModule {}
 * 
 * // In a service
 * constructor(
 *   @Inject(IRedisCacheService) private readonly cache: IRedisCacheService
 * ) {}
 * ```
 */
@Global()
@Module({})
export class RedisCacheModule {
    /**
     * Register the Redis cache module
     * 
     * @returns Dynamic module configuration
     */
    static register(): DynamicModule {
        return {
            module: RedisCacheModule,
            imports: [ConfigModule],
            providers: [
                {
                    provide: IRedisCacheService,
                    useClass: RedisCacheService,
                },
            ],
            exports: [IRedisCacheService],
        };
    }

    /**
     * Register the Redis cache module asynchronously
     * Useful when you need to configure Redis with async factory
     * 
     * @param options - Async module options
     * @returns Dynamic module configuration
     */
    static registerAsync(options: {
        imports?: any[];
        useFactory: (...args: any[]) => Promise<{ host: string; port: number; password?: string }> | { host: string; port: number; password?: string };
        inject?: any[];
    }): DynamicModule {
        return {
            module: RedisCacheModule,
            imports: [...(options.imports || []), ConfigModule],
            providers: [
                {
                    provide: 'REDIS_CACHE_CONFIG',
                    useFactory: options.useFactory,
                    inject: options.inject || [],
                },
                {
                    provide: IRedisCacheService,
                    useClass: RedisCacheService,
                },
            ],
            exports: [IRedisCacheService],
        };
    }
}
