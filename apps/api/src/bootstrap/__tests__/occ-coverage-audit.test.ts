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
import { ApiProperty, ApiResponse } from '@nestjs/swagger';
import { UnifiedAuthGuard } from '@arcaai/applications';
import { auditOptimisticConcurrencyCoverage } from '../occ-coverage-audit';
import { ExpectedVersion, NoOptimisticConcurrency, RequiresIfMatch } from '../../decorators';

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
});
