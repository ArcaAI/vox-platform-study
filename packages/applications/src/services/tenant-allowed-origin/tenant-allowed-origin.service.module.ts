import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ITenantAllowedOriginService } from './ITenantAllowedOriginService';
import { TenantAllowedOriginService } from './tenant-allowed-origin.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    TenantAllowedOriginService,
    {
      provide: ITenantAllowedOriginService,
      // useExisting, not useClass — useClass would construct a second
      // TenantAllowedOriginService instance instead of aliasing the one
      // above. This is the CRUD service for allowed-origin rows (distinct
      // from OriginRegistryService's cache); it holds no state of its own,
      // so the duplicate was harmless, but aliasing is free.
      useExisting: TenantAllowedOriginService,
    },
  ],
  exports: [ITenantAllowedOriginService, TenantAllowedOriginService],
})
export class TenantAllowedOriginServiceModule {}
