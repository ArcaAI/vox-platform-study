import { Module } from '@nestjs/common';
import { IAuditLogService } from './IAuditLogService';
import { AuditLogService } from './auditLog.service';
import { CommonServiceModule } from '../baseServices';
import { CoreDatabaseModule } from '@arcaai/domains';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: IAuditLogService,
      useClass: AuditLogService,
    },
  ],
  exports: [IAuditLogService],
})
export class AuditLogServiceModule {}
