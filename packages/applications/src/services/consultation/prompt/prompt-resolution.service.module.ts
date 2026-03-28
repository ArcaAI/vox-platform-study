import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { PromptResolutionService } from './prompt-resolution.service';

@Module({
  imports: [CoreDatabaseModule],
  providers: [PromptResolutionService],
  exports: [PromptResolutionService],
})
export class PromptResolutionServiceModule {}
