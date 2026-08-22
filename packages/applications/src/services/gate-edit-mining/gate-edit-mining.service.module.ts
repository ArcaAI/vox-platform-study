import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { PhiRedactionServiceModule } from '../phi-redaction/phi-redaction.service.module';
import { GateEditMiningService } from './gate-edit-mining.service';
import { GateEditMiningProcessor, GateEditMiningQueue } from './gate-edit-mining.processor';
import { IGateEditExemplarRetriever } from './IGateEditExemplarRetriever';
import { IGateEditMiningQueue } from './IGateEditMiningQueue';

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
 *
 * TASK-792 W1 — the WRITE half is registered here for the first time.
 * `GateEditMiningQueue` and `GateEditMiningProcessor` were declared in
 * `gate-edit-mining.processor.ts` but appeared in NO module's `providers`,
 * making `GateEditMiningQueue` the only unregistered `@Processor` class in this
 * package (all eight siblings are registered in their own service module). The
 * consequence was not a boot failure but silence: `enqueue()` had zero call
 * sites, no worker consumed the queue, and `GateEditExemplar` had no live
 * writer at all. Registering the pair — and the BullMQ queue the `@InjectQueue`
 * resolves against — is what makes the mined corpus exist.
 */
@Module({
  // EffectiveSettingsModule resolves the @Optional EffectiveSettingsService that
  // governs `agentic.fewshot.curationMode` (F-24). Unwired ⇒ the gate stays off.
  imports: [
    CoreDatabaseModule,
    EffectiveSettingsModule,
    PhiRedactionServiceModule,
    // Backs the `@InjectQueue(JobQueue.MineGateEditExemplar)` in
    // `GateEditMiningQueue`. Without this registration the provider cannot be
    // constructed and the module fails to initialise — loudly, which is the
    // right failure mode for a half-wired learning loop.
    BullModule.registerQueue({ name: JobQueue.MineGateEditExemplar }),
  ],
  providers: [
    GateEditMiningService,
    { provide: IGateEditExemplarRetriever, useExisting: GateEditMiningService },
    GateEditMiningQueue,
    // Exported under the PORT token so the sign-off path injects an interface,
    // never BullMQ. `useExisting` (not `useClass`) so the processor and the
    // enqueue side share one instance.
    { provide: IGateEditMiningQueue, useExisting: GateEditMiningQueue },
    GateEditMiningProcessor,
  ],
  exports: [GateEditMiningService, IGateEditExemplarRetriever, IGateEditMiningQueue],
})
export class GateEditMiningServiceModule {}
