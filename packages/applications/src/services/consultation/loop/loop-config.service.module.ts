import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { LoopConfigService } from './loop-config.service';
import { ILoopConfigService } from './ILoopConfigService';

/**
 * LoopConfigService DI module — TASK-662.
 *
 * Domain-repository-only wiring (no HTTP, no Redis): `CoreDatabaseModule`
 * supplies `ConsultationRepository`, `DepartmentAgentRepository`,
 * `DepartmentAgentVersionRepository`, `ConsultationContextSchemaRepository`
 * and `ConsultationContextSchemaVersionRepository`, all already registered
 * there.
 */
@Module({
  imports: [CoreDatabaseModule, EventEmitterModule, ClsModule],
  providers: [
    LoopConfigService,
    {
      provide: ILoopConfigService,
      useExisting: LoopConfigService,
    },
  ],
  exports: [ILoopConfigService, LoopConfigService],
})
export class LoopConfigServiceModule {}
