import { Module } from '@nestjs/common';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { AiRuntimeProfileServiceModule } from '../ai-runtime-profile/ai-runtime-profile.service.module';
import { AiProviderConnectionServiceModule } from '../ai-provider-connection/ai-provider-connection.service.module';
import { SmrRequestEnrichmentService } from './smr-request-enrichment.service';

/**
 * Supplies {@link SmrRequestEnrichmentService} — the single implementation of
 * tenant-credential + runtime-profile enrichment for outgoing SMR requests.
 */
@Module({
  imports: [CommonServiceModule, AiRuntimeProfileServiceModule, AiProviderConnectionServiceModule],
  providers: [SmrRequestEnrichmentService],
  exports: [SmrRequestEnrichmentService],
})
export class SmrRequestServiceModule {}
