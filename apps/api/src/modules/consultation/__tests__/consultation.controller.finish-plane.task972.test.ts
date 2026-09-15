/**
 * TASK-972 Lane 4 — the FINISH half of the consultation plane, as the CONTROLLER sees it.
 *
 * Lane 1 taught the services to attribute a clinical write to a named clinician and to record
 * WHICH credential submitted it. Neither half works until the gateway (a) declares the
 * service-account scopes so a machine can reach the three routes at all, and (b) resolves the
 * caller's CREDENTIAL CLASS and hands it down.
 *
 * (b) is the half a reader has to be careful about, and it is what these tests pin:
 *
 *   `ClinicalCaller` defaults, when the controller omits it, to a CLS-derived value — and CLS
 *   can only tell a service account from a human. There is no `apiKey` CLS key (the guard
 *   deliberately publishes `{ id, tenantId }` into `user` for a key, with no roles and no key id
 *   — `unified-auth.guard.apikey-principal-shape.test.ts` pins that shape). So an API-key caller
 *   that is not resolved from the REQUEST is silently misclassified as a human JWT, and skips
 *   the "a credential never exceeds its human" rule entirely: a key bound to clinician A could
 *   sign a note for clinician B.
 *
 * Hence every case below asserts the caller the controller CONSTRUCTED, not merely that the
 * service was called.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConsultationController } from '../consultation.controller';

const TENANT = 'tenant-1';
const DOCTOR = '70000000-0000-0000-0000-000000000040';
const OTHER_DOCTOR = '70000000-0000-0000-0000-000000000010';
const SVC_ACCOUNT_ID = 'e0000000-0000-0000-0000-000000000001';
const API_KEY_ID = 'a0000000-0000-0000-0000-000000000001';
const CONSULT = '90000000-0000-0000-0001-000000000001';
const SUMMARY = 'c0000000-0000-0000-0000-000000000009';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Principal = 'user' | 'serviceAccount';

function buildController(opts: { principal?: Principal; userId?: string } = {}) {
  const principal: Principal = opts.principal ?? 'serviceAccount';
  const consultationService = {
    getById: vi.fn().mockResolvedValue({ id: CONSULT, doctorId: DOCTOR, patientId: 'p-1', tenantId: TENANT }),
    closeConsultation: vi.fn().mockResolvedValue({ id: CONSULT, status: 'CLOSED_COMPLETE' }),
  };
  const summaryService = {
    updateSummary: vi.fn().mockResolvedValue({ id: SUMMARY }),
    approveSummary: vi.fn().mockResolvedValue({ contextItemId: SUMMARY, approvalStatus: 'APPROVED', approvedBy: DOCTOR, approvedAt: 'now' }),
  };
  const policyEngine = { can: vi.fn().mockReturnValue(false), cannot: vi.fn().mockReturnValue(true) };
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'tenantId') return TENANT;
      if (key === 'user') return principal === 'user' ? { id: opts.userId ?? DOCTOR, tenantId: TENANT } : null;
      if (key === 'serviceAccount') return principal === 'serviceAccount' ? { id: SVC_ACCOUNT_ID, scopes: [] } : undefined;
      return undefined;
    }),
  };

  const controller = new ConsultationController(
    consultationService as any,
    {} as any, // contextService
    summaryService as any,
    {} as any, // chainSummaryService
    {} as any, // consultationJobService
    {} as any, // noteGenerationService
    {} as any, // timelineService
    cls as any,
    policyEngine as any,
    { resolve: vi.fn() } as any, // tenantSettings
    {} as any, // tagService
    {} as any, // liveDocumentationService
    {} as any, // highlightService
    {} as any, // harnessProgressService
    {} as any, // harnessAssuranceService
    {} as any, // harnessLiveAssistService
    {} as any, // redisSubscriber
    {} as any, // loopContextSignalService
    {} as any, // documentSectionService
  );

  return { controller, consultationService, summaryService };
}

/** A request as `UnifiedAuthGuard` leaves it for each credential class. */
const svcReq = () => ({ serviceAccount: { id: SVC_ACCOUNT_ID, tenantId: TENANT } }) as any;
const keyReq = (userId: string | null | undefined) => ({ apiKey: { id: API_KEY_ID, userId } }) as any;
const jwtReq = (userId: string) => ({ user: { id: userId, tenantId: TENANT } }) as any;

