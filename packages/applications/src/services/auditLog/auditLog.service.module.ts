import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CommonServiceModule } from '../baseServices';
import { IAuditLogService } from './IAuditLogService';
import { AuditLogProcessor } from './auditLog.processor';
import { AuditLogService } from './auditLog.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, BullModule.registerQueue({ name: JobQueue.AuditLog })],
  providers: [
    {
      provide: IAuditLogService,
      useClass: AuditLogService,
    },
    AuditLogProcessor,
  ],
  exports: [IAuditLogService],
})
export class AuditLogServiceModule {}
