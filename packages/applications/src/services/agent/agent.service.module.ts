import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { CoreDatabaseModule } from '@arcaai/domains';
import { AuthorizationModule } from '../../authorization/authorization.module';
import { CommonServiceModule } from '../baseServices';
import { AgentAssignmentServiceModule } from '../agent-assignment/agent-assignment.service.module';
import { AiProviderConnectionServiceModule } from '../ai-provider-connection/ai-provider-connection.service.module';
import { TextRequestServiceModule } from '../text-request/text-request.service.module';
import { ConsultationContextSchemaServiceModule } from '../consultation-context-schema/consultation-context-schema.service.module';
import { InferenceReadinessServiceModule } from '../ai-readiness/inference-readiness.service.module';
import { EntitlementsServiceModule } from '../entitlements/entitlements.service.module';
import { UsageLedgerServiceModule } from '../usageLedger/usage-ledger.service.module';
import { ContextUserIdentityServiceModule } from '../user/identity';
import { AgentDraftTestService } from './agent-draft-test.service';
import { AgentInvocationService } from './agent-invocation.service';
import { AgentResolverService } from './agent-resolver.service';
import { AgentService } from './agent.service';
import { TextAgentResolverService } from './text-agent-resolver.service';
import { IAgentService } from './IAgentService';

/**
 * Agent DI module (TASK-863): authoring (`AgentService`), the one resolution
 * (`AgentResolverService`) and execution preparation (`AgentInvocationService`).
 * TASK-884 added clone / export / import / sync to `AgentService`.
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    ConfigModule,
    HttpModule,
    AgentAssignmentServiceModule,
    AiProviderConnectionServiceModule,
    // TASK-884 — `PolicyEngine`, which is what lets `syncToTenants` answer "does this caller
    // hold manage:Agent in that OTHER tenant?" from the service. The module is @Global, but it
    // is named here for the same reason `AgentPromotionServiceModule` names it: the dependency
    // is load-bearing, and an implicit global is not a record of that.
    AuthorizationModule,
    TextRequestServiceModule,
    // TASK-890 L8. Named rather than left to an @Optional() absence, because each one has a
    // behavioural consequence when it is missing and "the publish gate quietly stopped checking
    // the context pin" is not a state anyone would notice:
    //   · context schemas — the agent's pin resolves and its payload schema is frozen (§3.4)
    //   · readiness       — the advisory MODEL_NOT_READY warning (§3.12)
    //   · entitlements    — the `monthlyLlmTokens` precheck a non-dry draft test makes (OD-E)
    //   · usage ledger    — the `generate.stream` / `AGENT_TEST` record (§3.13)
    ConsultationContextSchemaServiceModule,
    InferenceReadinessServiceModule,
    EntitlementsServiceModule,
    UsageLedgerServiceModule,
    // TASK-950 (D-5/D-6) — `IContextUserIdentityService`, which `AgentInvocationService`
    // uses to turn a schema-declared staff identifier into a tenant user on a MACHINE
    // invocation. Named here for the same reason the four above are: the injection is
    // `@Optional()` so a minimal fixture still constructs, and an unnamed module would
    // mean a published agent with an identity marker quietly answering 503 in production.
    ContextUserIdentityServiceModule,
  ],
  providers: [
    AgentService,
    // TASK-890 §3.8 — the draft-test TRANSPORT (TEXT client, quota precheck, ledger record).
    // `AgentService` decides what to run; this runs it.
    AgentDraftTestService,
    AgentResolverService,
    TextAgentResolverService,
    AgentInvocationService,
    { provide: IAgentService, useExisting: AgentService },
  ],
  exports: [IAgentService, AgentService, AgentDraftTestService, AgentResolverService, TextAgentResolverService, AgentInvocationService],
})
export class AgentServiceModule {}
