import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { CoreDatabaseModule } from '@arcaai/domains';
import { AuthorizationModule } from '../../authorization/authorization.module';
import { CommonServiceModule } from '../baseServices';
import { AgentAssignmentServiceModule } from '../agent-assignment/agent-assignment.service.module';
import { AiProviderConnectionServiceModule } from '../ai-provider-connection/ai-provider-connection.service.module';
import { TextRequestServiceModule } from '../text-request/text-request.service.module';
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
  ],
  providers: [
    AgentService,
    AgentResolverService,
    TextAgentResolverService,
    AgentInvocationService,
    { provide: IAgentService, useExisting: AgentService },
  ],
  exports: [IAgentService, AgentService, AgentResolverService, TextAgentResolverService, AgentInvocationService],
})
export class AgentServiceModule {}
