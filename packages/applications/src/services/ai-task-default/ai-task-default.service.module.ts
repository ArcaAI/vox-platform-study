import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { AiRoutingPolicyServiceModule } from '../ai-routing-policy/ai-routing-policy.service.module';
import { IAiTaskDefaultService } from './IAiTaskDefaultService';
import { AiTaskDefaultService } from './ai-task-default.service';

/**
 * @deprecated TASK-862 — removed in R3. `AiTaskDefaultService` is a facade over
 * `AiRoutingPolicyService.resolveDefault`; import `AiRoutingPolicyServiceModule`
 * and inject `IAiRoutingPolicyService` in new code.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, AiRoutingPolicyServiceModule],
  providers: [
    AiTaskDefaultService,
    {
      provide: IAiTaskDefaultService,
      // useExisting, not useClass — useClass would construct a second instance.
      useExisting: AiTaskDefaultService,
    },
  ],
  exports: [IAiTaskDefaultService, AiTaskDefaultService],
})
export class AiTaskDefaultServiceModule {}
