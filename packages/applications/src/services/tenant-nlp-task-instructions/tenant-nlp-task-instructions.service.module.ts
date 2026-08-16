import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ITenantNlpTaskInstructionsService } from './ITenantNlpTaskInstructionsService';
import { TenantNlpTaskInstructionsService } from './tenant-nlp-task-instructions.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    TenantNlpTaskInstructionsService,
    {
      provide: ITenantNlpTaskInstructionsService,
      useExisting: TenantNlpTaskInstructionsService,
    },
  ],
  exports: [ITenantNlpTaskInstructionsService, TenantNlpTaskInstructionsService],
})
export class TenantNlpTaskInstructionsServiceModule {}
