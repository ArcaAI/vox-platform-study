import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { SummaryService } from './summary.service';
import { ISummaryService } from './ISummaryService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { PromptResolutionServiceModule } from '../prompt/prompt-resolution.service.module';
import { PromptAssemblyService } from '../prompt/prompt-assembly.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, ConfigModule, HttpModule, PromptResolutionServiceModule],
  providers: [
    {
      provide: ISummaryService,
      useClass: SummaryService,
    },
    PromptAssemblyService,
    SummaryService,
  ],
  exports: [ISummaryService, SummaryService],
})
export class SummaryServiceModule {}
