import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { PipelineServiceModule } from '../stt/pipeline';
import { ITenantSttConfigService } from './ITenantSttConfigService';
import { TenantSttConfigService } from './tenant-stt-config.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, PipelineServiceModule],
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
