import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { IdpResolverServiceModule } from '../idp-resolver/idp-resolver.service.module';
import { ITenantIdpConfigService } from './ITenantIdpConfigService';
import { TenantIdpConfigService } from './tenant-idp-config.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, IdpResolverServiceModule],
  providers: [
    {
      provide: ITenantIdpConfigService,
      useClass: TenantIdpConfigService,
    },
    TenantIdpConfigService,
  ],
  exports: [ITenantIdpConfigService, TenantIdpConfigService],
})
export class TenantIdpConfigServiceModule {}
