import { DynamicModule, Module } from '@nestjs/common';
import { S3Service } from './s3.service';
import { IS3Service } from './IS3Service';
import { S3HealthService } from './s3.health.service';
import { AppSettingsModule } from '../../_meta/appSettings';

/**
 * S3ServiceModule provides S3-compatible storage functionality.
 *
 * This module depends on AppSettingsModule for configuration.
 *
 * The S3Service will only initialize if the required configuration is available
 * in AppSettingsService. If configuration is missing during module initialization,
 * the service will remain uninitialized and attempt lazy initialization on first use.
 *
 * Required configuration keys:
 * - S3_ENDPOINT: S3 service endpoint URL (required)
 * - S3_ACCESS_KEY: S3 access key (required)
 * - S3_SECRET_KEY: S3 secret key (required)
 *
 * Optional configuration keys:
 * - S3_REGION: S3 region (default: 'us-east-1')
 * - S3_PUBLIC_BUCKET: Default public bucket name
 * - S3_PRIVATE_BUCKET: Default private bucket name
 * - S3_FORCE_PATH_STYLE: Force path-style URLs (default: true for MinIO compatibility)
 * - S3_REJECT_UNAUTHORIZED: Reject unauthorized SSL certificates (default: false for MinIO, true for AWS)
 * - S3_PRESIGNED_URL_EXPIRY: Presigned URL expiry in seconds (default: 3600)
 * - S3_MAX_RETRIES: Connection retry attempts (default: 3)
 * - S3_REQUEST_TIMEOUT: Request timeout in milliseconds (default: 30000)
 *
 * Usage Option 1 - When AppSettingsModule is already global:
 * ```typescript
 * // In your app.module.ts
 * @Module({
 *   imports: [
 *     AppSettingsModule.forRoot(), // Global import
 *     S3ServiceModule, // Simple import
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * Usage Option 2 - Self-contained import (recommended):
 * ```typescript
 * // In your app.module.ts or feature module
 * @Module({
 *   imports: [
 *     S3ServiceModule.forRoot(), // Includes AppSettingsModule
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * The service automatically detects MinIO based on endpoint patterns and applies
 * appropriate optimizations for MinIO compatibility.
 *
 * Includes S3HealthService for monitoring and health checks.
 */
@Module({
    providers: [
        {
            provide: IS3Service,
            useClass: S3Service,
        },
        S3HealthService,
    ],
    exports: [IS3Service, S3HealthService],
})
export class S3ServiceModule {
    /**
     * Import S3ServiceModule with AppSettingsModule dependency included.
     * This is the recommended way to import the module as it ensures all dependencies are available.
     */
    static forRoot(): DynamicModule {
        return {
            module: S3ServiceModule,
            imports: [AppSettingsModule.forRoot()],
            providers: [
                {
                    provide: IS3Service,
                    useClass: S3Service,
                },
                S3HealthService,
            ],
            exports: [IS3Service, S3HealthService],
        };
    }

    /**
     * Import S3ServiceModule assuming AppSettingsModule is already globally available.
     * Use this only if you're certain AppSettingsModule.forRoot() is imported at the root level.
     */
    static forFeature(): DynamicModule {
        return {
            module: S3ServiceModule,
            providers: [
                {
                    provide: IS3Service,
                    useClass: S3Service,
                },
                S3HealthService,
            ],
            exports: [IS3Service, S3HealthService],
        };
    }
}
