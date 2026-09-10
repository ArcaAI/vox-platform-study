import { describe, expect, it } from 'vitest';
// MUST be first. `services/index.ts` participates in a PRE-EXISTING import
// cycle (`interfaces/IClsContext` -> `services` barrel -> ... -> the
// consultation modules), so requiring a deep module file as the FIRST module
// leaves some `imports` entries `undefined` at decoration time — an artifact of
// evaluation order, not of the wiring. `AiRoutingPolicyServiceModule` is already
// `undefined` in `SummaryServiceModule` under that order, on unmodified `dev-2.2`.
//
// The real application never loads a deep file first: `apps/api` imports the
// package barrel (`@arcaai/applications`), under which every entry resolves.
// Importing the barrel here reproduces the production evaluation order, so this
// suite asserts what NestJS actually sees at boot. Verified against the compiled
// CJS output both ways: barrel-first ⇒ 0 undefined; deep-file-first ⇒ 2.
import '../../../index';
import { JobQueue } from '@arcaai/domains';
import { GateEditMiningServiceModule } from '../gate-edit-mining.service.module';
import { GateEditMiningProcessor, GateEditMiningQueue } from '../gate-edit-mining.processor';
import { IGateEditMiningQueue } from '../IGateEditMiningQueue';
import { IGateEditExemplarRetriever } from '../IGateEditExemplarRetriever';
import { SummaryService } from '../../consultation/summary/summary.service';
import { SummaryServiceModule } from '../../consultation/summary/summary.service.module';
import { ChainSummaryServiceModule } from '../../consultation/summary/chain-summary.service.module';
import { ConsultationJobServiceModule } from '../../consultation/jobs/consultation-job.service.module';
import { HarnessInternalServiceModule } from '../../consultation/harness/harness-internal.service.module';

/**
 * DI wiring guard for the gate-edit learning loop ( + W2).
 *
 * The same class of defect as `usage-ledger.di-wiring.task615.test.ts`, in two
 * places at once — and for the same reason: every existing unit test constructs
 * these services POSITIONALLY with a hand-built mock, so the suite stayed green
 * while the real NestJS container resolved `undefined` on both halves.
 *
 *  * WRITE half — `GateEditMiningQueue`/`GateEditMiningProcessor` were declared
 *    but registered in NO module. `GateEditMiningQueue` was the only `@Processor`
 *    class in `packages/applications` in that state; all eight siblings are
 *    registered in their own service module.
 *  * READ half — `PromptAssemblyService` injects `IGateEditExemplarRetriever`
 *    with `@Optional()`, but none of the four modules that PROVIDE
 *    `PromptAssemblyService` for live generation imported the module that
 *    exports that token. So even with rows present, generation saw `undefined`
 * and silently degraded to zero-shot. closed two of the four;
 * closed the remaining two (the async job path and the harness
 *    path), so all four now resolve the token.
 *
 * These assertions check the tokens NestJS actually resolves — no container, no
 * database, no Redis.
 */

/** NestJS metadata keys (mirrors `@nestjs/common` internals). */
const SELF_DECLARED_DEPS_METADATA = 'self:paramtypes';
const PARAMTYPES_METADATA = 'design:paramtypes';
const MODULE_PROVIDERS_METADATA = 'providers';
const MODULE_EXPORTS_METADATA = 'exports';
const MODULE_IMPORTS_METADATA = 'imports';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function effectiveConstructorTokens(target: any): unknown[] {
  const tokens: unknown[] = [...((Reflect.getMetadata(PARAMTYPES_METADATA, target) as unknown[]) ?? [])];
  const selfDeclared = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, target) as { index: number; param: unknown }[]) ?? [];
  for (const { index, param } of selfDeclared) {
    tokens[index] = param;
  }
  return tokens;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function moduleMetadata(target: any, key: string): unknown[] {
  return (Reflect.getMetadata(key, target) as unknown[]) ?? [];
}

/**
 * `BullModule.registerQueue(...)` returns a DynamicModule, so it is matched
 * structurally by the queue name it registers rather than by class identity.
 */
function registersBullQueue(moduleClass: unknown, queueName: string): boolean {
  return moduleMetadata(moduleClass, MODULE_IMPORTS_METADATA).some((imported) => {
    const providers = (imported as { providers?: { provide?: unknown }[] })?.providers ?? [];
    return providers.some((p) => typeof p?.provide === 'string' && p.provide.includes(queueName));
  });
}

describe('Gate-edit learning loop — NestJS DI wiring', () => {
  describe('W1 — the WRITE half is registered', () => {
    it('GateEditMiningServiceModule provides the processor', () => {
      expect(moduleMetadata(GateEditMiningServiceModule, MODULE_PROVIDERS_METADATA)).toContain(GateEditMiningProcessor);
    });

    it('GateEditMiningServiceModule provides the queue under the IGateEditMiningQueue token', () => {
      const providers = moduleMetadata(GateEditMiningServiceModule, MODULE_PROVIDERS_METADATA);
      expect(providers).toContain(GateEditMiningQueue);
      expect(providers.some((p) => (p as { provide?: unknown })?.provide === IGateEditMiningQueue)).toBe(true);
    });

    it('GateEditMiningServiceModule registers the MineGateEditExemplar BullMQ queue', () => {
      // Without this the @InjectQueue in GateEditMiningQueue cannot resolve and
      // the module fails to instantiate.
      expect(registersBullQueue(GateEditMiningServiceModule, JobQueue.MineGateEditExemplar)).toBe(true);
    });

    it('GateEditMiningServiceModule exports the enqueue token so the sign-off path can inject it', () => {
      expect(moduleMetadata(GateEditMiningServiceModule, MODULE_EXPORTS_METADATA)).toContain(IGateEditMiningQueue);
    });

    it('SummaryService injects IGateEditMiningQueue', () => {
      expect(effectiveConstructorTokens(SummaryService)).toContain(IGateEditMiningQueue);
    });

    it('SummaryServiceModule imports GateEditMiningServiceModule, so the token resolves', () => {
      expect(moduleMetadata(SummaryServiceModule, MODULE_IMPORTS_METADATA)).toContain(GateEditMiningServiceModule);
    });
  });

  describe('W2 — the READ half reaches live generation', () => {
    it('GateEditMiningServiceModule exports the retriever token', () => {
      expect(moduleMetadata(GateEditMiningServiceModule, MODULE_EXPORTS_METADATA)).toContain(IGateEditExemplarRetriever);
    });

    /**
     * ALL FOUR modules that provide `PromptAssemblyService` for live generation.
     *
     * wired the first two and could not reach the other two (they sat
     * outside its ownership boundary), so it pinned their absence as a FAILING-
     * on-close assertion rather than a skip. owns
     * `consultation/**` and applied both imports; this list is the closed form
     * of that pin.
     *
     * A FIFTH provider is not this list's problem: `prompt-assembly.retriever-
     * reachability.test.ts` DISCOVERS every provider from the
     * filesystem and computes token reachability, so a new one is covered the
     * moment it exists. This list stays as the named, readable statement of
     * which four they are today.
 */
    it.each([
      ['SummaryServiceModule', SummaryServiceModule],
      ['ChainSummaryServiceModule', ChainSummaryServiceModule],
      ['ConsultationJobServiceModule', ConsultationJobServiceModule],
      ['HarnessInternalServiceModule', HarnessInternalServiceModule],
    ])('%s imports GateEditMiningServiceModule', (_name, moduleClass) => {
      expect(moduleMetadata(moduleClass, MODULE_IMPORTS_METADATA)).toContain(GateEditMiningServiceModule);
    });
  });
});
