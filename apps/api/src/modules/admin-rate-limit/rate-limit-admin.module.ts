import { Module } from '@nestjs/common';
import { RateLimitServiceModule } from '@arcaai/applications';
import { RateLimitAdminController } from './rate-limit-admin.controller';

/**
 * Exposes the system-admin rate-limit endpoints. Imports
 * `RateLimitServiceModule` for `IRateLimitAdminService` (write path +
 * `getPolicy`).
 */
@Module({
  imports: [RateLimitServiceModule],
  controllers: [RateLimitAdminController],
})
export class RateLimitAdminModule {}
