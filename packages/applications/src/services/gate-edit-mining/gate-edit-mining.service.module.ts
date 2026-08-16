import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { PhiRedactionServiceModule } from '../phi-redaction/phi-redaction.service.module';
import { GateEditMiningService } from './gate-edit-mining.service';
import { IGateEditExemplarRetriever } from './IGateEditExemplarRetriever';

/**
 * GateEditMiningService DI module.
 *
 * `IPhiRedactor` is now wired (TASK-710) via `PhiRedactionServiceModule`
 * (`GuardrailPhiRedactor`, an HTTP client over `POST /api/guardrail/redact`).
 * `GateEditMiningService`'s own fail-closed design is UNCHANGED — it still
 * mines nothing if `@Optional() phiRedactor` is ever absent (e.g. a deployment
 * that forgets to import this module, or a future host wiring a different
 * implementation) — this module import is what turns that dormant contract
 * into "mines redacted exemplars" for the first time.
 *
 * `IGateEditExemplarRetriever` is aliased onto the SAME instance so prompt
 * assembly can consume the READ half through a narrow port without importing
 * the mining implementation (consumption (b)).
 */
@Module({
  // EffectiveSettingsModule resolves the @Optional EffectiveSettingsService that
  // governs `agentic.fewshot.curationMode` (F-24). Unwired ⇒ the gate stays off.
  imports: [CoreDatabaseModule, EffectiveSettingsModule, PhiRedactionServiceModule],
  providers: [GateEditMiningService, { provide: IGateEditExemplarRetriever, useExisting: GateEditMiningService }],
  exports: [GateEditMiningService, IGateEditExemplarRetriever],
})
export class GateEditMiningServiceModule {}
