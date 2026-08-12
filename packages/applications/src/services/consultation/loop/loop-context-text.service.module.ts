import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { LoopContextTextService } from './loop-context-text.service';
import { ILoopContextTextService } from './ILoopContextTextService';

/**
 * LoopContextTextService DI module — TASK-664.
 *
 * Domain-repository-only wiring, mirroring `LoopConfigServiceModule`:
 * `CoreDatabaseModule` already registers `ContextItemRepository`.
 */
@Module({
  imports: [CoreDatabaseModule, EventEmitterModule, ClsModule],
  providers: [
    LoopContextTextService,
    {
      provide: ILoopContextTextService,
      useExisting: LoopContextTextService,
    },
  ],
  exports: [ILoopContextTextService, LoopContextTextService],
})
export class LoopContextTextServiceModule {}
