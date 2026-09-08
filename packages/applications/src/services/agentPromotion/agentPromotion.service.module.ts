import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { AgentPromoteToSystemService } from './agent-promote-to-system.service';
import { AgentPromotionService } from './agentPromotion.service';
import { IAgentPromoteToSystemService } from './IAgentPromoteToSystemService';
import { IAgentPromotionService } from './IAgentPromotionService';
import { CommonServiceModule } from '../baseServices';
import { EvalServiceModule } from '../eval/eval.service.module';
import { AuthorizationModule } from '../../authorization/authorization.module';

/**
 * Agent promotion between tenants.
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
 *
 * TASK-930 §6.1 — `AgentPromoteToSystemService` lives here rather than in a module of its own
 * because it shares this module's whole world: the WORM `AgentPromotion` table, the elevated
 * tenant-less posture, and `runInTenantContext`. It deliberately does NOT import the agent or
 * context-schema service modules — it resolves both from the container at call time
 * (`ModuleRef`, `strict: false`), which is what keeps the module graph acyclic; importing
 * `AgentServiceModule` here closes a cycle that stops the gateway booting.
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
    AgentPromoteToSystemService,
    { provide: IAgentPromoteToSystemService, useExisting: AgentPromoteToSystemService },
  ],
  exports: [IAgentPromotionService, AgentPromotionService, IAgentPromoteToSystemService, AgentPromoteToSystemService],
})
export class AgentPromotionServiceModule {}
