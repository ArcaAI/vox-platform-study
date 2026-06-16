import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { ChainSummaryService } from './chain-summary.service';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { PromptResolutionServiceModule } from '../prompt/prompt-resolution.service.module';
import { PromptAssemblyService } from '../prompt/prompt-assembly.service';
import { HarnessPolicyServiceModule } from '../../harness-policy/harness-policy.service.module';
import { ConfigResolverModule } from '../../config-resolver';

@Module({
  // TASK-356 D-7 — HarnessPolicyServiceModule supplies the SMR-selection resolver.
  // TASK-362 — ConfigResolverModule supplies the preferred-prompt resolver.
  imports: [CommonServiceModule, CoreDatabaseModule, ConfigModule, HttpModule, PromptResolutionServiceModule, HarnessPolicyServiceModule, ConfigResolverModule],
  providers: [PromptAssemblyService, ChainSummaryService],
  exports: [ChainSummaryService],
})
export class ChainSummaryServiceModule {}
