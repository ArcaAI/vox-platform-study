/**
 * Boot-time OCC-coverage audit (REST review finding H-1).
 *
 * Pins the detection rule (E1 response-DTO `version`, E2 `@ExpectedVersion()`
 * parameter), the WARN-ONLY contract (this audit must never refuse boot), and
 * the two exception mechanisms (`@NoOptimisticConcurrency()` and the
 * `SANCTIONED_EXCEPTIONS` allow-list).
 */
import { describe, it, expect, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { Body, Controller, Module, Patch, Put } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { ApiProperty, ApiResponse } from '@nestjs/swagger';
import { UnifiedAuthGuard } from '@arcaai/applications';
import { auditOptimisticConcurrencyCoverage, SANCTIONED_EXCEPTIONS } from '../occ-coverage-audit';
import { ExpectedVersion, NoOptimisticConcurrency, RequiresIfMatch } from '../../decorators';
// The REAL controllers that owned the seven tier-A routes, plus the two
// create-or-update exceptions. Imported as VALUES on purpose: this file is the
// regression gate for the H-1 migration, and only the shipped decorators can
// prove it.
import { ConsultationController } from '../../modules/consultation/consultation.controller';
import { DnaWritingStyleController } from '../../modules/dna-writing-style/dna-writing-style.controller';
import { EntitlementsAdminController } from '../../modules/entitlements/entitlements-admin.controller';
import { TenantController } from '../../modules/tenant/tenant.controller';
import { TenantIdpConfigAdminController } from '../../modules/tenant-idp-config/tenant-idp-config-admin.controller';
import { SettingsRegistryWriteController } from '../../modules/settings-catalog/settings-registry-write.controller';
import { TenantFrontendConfigAdminController } from '../../modules/tenant-frontend-config/tenant-frontend-config-admin.controller';

/**
 * Metadata-only application context over REAL controller classes.
 *
 * `Test.createTestingModule` cannot be used here: these controllers inject
 * service tokens, `ClsService` and guards, so compiling them would drag the
 * whole DI graph (Prisma, Redis, Vault) into a unit test. The audit only ever
 * touches `ModulesContainer` (for `{ metatype, instance }` pairs) and
 * `Reflector`, and it reads metadata off the PROTOTYPE — so a bare
 * `Object.create(Class.prototype)` is indistinguishable from a constructed
 * instance for everything the audit inspects.
 */
function metadataAppFor(controllers: Array<new (...args: never[]) => unknown>) {
  const wrappers = new Map(controllers.map((Controller_, index) => [index, { metatype: Controller_, instance: Object.create(Controller_.prototype) }]));
  const modulesContainer = new Map([['synthetic', { controllers: wrappers }]]);
  const reflector = new Reflector();
  return {
    get: (token: unknown) => (token === ModulesContainer ? modulesContainer : reflector),
  } as unknown as Parameters<typeof auditOptimisticConcurrencyCoverage>[0];
}

class VersionedResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  version!: number;
}

class PlainResponse {
  @ApiProperty()
  id!: string;
}

async function buildApp(controllers: Array<new (...args: unknown[]) => unknown>) {
  @Module({ controllers })
  class _SyntheticModule {}

  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [_SyntheticModule] })
    .overrideGuard(UnifiedAuthGuard)
    .useValue({ canActivate: () => true })
    .compile();

  return moduleRef as unknown as Parameters<typeof auditOptimisticConcurrencyCoverage>[0];
}

const silentLogger = () => ({ warn: vi.fn(), log: vi.fn() });

