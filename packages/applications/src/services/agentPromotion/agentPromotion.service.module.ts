import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { AgentPromotionService } from './agentPromotion.service';
import { IAgentPromotionService } from './IAgentPromotionService';
import { CommonServiceModule } from '../baseServices';
import { EvalServiceModule } from '../eval/eval.service.module';
import { AuthorizationModule } from '../../authorization/authorization.module';

/**
 * TASK-663 — agent promotion between tenants.
 *
 * `AuthorizationModule` is imported for `PolicyEngine`, which is what makes
 * "the actor holds manage rights on BOTH tenants" answerable from a service
 * rather than only from a route decorator: a decorator can express
 * `action + subject`, but not "…and also in that OTHER tenant". The
 * `permission-check.controller.ts` / `role.service.ts` callers are the
 * precedent for using it outside a guard.
 *
 * `EvalServiceModule` supplies `EvalRunService` so the eval can re-run at the
 * TARGET tenant against the target's own corpus.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, EventEmitterModule, ClsModule, EvalServiceModule, AuthorizationModule],
  providers: [
    AgentPromotionService,
    {
      provide: IAgentPromotionService,
      // useExisting, not useClass — aliases the instance above rather than
      // constructing a second one (the DepartmentAgentServiceModule precedent).
      useExisting: AgentPromotionService,
    },
  ],
  exports: [IAgentPromotionService, AgentPromotionService],
})
export class AgentPromotionServiceModule {}
