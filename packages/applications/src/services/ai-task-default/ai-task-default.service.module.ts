import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { IAiTaskDefaultService } from './IAiTaskDefaultService';
import { AiTaskDefaultService } from './ai-task-default.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: IAiTaskDefaultService,
      useClass: AiTaskDefaultService,
    },
    AiTaskDefaultService,
  ],
  exports: [IAiTaskDefaultService, AiTaskDefaultService],
})
export class AiTaskDefaultServiceModule {}
