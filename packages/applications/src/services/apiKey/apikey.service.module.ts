import { Module } from '@nestjs/common';
import { ApiKeyRepository, CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ApiKeyService } from './apikey.service';
import { IApiKeyService } from './IApiKeyService';
import { ApiKeyRateLimiter, IApiKeyRateLimiter } from './apikey-rate-limiter.service';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, EntitlementsServiceModule],
  providers: [
    // The `global-kv` cascade for `apiKey.maxLifetimeDays` /
    // `apiKey.allowQueryParam` (TASK-558 lane I). Provided locally — its only
    // dependency is `IAppSettingsService`, already exported by
    // `CommonServiceModule`, so importing the whole `EffectiveSettingsModule`
    // (pipeline resolver + AI task defaults) would be dead weight.
    TenantSettingsService,
    {
      provide: IApiKeyService,
      useClass: ApiKeyService,
    },
    {
      provide: IApiKeyRateLimiter,
      useClass: ApiKeyRateLimiter,
    },
    ApiKeyRepository,
  ],
  exports: [IApiKeyService, IApiKeyRateLimiter],
})
export class ApiKeyServiceModule {}
