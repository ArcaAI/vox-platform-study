import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ITenantAllowedOriginService } from './ITenantAllowedOriginService';
import { TenantAllowedOriginService } from './tenant-allowed-origin.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: ITenantAllowedOriginService,
      useClass: TenantAllowedOriginService,
    },
    TenantAllowedOriginService,
  ],
  exports: [ITenantAllowedOriginService, TenantAllowedOriginService],
})
export class TenantAllowedOriginServiceModule {}
