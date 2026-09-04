import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { AgentAssignmentServiceModule } from '../agent-assignment/agent-assignment.service.module';
import { AiProviderConnectionServiceModule } from '../ai-provider-connection/ai-provider-connection.service.module';
import { TextRequestServiceModule } from '../text-request/text-request.service.module';
import { AgentInvocationService } from './agent-invocation.service';
import { AgentResolverService } from './agent-resolver.service';
import { AgentService } from './agent.service';
import { IAgentService } from './IAgentService';

/**
 * Agent DI module (TASK-863): authoring (`AgentService`), the one resolution
 * (`AgentResolverService`) and execution preparation (`AgentInvocationService`).
 */
@Module({
  imports: [
    CommonServiceModule,
    CoreDatabaseModule,
    ConfigModule,
    HttpModule,
    AgentAssignmentServiceModule,
    AiProviderConnectionServiceModule,
    TextRequestServiceModule,
  ],
  providers: [AgentService, AgentResolverService, AgentInvocationService, { provide: IAgentService, useExisting: AgentService }],
  exports: [IAgentService, AgentService, AgentResolverService, AgentInvocationService],
})
export class AgentServiceModule {}
