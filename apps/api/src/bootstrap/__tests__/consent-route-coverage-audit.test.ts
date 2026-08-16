/**
 * Boot-time consent-coverage audit (TASK-712, consent-abac — README §4 Task 11).
 *
 * Pins the predicate: any route whose full path carries a `:patientId`
 * segment must declare `@RequiresConsent(...)` or `@ConsentExempt(reason)`,
 * and proves the audit "bites" — refuses to start, then passes once the
 * decorator is restored (README §5 Acceptance Criteria).
 */
import { describe, it, expect } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { Controller, Get, Module, Param } from '@nestjs/common';
import { auditConsentRouteCoverage } from '../consent-route-coverage-audit';
import { UnifiedAuthGuard } from '@arcaai/applications';
import { ConsentExempt, Public, RequiresConsent } from '../../decorators';

async function buildAppFromControllers(controllers: Array<new (...args: unknown[]) => unknown>) {
  @Module({ controllers })
  class _SyntheticModule {}

  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [_SyntheticModule] })
    .overrideGuard(UnifiedAuthGuard)
    .useValue({ canActivate: () => true })
    .compile();

  return moduleRef as unknown as Parameters<typeof auditConsentRouteCoverage>[0];
}

describe('boot-time consent-coverage audit', () => {
  it('throws when a :patientId route declares neither @RequiresConsent nor @ConsentExempt', async () => {
    @Controller('consultations')
    class PatientHistoryOrphan {
      @Get('patient/:patientId/history')
      history(@Param('patientId') patientId: string) {
        return { patientId };
      }
    }
    const app = await buildAppFromControllers([PatientHistoryOrphan]);
    expect(() => auditConsentRouteCoverage(app)).toThrow(/patient\/:patientId\/history.*neither @RequiresConsent\(\.\.\.\) nor @ConsentExempt/);
  });

  it('passes — and no longer throws — once @RequiresConsent is restored (proves the audit bites, then clears)', async () => {
    @Controller('consultations')
    class PatientHistoryOrphan {
      @Get('patient/:patientId/history')
      history(@Param('patientId') patientId: string) {
        return { patientId };
      }
    }
    const orphanApp = await buildAppFromControllers([PatientHistoryOrphan]);
    expect(() => auditConsentRouteCoverage(orphanApp)).toThrow();

    @Controller('consultations')
    class PatientHistoryOk {
      @Get('patient/:patientId/history')
      @RequiresConsent('HISTORY_RETRIEVAL' as never)
      history(@Param('patientId') patientId: string) {
        return { patientId };
      }
    }
    const fixedApp = await buildAppFromControllers([PatientHistoryOk]);
    expect(() => auditConsentRouteCoverage(fixedApp)).not.toThrow();
  });

  it('passes on a :patientId route carrying @ConsentExempt(reason) instead', async () => {
    @Controller('consultations')
    class PatientListExempt {
      @Get('patient/:patientId/summary-count')
      @ConsentExempt('Aggregate count only, no PHI content returned.')
      count(@Param('patientId') patientId: string) {
        return { patientId, count: 0 };
      }
    }
    const app = await buildAppFromControllers([PatientListExempt]);
    expect(() => auditConsentRouteCoverage(app)).not.toThrow();
  });

  it('is a no-op on a @Public() :patientId route (never authenticated, nothing to gate)', async () => {
    @Controller('consultations')
    class PublicPatientRoute {
      @Get('patient/:patientId/public-info')
      @Public()
      info(@Param('patientId') patientId: string) {
        return { patientId };
      }
    }
    const app = await buildAppFromControllers([PublicPatientRoute]);
    expect(() => auditConsentRouteCoverage(app)).not.toThrow();
  });

  it('ignores a route with no :patientId segment entirely (e.g. :id, or a query param)', async () => {
    @Controller('consultations')
    class NoPatientParam {
      @Get(':id/chain')
      chain(@Param('id') id: string) {
        return { id };
      }
    }
    const app = await buildAppFromControllers([NoPatientParam]);
    expect(() => auditConsentRouteCoverage(app)).not.toThrow();
  });
});
