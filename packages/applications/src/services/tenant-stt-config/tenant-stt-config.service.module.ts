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
  // credential storage/resolution to.
  imports: [CommonServiceModule, CoreDatabaseModule, PipelineServiceModule, AiProviderConnectionServiceModule],
  providers: [
    TenantSttConfigService,
    {
      provide: ITenantSttConfigService,
      // useExisting, not useClass — useClass would construct a second
      // TenantSttConfigService instance instead of aliasing the one above.
      // Its `new Map(...)` usages are local variables inside method bodies,
      // not instance state, so the duplicate was harmless, but aliasing is
      // free.
      useExisting: TenantSttConfigService,
    },
  ],
  exports: [ITenantSttConfigService, TenantSttConfigService],
})
/** @deprecated TASK-861 — removed in R4. with `TenantSttConfig`. */
export class TenantSttConfigServiceModule {}
