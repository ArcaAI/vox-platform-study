import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { ConsultationContextSchemaServiceModule } from '../consultation-context-schema/consultation-context-schema.service.module';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { AiProviderConnectionServiceModule } from '../ai-provider-connection/ai-provider-connection.service.module';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { KnownPhiService } from './known-phi.service';
import { TextRequestEnrichmentService } from './text-request-enrichment.service';

/**
 * Supplies {@link TextRequestEnrichmentService} — the single implementation of
 * tenant-credential, runtime-profile and moderation-policy enrichment for
 * outgoing TEXT requests.
 *
 * `EffectiveSettingsModule` supplies the tenant → SYSTEM cascade behind
 * `applyTenantGuardrailPolicy`; without it the service simply pushes no policy,
 * which is the same state as a tenant with no opinion.
 *
 * `KnownPhiService` (consultation, clinician profile, context items and the effective context
 * schema) backs the `known_phi` egress statement; every one of its reads is optional.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, AiProviderConnectionServiceModule, EffectiveSettingsModule, ConsultationContextSchemaServiceModule],
  providers: [KnownPhiService, TextRequestEnrichmentService],
  exports: [KnownPhiService, TextRequestEnrichmentService],
})
export class TextRequestServiceModule {}
