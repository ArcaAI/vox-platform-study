import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { AiProviderConnectionServiceModule } from '../ai-provider-connection/ai-provider-connection.service.module';
import { IAiRoutingPolicyService } from './IAiRoutingPolicyService';
import { AiRoutingPolicyService } from './ai-routing-policy.service';

/**
 * `AiProviderConnectionServiceModule` is imported for ONE reason: a routing
 * candidate's funding tier (`BYOK` vs `CLOUD`) is DERIVED from which cascade
 * tier supplies its credential, and that cascade already exists there. Deriving
 * it a second time here is exactly the silent mis-billing the §3A.4 funding
 * gate is meant to prevent.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, AiProviderConnectionServiceModule],
  providers: [
    AiRoutingPolicyService,
    {
      provide: IAiRoutingPolicyService,
      // useExisting, not useClass — useClass would construct a second instance
      // instead of aliasing the one above.
      useExisting: AiRoutingPolicyService,
    },
  ],
  exports: [IAiRoutingPolicyService, AiRoutingPolicyService],
})
export class AiRoutingPolicyServiceModule {}
