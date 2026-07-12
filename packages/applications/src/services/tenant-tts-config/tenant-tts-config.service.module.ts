import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ITenantTtsConfigService } from './ITenantTtsConfigService';
import { TenantTtsConfigService } from './tenant-tts-config.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: ITenantTtsConfigService,
      useClass: TenantTtsConfigService,
    },
    TenantTtsConfigService,
  ],
  exports: [ITenantTtsConfigService, TenantTtsConfigService],
})
export class TenantTtsConfigServiceModule {}
