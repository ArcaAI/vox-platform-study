import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { HarnessAuditService } from './harness-audit.service';

/**
 * HarnessAuditService DI module (TASK-330 Phase 0). Imports CoreDatabaseModule
 * for the append-only HarnessAuditEvent repository.
 */
@Module({
  imports: [CoreDatabaseModule],
  providers: [HarnessAuditService],
  exports: [HarnessAuditService],
})
export class HarnessAuditServiceModule {}
