import { AuthServiceModule, UserServiceModule } from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';

/**
 * AuthModule - API authentication endpoints
 *
 * Uses AuthServiceModule for JWT/OIDC strategies and IAuthService.
 * Uses UserServiceModule for IUserService.
 * CoreDatabaseModule is kept because AuthController still directly uses
 * repositories for login logic (to be refactored in a follow-up task).
 *
 * Note: JWT_AUTH_GUARD is registered globally in AppModule so that
 * UnifiedAuthGuard can resolve it across all feature modules.
 */
@Module({
    imports: [
        AuthServiceModule,
        UserServiceModule,
        CoreDatabaseModule,
    ],
    controllers: [AuthController],
})
export class AuthModule {}
