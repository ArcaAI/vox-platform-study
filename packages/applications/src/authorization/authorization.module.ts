import { Module, Global } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { PolicyEngine } from './policy.engine';
import { AuthorizationGuard } from './authorization.guard';
import { UnifiedAuthGuard } from './unified-auth.guard';
import { RedisCacheModule } from '../services/baseServices/redis';
import { ApiKeyServiceModule } from '../services/apiKey/apikey.service.module';

/**
 * AuthorizationModule - Provides unified authentication and policy-based authorization
 *
 * This module is marked as @Global so that UnifiedAuthGuard, PolicyEngine,
 * and AuthorizationGuard are available throughout the application without explicit imports.
 *
 * The UnifiedAuthGuard replaces the previous fragmented guard system
 * (JwtAuthGuard + ApiKeyGuard + EitherAuthGuard + AuthorizationGuard)
 * with a single guard that follows the processing order:
 * Public skip → API Key → JWT → CASL
 */
@Global()
@Module({
    imports: [
        CoreDatabaseModule,
        RedisCacheModule.register(),
        ApiKeyServiceModule,
    ],
    providers: [
        PolicyEngine,
        AuthorizationGuard,
        UnifiedAuthGuard,
    ],
    exports: [
        PolicyEngine,
        AuthorizationGuard,
        UnifiedAuthGuard,
        ApiKeyServiceModule,
    ],
})
export class AuthorizationModule {}