describe('boot-time OCC coverage audit', () => {
  it('E1 — reports a PATCH whose response DTO declares `version` and which lacks @RequiresIfMatch', async () => {
    @Controller('widgets')
    class WidgetController {
      @Patch(':id')
      @ApiResponse({ status: 200, type: VersionedResponse })
      update(@Body() body: unknown) {
        return body;
      }
    }

    const report = auditOptimisticConcurrencyCoverage(await buildApp([WidgetController]), silentLogger());

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      controller: 'WidgetController',
      handler: 'update',
      httpMethod: 'PATCH',
      path: '/widgets/:id',
      evidence: ['responseDtoVersion'],
    });
    expect(report.totalMutatingRoutes).toBe(1);
    expect(report.protectedCount).toBe(0);
  });

  it('E2 — reports a PUT that takes @ExpectedVersion() even when the response DTO has no version', async () => {
    @Controller('widgets')
    class WidgetController {
      @Put('settings')
      @ApiResponse({ status: 200, type: PlainResponse })
      setSettings(@Body() body: unknown, @ExpectedVersion() expected?: number) {
        return { body, expected };
      }
    }

    const report = auditOptimisticConcurrencyCoverage(await buildApp([WidgetController]), silentLogger());

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.evidence).toEqual(['expectedVersionParam']);
  });

  it('does not report a route whose resource shows no version evidence (biased to under-report)', async () => {
    @Controller('widgets')
    class WidgetController {
      @Patch(':id')
      @ApiResponse({ status: 200, type: PlainResponse })
      update(@Body() body: unknown) {
        return body;
      }
    }

    const report = auditOptimisticConcurrencyCoverage(await buildApp([WidgetController]), silentLogger());
    expect(report.findings).toEqual([]);
    expect(report.totalMutatingRoutes).toBe(1);
  });

  it('does not report GET/POST/DELETE — the finding is scoped to PATCH/PUT', async () => {
    @Controller('widgets')
    class WidgetController {
      @Patch(':id')
      @ApiResponse({ status: 200, type: VersionedResponse })
      @RequiresIfMatch()
      update(@Body() body: unknown) {
        return body;
      }
    }

    const report = auditOptimisticConcurrencyCoverage(await buildApp([WidgetController]), silentLogger());
    expect(report.findings).toEqual([]);
    expect(report.protectedCount).toBe(1);
  });

  it('@NoOptimisticConcurrency(reason) removes a route from the report and records the reason', async () => {
    @Controller('widgets')
    class WidgetController {
      @Put('config')
      @NoOptimisticConcurrency('create-or-update: a first write has no row to precondition on')
      @ApiResponse({ status: 200, type: VersionedResponse })
      upsert(@Body() body: unknown) {
        return body;
      }
    }

    const report = auditOptimisticConcurrencyCoverage(await buildApp([WidgetController]), silentLogger());
    expect(report.findings).toEqual([]);
    expect(report.sanctioned).toHaveLength(1);
    expect(report.sanctioned[0]).toContain('create-or-update');
  });

  it('flags a route carrying BOTH @RequiresIfMatch and @NoOptimisticConcurrency as a contradiction', async () => {
    @Controller('widgets')
    class WidgetController {
      @Put('config')
      @RequiresIfMatch()
      @NoOptimisticConcurrency('contradictory on purpose')
      @ApiResponse({ status: 200, type: VersionedResponse })
      upsert(@Body() body: unknown) {
        return body;
      }
    }

    const report = auditOptimisticConcurrencyCoverage(await buildApp([WidgetController]), silentLogger());
    expect(report.contradictions).toHaveLength(1);
    expect(report.findings).toEqual([]);
  });

  it('is WARN-ONLY — it logs and returns, and never throws, however many routes are unprotected', async () => {
    @Controller('widgets')
    class WidgetController {
      @Patch(':id')
      @ApiResponse({ status: 200, type: VersionedResponse })
      update(@Body() body: unknown) {
        return body;
      }

      @Put('other')
      @ApiResponse({ status: 200, type: VersionedResponse })
      other(@Body() body: unknown) {
        return body;
      }
    }

    const logger = silentLogger();
    const app = await buildApp([WidgetController]);
    expect(() => auditOptimisticConcurrencyCoverage(app, logger)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toContain('OCC is applied per-ROUTE, not per-RESOURCE');
  });

  it('sees a class-level @RequiresIfMatch — Nest does not copy class metadata onto handlers', async () => {
    @Controller('widgets')
    @(RequiresIfMatch() as ClassDecorator)
    class WidgetController {
      @Patch(':id')
      @ApiResponse({ status: 200, type: VersionedResponse })
      update(@Body() body: unknown) {
        return body;
      }
    }

    const report = auditOptimisticConcurrencyCoverage(await buildApp([WidgetController]), silentLogger());
    expect(report.findings).toEqual([]);
    expect(report.protectedCount).toBe(1);
  });

  // ── H-1 phase 2: tier A is closed ─────────────────────────────────────────

  it('reports NOTHING for the five controllers that owned the seven tier-A routes', () => {
    const report = auditOptimisticConcurrencyCoverage(
      metadataAppFor([
        ConsultationController,
        DnaWritingStyleController,
        EntitlementsAdminController,
        TenantController,
        TenantIdpConfigAdminController,
      ]),
      silentLogger(),
    );

    // The seven routes the boot audit named before the migration:
    //   PATCH /consultations/:id                              PATCH /dna-writing-styles/:reportId/default
    //   PUT   /dna-writing-styles/settings                    PATCH /admin/entitlements/plans/:plan
    //   PUT   /admin/entitlements/tenants/:tenantId/override  PUT   /admin/tenants/:id/tags
    //   PUT   /admin/tenant-idp-config/:id/directory-credentials
    expect(report.findings).toEqual([]);
    // Nothing was retired by declaring an exception instead of enforcing one.
    expect(report.sanctioned).toEqual([]);
    expect(report.contradictions).toEqual([]);
  });

  it('records the two create-or-update exceptions from an IN-PLACE @NoOptimisticConcurrency, not a lookup table', () => {
    // The audit's static allow-list must stay empty: an exception belongs on
    // the route it excuses, where a reader of the controller can see it.
    expect(SANCTIONED_EXCEPTIONS.size).toBe(0);

    const report = auditOptimisticConcurrencyCoverage(
      metadataAppFor([SettingsRegistryWriteController, TenantFrontendConfigAdminController]),
      silentLogger(),
    );

    expect(report.findings).toEqual([]);
    expect(report.sanctioned).toHaveLength(2);
    expect(report.sanctioned.join('\n')).toContain('PUT /admin/settings/registry/:key');
    expect(report.sanctioned.join('\n')).toContain('PUT /admin/tenant-frontend-config');
    for (const entry of report.sanctioned) {
      expect(entry).toContain('create-or-update');
    }
  });
});
