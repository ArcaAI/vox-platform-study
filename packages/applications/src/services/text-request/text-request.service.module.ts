import { Module } from '@nestjs/common';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { AiProviderConnectionServiceModule } from '../ai-provider-connection/ai-provider-connection.service.module';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { TextRequestEnrichmentService } from './text-request-enrichment.service';

/**
 * Supplies {@link TextRequestEnrichmentService} — the single implementation of
 * tenant-credential, runtime-profile and moderation-policy enrichment for
 * outgoing TEXT requests.
 *
 * `EffectiveSettingsModule` supplies the tenant → SYSTEM cascade behind
 * `applyTenantGuardrailPolicy`; without it the service simply pushes no policy,
 * which is the same state as a tenant with no opinion.
 */
@Module({
  imports: [CommonServiceModule, AiProviderConnectionServiceModule, EffectiveSettingsModule],
  providers: [TextRequestEnrichmentService],
  exports: [TextRequestEnrichmentService],
})
export class TextRequestServiceModule {}
