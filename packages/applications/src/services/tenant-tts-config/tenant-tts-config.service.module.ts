import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ITenantTtsConfigService } from './ITenantTtsConfigService';
import { TenantTtsConfigService } from './tenant-tts-config.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    TenantTtsConfigService,
    {
      provide: ITenantTtsConfigService,
      // useExisting, not useClass — useClass would construct a second
      // TenantTtsConfigService instance instead of aliasing the one above.
      // This service is a stateless BaseService (no listeners/timers), so the
      // duplicate was harmless, but aliasing is free and keeps a single
      // instance behind both tokens.
      useExisting: TenantTtsConfigService,
    },
  ],
  exports: [ITenantTtsConfigService, TenantTtsConfigService],
})
export class TenantTtsConfigServiceModule {}
