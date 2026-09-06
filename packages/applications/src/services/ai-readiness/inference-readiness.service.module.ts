import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { RedisCacheModule } from '../baseServices/redis/redis-cache.module';
import { ServiceHealthMonitoringServiceModule } from '../baseServices/serviceHealth';
import { AiProviderConnectionServiceModule } from '../ai-provider-connection';
import { IInferenceReadinessService } from './IInferenceReadinessService';
import { InferenceReadinessService } from './inference-readiness.service';

/**
 * The readiness sweep (TASK-890 §3.12).
 *
 * `ServiceHealthMonitoringServiceModule` is imported rather than the heartbeat
 * Redis keys being read a second time: Nest caches module instances, so this is
 * the SAME singleton the monitoring controller uses — one heartbeat cron, one
 * reader of it, and this lane never edits that file (TASK-902 owns it).
 *
 * `AiProviderConnectionServiceModule` supplies the ONE cascade that decides
 * which engine each provider means for the platform; the sweep never resolves
 * an endpoint of its own.
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    HttpModule,
    RedisCacheModule.register(),
    ServiceHealthMonitoringServiceModule,
    AiProviderConnectionServiceModule,
  ],
  providers: [{ provide: IInferenceReadinessService, useClass: InferenceReadinessService }],
  exports: [IInferenceReadinessService],
})
export class InferenceReadinessServiceModule {}
