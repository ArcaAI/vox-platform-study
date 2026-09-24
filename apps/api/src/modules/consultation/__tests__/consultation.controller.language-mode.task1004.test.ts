/**
 * TASK-1004 (OD-2 (a)) — `PATCH consultations/:id { languageMode }` under the house OCC.
 *
 *  - 428: the route is `@RequiresIfMatch()`, so a missing `If-Match` never reaches the service;
 *  - 412: a stale version's `OptimisticConcurrencyException` propagates to the exception
 *    interceptor (which answers 412) — the controller never swallows or rewrites it;
 *  - 200: the version from `If-Match` reaches the service with the body unchanged.
 *
 * And the route is reachable by the credential classes that can OPEN a consultation: API keys
 * through the class-level `consultation:session:write`, service accounts through the same
 * `svc:consultation:session:write` `open` carries (the realtime broker changes the language).
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { SERVICE_ACCOUNT_REQUIRED_SCOPES, normalizeLanguageMode } from '@arcaai/applications';
import { ConsultationController } from '../consultation.controller';
import { extractExpectedVersion } from '../../../decorators/expectedVersion.decorator';

const TENANT = 'tenant-1';
const DOCTOR = '70000000-0000-0000-0000-000000000040';
const CONSULT = '90000000-0000-0000-0001-000000000001';

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildController(principal: 'user' | 'serviceAccount') {
  const consultationService = {
    getById: vi.fn().mockResolvedValue({ id: CONSULT, doctorId: DOCTOR, patientId: 'p-1', tenantId: TENANT }),
    updateConsultation: vi.fn().mockResolvedValue({ id: CONSULT, language: 'ml-en', version: 8 }),
  };
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'tenantId') return TENANT;
      if (key === 'user') return principal === 'user' ? { id: DOCTOR, tenantId: TENANT } : null;
      if (key === 'serviceAccount') return principal === 'serviceAccount' ? { id: 'svc-1', scopes: [] } : undefined;
      return undefined;
    }),
  };
  const controller = new ConsultationController(
    consultationService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    cls as any,
    { can: vi.fn().mockReturnValue(false) } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { controller, consultationService };
}

function httpContext(headers: Record<string, string>, annotated = true) {
  const req = { headers, body: {}, _requiresIfMatch: annotated };
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

describe('PATCH consultations/:id { languageMode }', () => {
  it('is an OCC route that service accounts can reach with the scope `open` carries', () => {
    const handler = ConsultationController.prototype.update;
    expect(Reflect.getMetadata('requiresIfMatch', handler)).toBe(true);
    expect(Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, handler)).toEqual(['svc:consultation:session:write']);
    // the SAME scope `open` declares — one capability, one scope
    expect(Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, ConsultationController.prototype.open)).toEqual(['svc:consultation:session:write']);
  });

  it('428 — a missing If-Match is refused before the handler', () => {
    let thrown: unknown;
    try {
      extractExpectedVersion(undefined, httpContext({}));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.PRECONDITION_REQUIRED);
  });

  it('200 — the If-Match version and the body reach the service (service-account caller)', async () => {
    const { controller, consultationService } = buildController('serviceAccount');
    const version = extractExpectedVersion(undefined, httpContext({ 'if-match': '"7"' }));
    const response = await controller.update(CONSULT, { languageMode: 'ml-en' } as any, version);
    expect(consultationService.updateConsultation).toHaveBeenCalledWith(CONSULT, { languageMode: 'ml-en' }, 7);
    expect(response).toMatchObject({ language: 'ml-en', version: 8 });
  });

  it('412 — a stale version surfaces as the OCC exception the interceptor maps to 412', async () => {
    const { controller, consultationService } = buildController('user');
    consultationService.updateConsultation.mockRejectedValue(
      new OptimisticConcurrencyException('Consultation', CONSULT, { expectedVersion: 3, currentVersion: 5 }),
    );
    await expect(controller.update(CONSULT, { languageMode: 'ml-en' } as any, 3)).rejects.toBeInstanceOf(OptimisticConcurrencyException);
  });

  it('runs against this worktree’s @arcaai/applications build (sanity: the TASK-1004 normalizer is exported)', () => {
    expect(normalizeLanguageMode('ml-IN')).toBe('ml');
  });
});
