import { Module } from '@nestjs/common';
import { CommonServiceModule } from '../baseServices';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';
import { IProviderCapacityService } from './IProviderCapacityService';
import { ProviderCapacityService } from './provider-capacity.service';

/**
 * TASK-998 OD-4 — the OUTBOUND cloud-ASR vendor-capacity limiter.
 *
 * `EntitlementsServiceModule` supplies the resolved numbers
 * (`PlanEntitlement.sttProviderQuotas` platform default merged with the
 * `TenantEntitlement.sttProviderQuotas` allocation); `CommonServiceModule`
 * the metrics service. `IRedisCacheService` is provided globally by
 * `RedisCacheModule` (`@Global`), so — exactly as in
 * `PlatformMetricsServiceModule` — it is injected without a local import.
 *
 * Imported by the STT streaming and transcription-job modules, the two places
 * that reach a cloud ASR vendor.
 */
@Module({
  imports: [CommonServiceModule, EntitlementsServiceModule],
  providers: [{ provide: IProviderCapacityService, useClass: ProviderCapacityService }],
  exports: [IProviderCapacityService],
})
export class ProviderCapacityServiceModule {}
