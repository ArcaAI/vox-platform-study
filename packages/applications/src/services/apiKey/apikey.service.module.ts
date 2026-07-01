import { Module } from '@nestjs/common';
import { ApiKeyRepository, CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ApiKeyService } from './apikey.service';
import { IApiKeyService } from './IApiKeyService';
import { ApiKeyRateLimiter, IApiKeyRateLimiter } from './apikey-rate-limiter.service';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, EntitlementsServiceModule],
  providers: [
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
