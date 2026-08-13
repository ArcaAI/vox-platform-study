import { describe, expect, it } from 'vitest';
import { CoreDatabaseModule, CoreUnitOfWorkService } from '@arcaai/domains';
import { CoreUnitOfWorkService as UnwiredCoreUnitOfWorkService } from '../../../baseServices/unitsOfWork/core/core.unitOfWork';
import { SummaryService } from '../summary.service';
import { SummaryServiceModule } from '../summary.service.module';
import { ChainSummaryService } from '../chain-summary.service';
import { ChainSummaryServiceModule } from '../chain-summary.service.module';

/**
 * DI wiring guard for the metered SummaryMeta path.
 *
 * WS-D shipped `persistSummaryMetaWithUsage` on both summary services, whose
 * transactional (metered) branch is taken only when the injected
 * `unitOfWork` is defined. Both services injected the IDENTICALLY NAMED but
 * UNWIRED `CoreUnitOfWorkService` under `services/baseServices/unitsOfWork/`,
 * which appears in no NestJS `providers: []` array anywhere in the repo. Under
 * `@Optional()` that resolves to `undefined` in the real app, so every
 * generation silently took the unmetered fallback branch — while the unit
 * tests stayed green, because they construct the service positionally with a
 * mock and never exercise NestJS DI at all.
 *
 * These assertions close exactly that gap: they check the tokens NestJS will
 * actually resolve (`design:paramtypes` + the `@Inject`-declared overrides)
 * against the providers `CoreDatabaseModule` really exports — no database or
 * running Nest container required.
 *
 * NOTE — why both services keep an EXPLICIT `@Inject(CoreUnitOfWorkService)`
 * instead of the bare `@Optional()` form `SttInternalService` uses: the bare
 * form leans on `emitDecoratorMetadata`, which only `tsc` emits. Vitest
 * transforms with esbuild, so `design:paramtypes` is empty here and a bare
 * parameter would be invisible to this guard. The explicit token is recorded
 * at runtime by the decorator itself, so it is assertable under both.
 */

/** NestJS metadata keys (mirrors `@nestjs/common` internals). */
const SELF_DECLARED_DEPS_METADATA = 'self:paramtypes';
const PARAMTYPES_METADATA = 'design:paramtypes';
const MODULE_PROVIDERS_METADATA = 'providers';
const MODULE_EXPORTS_METADATA = 'exports';
const MODULE_IMPORTS_METADATA = 'imports';

/**
 * The tokens NestJS resolves for a provider's constructor: the reflected
 * parameter types, with any explicit `@Inject(token)` taking precedence at
 * its own index.
 */
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

describe('Usage metering — NestJS DI wiring', () => {
  it('CoreDatabaseModule provides AND exports the domains CoreUnitOfWorkService', () => {
    expect(moduleMetadata(CoreDatabaseModule, MODULE_PROVIDERS_METADATA)).toContain(CoreUnitOfWorkService);
    expect(moduleMetadata(CoreDatabaseModule, MODULE_EXPORTS_METADATA)).toContain(CoreUnitOfWorkService);
  });

  it('the applications-local CoreUnitOfWorkService is a DIFFERENT class from the domains one', () => {
    // Guards the premise of every assertion below: if these ever became the
    // same class the mismatch would be impossible and this suite meaningless.
    expect(UnwiredCoreUnitOfWorkService).not.toBe(CoreUnitOfWorkService);
  });

  describe.each([
    ['SummaryService', SummaryService, SummaryServiceModule],
    ['ChainSummaryService', ChainSummaryService, ChainSummaryServiceModule],
  ])('%s', (_name, service, serviceModule) => {
    it('injects the DOMAINS CoreUnitOfWorkService — the one CoreDatabaseModule exports', () => {
      expect(effectiveConstructorTokens(service)).toContain(CoreUnitOfWorkService);
    });

    it('never injects the unwired applications-local CoreUnitOfWorkService', () => {
      // This is the defect: @Optional() against an unprovided token resolves
      // to undefined, silently disabling the metered transactional branch.
      expect(effectiveConstructorTokens(service)).not.toContain(UnwiredCoreUnitOfWorkService);
    });

    it('is declared in a module that imports CoreDatabaseModule, so the token resolves', () => {
      expect(moduleMetadata(serviceModule, MODULE_IMPORTS_METADATA)).toContain(CoreDatabaseModule);
    });
  });
});