describe('TASK-972 Lane 4 — POST /consultations/:id/close', () => {
  it('forwards the named clinician and a SERVICE-ACCOUNT caller', async () => {
    const { controller, consultationService } = buildController();

    await (controller as any).close(CONSULT, 3, { clinicianUserId: DOCTOR }, svcReq());

    expect(consultationService.closeConsultation).toHaveBeenCalledWith(CONSULT, 3, {
      clinicianUserId: DOCTOR,
      caller: { credentialClass: 'service-account', principalId: SVC_ACCOUNT_ID },
    });
  });

  it('classifies an API KEY as `api-key` and carries its BOUND HUMAN — never as a human JWT', async () => {
    const { controller, consultationService } = buildController({ principal: 'user', userId: DOCTOR });

    await (controller as any).close(CONSULT, 3, { clinicianUserId: OTHER_DOCTOR }, keyReq(DOCTOR));

    expect(consultationService.closeConsultation).toHaveBeenCalledWith(CONSULT, 3, {
      clinicianUserId: OTHER_DOCTOR,
      caller: { credentialClass: 'api-key', principalId: API_KEY_ID, boundUserId: DOCTOR },
    });
  });

  it('an UNBOUND key carries `boundUserId: null` — a value, not a missing field', async () => {
    const { controller, consultationService } = buildController({ principal: 'user', userId: DOCTOR });

    await (controller as any).close(CONSULT, 3, {}, keyReq(undefined));

    const caller = consultationService.closeConsultation.mock.calls[0][2].caller;
    expect(caller).toEqual({ credentialClass: 'api-key', principalId: API_KEY_ID, boundUserId: null });
    expect('boundUserId' in caller).toBe(true);
  });

  it('a human JWT is `jwt` with their own user id, and may close with no body at all', async () => {
    const { controller, consultationService } = buildController({ principal: 'user', userId: DOCTOR });

    await (controller as any).close(CONSULT, undefined, undefined, jwtReq(DOCTOR));

    expect(consultationService.closeConsultation).toHaveBeenCalledWith(CONSULT, undefined, {
      clinicianUserId: undefined,
      caller: { credentialClass: 'jwt', principalId: DOCTOR },
    });
  });
});

describe('TASK-972 Lane 4 — POST /consultations/:id/summary/:contextItemId/approve', () => {
  it('forwards `clinicianUserId` from the body beside the OCC predicate and the caller', async () => {
    const { controller, summaryService } = buildController();

    await (controller as any).approveSummary(CONSULT, SUMMARY, { expectedVersion: 7, clinicianUserId: DOCTOR }, 9, svcReq());

    expect(summaryService.approveSummary).toHaveBeenCalledWith(SUMMARY, {
      overrideSafetyFlag: undefined,
      expectedVersion: 9,
      clinicianUserId: DOCTOR,
      caller: { credentialClass: 'service-account', principalId: SVC_ACCOUNT_ID },
    });
  });

  it('classifies an API-key sign-off as `api-key`, so the credential cannot exceed its human', async () => {
    const { controller, summaryService } = buildController({ principal: 'user', userId: DOCTOR });

    await (controller as any).approveSummary(CONSULT, SUMMARY, { expectedVersion: 2, clinicianUserId: OTHER_DOCTOR }, undefined, keyReq(DOCTOR));

    expect(summaryService.approveSummary.mock.calls[0][1].caller).toEqual({
      credentialClass: 'api-key',
      principalId: API_KEY_ID,
      boundUserId: DOCTOR,
    });
  });
});

describe('TASK-972 Lane 4 — PATCH /consultations/:id/summary/:summaryId', () => {
  it('forwards the caller; `clinicianUserId` rides on the request body the DTO already declares', async () => {
    const { controller, summaryService } = buildController();

    await (controller as any).updateSummary(CONSULT, SUMMARY, { content: 'edited', expectedVersion: 1, clinicianUserId: DOCTOR }, 4, svcReq());

    expect(summaryService.updateSummary).toHaveBeenCalledWith(
      SUMMARY,
      expect.objectContaining({ content: 'edited', expectedVersion: 4, clinicianUserId: DOCTOR }),
      { caller: { credentialClass: 'service-account', principalId: SVC_ACCOUNT_ID } },
    );
  });

  it('classifies an API-key edit as `api-key`', async () => {
    const { controller, summaryService } = buildController({ principal: 'user', userId: DOCTOR });

    await (controller as any).updateSummary(CONSULT, SUMMARY, { content: 'x', expectedVersion: 1 }, undefined, keyReq(null));

    expect(summaryService.updateSummary.mock.calls[0][2]).toEqual({
      caller: { credentialClass: 'api-key', principalId: API_KEY_ID, boundUserId: null },
    });
  });
});
