import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices/common.service.module';
import { ConsultationEndpointService } from './consultation-endpoint.service';

/**
 * the consultation ENDPOINT STAGE module.
 *
 * Exported as the concrete class rather than behind a symbol token, matching the other
 * harness-facing consultation services (`HarnessInternalService`, `LiveDocumentationService`):
 * these have exactly one consumer — the internal harness controller — and no substitution point,
 * so a token would be indirection with no seam behind it.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [ConsultationEndpointService],
  exports: [ConsultationEndpointService],
})
export class ConsultationEndpointServiceModule {}
