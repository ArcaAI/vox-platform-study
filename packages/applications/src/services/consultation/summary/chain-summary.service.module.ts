import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { ChainSummaryService } from './chain-summary.service';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { PromptResolutionServiceModule } from '../prompt/prompt-resolution.service.module';
import { PromptAssemblyService } from '../prompt/prompt-assembly.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, ConfigModule, HttpModule, PromptResolutionServiceModule],
  providers: [PromptAssemblyService, ChainSummaryService],
  exports: [ChainSummaryService],
})
export class ChainSummaryServiceModule {}
