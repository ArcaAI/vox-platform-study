import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { GateEditMiningService } from './gate-edit-mining.service';
import { IGateEditExemplarRetriever } from './IGateEditExemplarRetriever';

/**
 * GateEditMiningService DI module (TASK-533 B6, GAP-A1).
 *
 * Note what is NOT provided here: `IPhiRedactor`. The redactor is supplied by
 * the host that owns the guardrail client, and its absence is FAIL-CLOSED by
 * design — `GateEditMiningService` mines nothing without one, so a deployment
 * that forgets to wire it collects an empty store rather than an unredacted one.
 *
 * `IGateEditExemplarRetriever` is aliased onto the SAME instance so prompt
 * assembly can consume the READ half through a narrow port without importing
 * the mining implementation (§3.4 consumption (b)).
 */
@Module({
  imports: [CoreDatabaseModule],
  providers: [GateEditMiningService, { provide: IGateEditExemplarRetriever, useExisting: GateEditMiningService }],
  exports: [GateEditMiningService, IGateEditExemplarRetriever],
})
export class GateEditMiningServiceModule {}
