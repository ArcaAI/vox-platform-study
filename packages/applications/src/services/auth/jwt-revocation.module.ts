import { Module } from '@nestjs/common';
import { RedisCacheModule } from '../baseServices/redis/redis-cache.module';
import { JwtRevocationService, IJwtRevocationService } from './jwt-revocation.service';

/**
 * Standalone module for the revocation authority.
 *
 * Extracted from `AuthServiceModule` so NON-auth modules can consume it
 * without importing the whole auth graph (which imports `UserServiceModule`
 * and would therefore make `UserServiceModule → AuthServiceModule` circular).
 * The concrete consumer is `UserServiceModule`, which stamps a per-user
 * not-before when an account is disabled/suspended/deleted (A4).
 *
 * `RedisCacheModule` is `@Global()`; registering it here follows the same
 * per-module `register()` precedent as `AuthServiceModule` and
 * `StreamTicketModule`.
 */
@Module({
  imports: [RedisCacheModule.register()],
  providers: [
    {
      provide: IJwtRevocationService,
      useClass: JwtRevocationService,
    },
  ],
  exports: [IJwtRevocationService],
})
export class JwtRevocationModule {}
