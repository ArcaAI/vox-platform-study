import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { GateEditMiningService } from './gate-edit-mining.service';
import { IGateEditExemplarRetriever } from './IGateEditExemplarRetriever';

/**
 * GateEditMiningService DI module.
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
  // EffectiveSettingsModule resolves the @Optional EffectiveSettingsService that
  // governs `agentic.fewshot.curationMode` (F-24). Unwired ⇒ the gate stays off.
  imports: [CoreDatabaseModule, EffectiveSettingsModule],
  providers: [GateEditMiningService, { provide: IGateEditExemplarRetriever, useExisting: GateEditMiningService }],
  exports: [GateEditMiningService, IGateEditExemplarRetriever],
})
export class GateEditMiningServiceModule {}
