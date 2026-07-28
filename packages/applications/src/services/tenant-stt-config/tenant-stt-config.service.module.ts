import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { AiProviderConnectionServiceModule } from '../ai-provider-connection';
import { CommonServiceModule } from '../baseServices';
import { PipelineServiceModule } from '../stt/pipeline';
import { ITenantSttConfigService } from './ITenantSttConfigService';
import { TenantSttConfigService } from './tenant-stt-config.service';

@Module({
  // AiProviderConnectionServiceModule supplies `IProviderConnectionService` —
  // the unified plane `TenantSttConfigService` now delegates BYO STT
  // credential storage/resolution to (TASK-571).
  imports: [CommonServiceModule, CoreDatabaseModule, PipelineServiceModule, AiProviderConnectionServiceModule],
  providers: [
    {
      provide: ITenantSttConfigService,
      useClass: TenantSttConfigService,
    },
    TenantSttConfigService,
  ],
  exports: [ITenantSttConfigService, TenantSttConfigService],
})
export class TenantSttConfigServiceModule {}
