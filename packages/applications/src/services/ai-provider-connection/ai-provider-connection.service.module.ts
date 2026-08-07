import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { IProviderConnectionService } from './IProviderConnectionService';
import { AiProviderConnectionService } from './ai-provider-connection.service';

// `IProviderConnectionService` and the deprecated `IAiProviderConnectionService`
// alias are the SAME symbol value, so registering the token once resolves both
// `@Inject(IProviderConnectionService)` and the legacy `@Inject(IAiProviderConnectionService)`
// (smr-proxy) until TASK-572 repoints.
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    AiProviderConnectionService,
    {
      provide: IProviderConnectionService,
      // useExisting, not useClass — useClass would construct a second
      // AiProviderConnectionService instance instead of aliasing the one
      // above. It holds no credential cache of its own (resolution goes
      // through Vault/repositories per call), so the duplicate was
      // harmless, but aliasing is free.
      useExisting: AiProviderConnectionService,
    },
  ],
  exports: [IProviderConnectionService, AiProviderConnectionService],
})
export class AiProviderConnectionServiceModule {}
