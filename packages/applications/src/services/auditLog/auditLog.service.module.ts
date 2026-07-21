import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CommonServiceModule } from '../baseServices';
import { CryptoServiceModule } from '../crypto/crypto.service.module';
import { IAuditLogService } from './IAuditLogService';
import { AuditLogProcessor } from './auditLog.processor';
import { AuditLogService } from './auditLog.service';
import { AuditLogEncryptionService } from './auditLog-encryption.service';

@Module({
  // CryptoServiceModule supplies ICryptoService for the envelope
  // encryption; SecretsService is @Global() (SecretsModule.forRoot in AppModule).
  imports: [CommonServiceModule, CoreDatabaseModule, CryptoServiceModule, BullModule.registerQueue({ name: JobQueue.AuditLog })],
  providers: [
    {
      provide: IAuditLogService,
      useClass: AuditLogService,
    },
    AuditLogEncryptionService,
    AuditLogProcessor,
  ],
  exports: [IAuditLogService, AuditLogEncryptionService],
})
export class AuditLogServiceModule {}
