import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';
import { IProviderConnectionService } from './IProviderConnectionService';
import { AiProviderConnectionService } from './ai-provider-connection.service';
import { ProviderCredentialResolver } from './provider-credential-resolver';

// `IProviderConnectionService` and the deprecated `IAiProviderConnectionService`
// alias are the SAME symbol value, so registering the token once resolves both
// `@Inject(IProviderConnectionService)` and the legacy `@Inject(IAiProviderConnectionService)`
// (text-proxy) until it is repointed.
@Module({
  // `EntitlementsServiceModule` supplies the platform-default gate
  // . It is the ONLY consumer-visible reason this module grew an
  // import: without it the resolver denies the SYSTEM credential tier outright
  // (fail-closed), which is correct but silently disables the cascade.
  imports: [CommonServiceModule, CoreDatabaseModule, EntitlementsServiceModule],
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
    // TASK-862 — the one-credential resolver agents/workflows consume.
    ProviderCredentialResolver,
  ],
  exports: [IProviderConnectionService, AiProviderConnectionService, ProviderCredentialResolver],
})
export class AiProviderConnectionServiceModule {}
