/**
 * TASK-795 W1 — the exclusivity gate must not be able to go SILENTLY INERT.
 *
 * `LoopContextSignalService` injects `ConsultationRepository` with `@Optional()`,
 * matching this file's existing convention and its declared fail-safe direction
 * (unresolvable ⇒ Substrate A runs). That convenience is exactly the shape of
 * defect R7 shipped: `PromptAssemblyService` injected
 * `IGateEditExemplarRetriever` `@Optional()`, two of the four providing modules
 * never imported the module that exports it, and generation silently degraded for
 * months with every unit test green.
 *
 * So the wiring is asserted STRUCTURALLY here, not left to a reviewer noticing.
 * These assertions read the metadata NestJS itself resolves — no container, no
 * database, no Redis.
 */
import { describe, expect, it } from 'vitest';
// Barrel first — `services/index.ts` participates in a pre-existing import cycle,
// so a deep file loaded first leaves some `imports` entries `undefined` at
// decoration time. The real app loads the barrel; so does this suite.
import '../../../../index';
import { CoreDatabaseModule, ConsultationRepository } from '@arcaai/domains';
import { LoopContextSignalService } from '../loop-context-signal.service';
import { LiveDocumentationServiceModule } from '../../live-documentation/live-documentation.service.module';
import { ConsultationWorkflowDispatchService } from '../../workflow-dispatch/consultation-workflow-dispatch.service';
import { ConsultationWorkflowDispatchServiceModule } from '../../workflow-dispatch/consultation-workflow-dispatch.service.module';

const SELF_DECLARED_DEPS_METADATA = 'self:paramtypes';
const PARAMTYPES_METADATA = 'design:paramtypes';
const MODULE_IMPORTS_METADATA = 'imports';
const MODULE_PROVIDERS_METADATA = 'providers';

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

describe('Substrate exclusivity — NestJS DI wiring', () => {
  describe('read half', () => {
    it('LoopContextSignalService injects ConsultationRepository', () => {
      expect(effectiveConstructorTokens(LoopContextSignalService)).toContain(ConsultationRepository);
    });

    it('LiveDocumentationServiceModule provides LoopContextSignalService', () => {
      expect(moduleMetadata(LiveDocumentationServiceModule, MODULE_PROVIDERS_METADATA)).toContain(LoopContextSignalService);
    });

    it('LiveDocumentationServiceModule imports CoreDatabaseModule, so the repository resolves', () => {
      // Without this the `@Optional()` dep is `undefined`, the gate never fires,
      // and BOTH substrates write the document — with no error anywhere.
      expect(moduleMetadata(LiveDocumentationServiceModule, MODULE_IMPORTS_METADATA)).toContain(CoreDatabaseModule);
    });
  });

  describe('write half', () => {
    it('ConsultationWorkflowDispatchService injects ConsultationRepository', () => {
      expect(effectiveConstructorTokens(ConsultationWorkflowDispatchService)).toContain(ConsultationRepository);
    });

    it('ConsultationWorkflowDispatchServiceModule imports CoreDatabaseModule', () => {
      expect(moduleMetadata(ConsultationWorkflowDispatchServiceModule, MODULE_IMPORTS_METADATA)).toContain(CoreDatabaseModule);
    });
  });
});
