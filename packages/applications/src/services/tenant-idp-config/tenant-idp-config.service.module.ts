import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { IdpResolverServiceModule } from '../idp-resolver/idp-resolver.service.module';
import { ITenantIdpConfigService } from './ITenantIdpConfigService';
import { TenantIdpConfigService } from './tenant-idp-config.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, IdpResolverServiceModule],
  providers: [
    TenantIdpConfigService,
    {
      provide: ITenantIdpConfigService,
      // useExisting, not useClass — useClass would construct a second
      // TenantIdpConfigService instance instead of aliasing the one above.
      // No cache/listener/timer state here, so the duplicate was harmless,
      // but aliasing is free.
      useExisting: TenantIdpConfigService,
    },
  ],
  exports: [ITenantIdpConfigService, TenantIdpConfigService],
})
export class TenantIdpConfigServiceModule {}
