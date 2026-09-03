/**
 * `PatientConsentGuard` unit tests (consent-abac — Task 8).
 *
 * Pins: tenant/user resolution comes from CLS ONLY, never `request.ability`
 * (Pitfall 3 — the API-key auth path builds no CASL ability at all); the
 * `:patientId`/`patientIdParam`/`:id`-consultation-lookup resolution order;
 * a denial/unavailable verdict propagates unchanged; `@Public()` and
 * `@ConsentExempt()` are no-ops; a route with NEITHER decorator is ALSO a
 * no-op here (the boot-time coverage audit, not this guard, catches a
 * missing decorator).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ClsService } from 'nestjs-cls';
import { ConsentDeniedException, ConsentUnavailableException } from '@arcaai/exceptions';
import { PatientConsentGuard } from '../patient-consent.guard';

const createCls = (store: Record<string, unknown>): ClsService => {
  return { get: (key: string) => store[key] } as unknown as ClsService;
};

const createContext = (params: Record<string, string> = {}, extra: Record<string, unknown> = {}): ExecutionContext => {
  const request = { params, ...extra };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => 'handlerRef',
    getClass: () => 'classRef',
  } as unknown as ExecutionContext;
};

describe('PatientConsentGuard', () => {
  let reflector: { getAllAndOverride: ReturnType<typeof vi.fn> };
  let consentService: { assertConsent: ReturnType<typeof vi.fn>; checkConsent: ReturnType<typeof vi.fn> };
  let consultationRepository: { findById: ReturnType<typeof vi.fn> };
  let cls: ClsService;

  /** Metadata table the fake reflector serves, keyed by the metadata key string. */
  let metadata: Record<string, unknown>;

  beforeEach(() => {
    metadata = {};
    reflector = {
      getAllAndOverride: vi.fn((key: string) => metadata[key]),
    };
    consentService = {
      assertConsent: vi.fn().mockResolvedValue(undefined),
      checkConsent: vi.fn(),
    };
    consultationRepository = { findById: vi.fn() };
    cls = createCls({ tenantId: 'tenant-1', user: { id: 'clinician-1' } });
  });

  const buildGuard = (): PatientConsentGuard =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new PatientConsentGuard(reflector as unknown as Reflector, cls, consentService as any, consultationRepository as any);

  it('is a no-op on a @Public() route — never calls assertConsent', async () => {
    // SKIP_AUTH_KEY's real value (authorization.guard.ts) — @Public() routes
    // never authenticated, so there is no tenant/patient to gate on.
    metadata['skip_auth'] = true;
    const guard = buildGuard();
    const context = createContext({ patientId: 'p' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(consentService.assertConsent).not.toHaveBeenCalled();
  });

  it('is a no-op on a @ConsentExempt(reason) route — never calls assertConsent', async () => {
    metadata['consentExempt'] = 'Lists the caller doctor\'s own consultations; no single patientId to gate on.';
    const guard = buildGuard();
    const context = createContext({ patientId: 'p' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(consentService.assertConsent).not.toHaveBeenCalled();
  });

  it('resolves patient id from the :patientId route param and asserts with CLS tenant/user (never request.ability)', async () => {
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === 'requiresConsent') return { purpose: 'HISTORY_RETRIEVAL' };
      return undefined;
    });
    const guard = buildGuard();
    const context = createContext({ patientId: 'EHR-A:12345' }, { ability: { can: () => true } });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(consentService.assertConsent).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', externalPatientId: 'EHR-A:12345', purpose: 'HISTORY_RETRIEVAL', actor: { userId: 'clinician-1', kind: 'user' } }),
    );
    expect(consultationRepository.findById).not.toHaveBeenCalled();
  });

  it('prefers an explicit patientIdParam over :patientId', async () => {
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === 'requiresConsent') return { purpose: 'HISTORY_RETRIEVAL', patientIdParam: 'externalId' };
      return undefined;
    });
    const guard = buildGuard();
    const context = createContext({ patientId: 'wrong-one', externalId: 'EHR-B:999' });

    await guard.canActivate(context);

    expect(consentService.assertConsent).toHaveBeenCalledWith(expect.objectContaining({ externalPatientId: 'EHR-B:999' }));
  });

  it('falls back to loading the consultation by :id and reading its patientId', async () => {
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === 'requiresConsent') return { purpose: 'AI_DOCUMENTATION' };
      return undefined;
    });
    consultationRepository.findById.mockResolvedValue({ tenantId: 'tenant-1', patientId: 'EHR-C:1' });
    const guard = buildGuard();
    const context = createContext({ id: 'consultation-1' });

    await guard.canActivate(context);

    expect(consultationRepository.findById).toHaveBeenCalledWith('consultation-1');
    expect(consentService.assertConsent).toHaveBeenCalledWith(expect.objectContaining({ externalPatientId: 'EHR-C:1', purpose: 'AI_DOCUMENTATION' }));
  });

  it('a cross-tenant consultation (:id resolves to a different tenant) 404s and never calls assertConsent', async () => {
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === 'requiresConsent') return { purpose: 'AI_DOCUMENTATION' };
      return undefined;
    });
    consultationRepository.findById.mockResolvedValue({ tenantId: 'some-other-tenant', patientId: 'EHR-C:1' });
    const guard = buildGuard();
    const context = createContext({ id: 'consultation-1' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(NotFoundException);
    expect(consentService.assertConsent).not.toHaveBeenCalled();
  });

  it('propagates ConsentDeniedException unchanged', async () => {
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === 'requiresConsent') return { purpose: 'HISTORY_RETRIEVAL' };
      return undefined;
    });
    consentService.assertConsent.mockRejectedValue(
      new ConsentDeniedException('denied', { tenantId: 'tenant-1', externalPatientId: 'p', purpose: 'HISTORY_RETRIEVAL', reason: 'no_grant' }),
    );
    const guard = buildGuard();
    const context = createContext({ patientId: 'p' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ConsentDeniedException);
  });

  it('propagates ConsentUnavailableException unchanged — distinct from a denial (R4)', async () => {
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === 'requiresConsent') return { purpose: 'HISTORY_RETRIEVAL' };
      return undefined;
    });
    consentService.assertConsent.mockRejectedValue(
      new ConsentUnavailableException('unavailable', { tenantId: 'tenant-1', externalPatientId: 'p', purpose: 'HISTORY_RETRIEVAL', cause: 'grant_lookup_failed' }),
    );
    const guard = buildGuard();
    const context = createContext({ patientId: 'p' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ConsentUnavailableException);
    await expect(guard.canActivate(context)).rejects.not.toBeInstanceOf(ConsentDeniedException);
  });

  it('is a no-op when the route carries neither @RequiresConsent nor @ConsentExempt metadata', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const guard = buildGuard();
    const context = createContext({ patientId: 'p' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(consentService.assertConsent).not.toHaveBeenCalled();
  });

  it('is a no-op on a non-HTTP execution context (RPC/WS)', async () => {
    reflector.getAllAndOverride.mockImplementation((key: string) => (key === 'requiresConsent' ? { purpose: 'HISTORY_RETRIEVAL' } : undefined));
    const guard = buildGuard();
    const context = { getType: () => 'rpc' } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(consentService.assertConsent).not.toHaveBeenCalled();
  });
});
