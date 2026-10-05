/**
 * TASK-1045 lane W6-SVC — the two handle verbs a SERVICE ACCOUNT could not reach.
 *
 * `ConsultationHandle.generateSummary` (`POST :id/summary/async`) and `ConsultationHandle.reopen`
 * (`POST :id/reopen`) declared no service-account scope, so `X-Service-Account-Token` met the
 * deny-by-default 403; and `summary/async` filed the job under `getDoctorId()`, a 401 for a
 * machine. Owner decision OQ-2 (TASK-933): the whole consultation plane accepts service accounts,
 * and a machine is never recorded as the clinician.
 *
 * Proved here, on a bare controller:
 *
 *  1. the decorator metadata — `svc:consultation:report:write` on summary/async (its sibling
 *     pre-summary/async and its API-key scope are both `report:write`), and
 *     `svc:consultation:session:write` on reopen (the scope approve/close carry);
 *  2. summary/async from a service account files the job under the ROW's clinician and stamps
 *     the service account as its initiator; a human's start is unchanged;
 *  3. reopen forwards a named `clinicianUserId` with the controller-resolved credential, and keeps
 *     the historical call shape when none is named (the service account's attribution is read off
 *     the request context by the lifecycle service).
 */
import { describe, expect, it, vi } from 'vitest';
import { API_KEY_REQUIRED_SCOPES, SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';
import { ConsultationController } from '../consultation.controller';

const TENANT = '10000000-0000-0000-0000-000000000001';
const DOCTOR = '70000000-0000-0000-0000-000000000040';
const OTHER_DOCTOR = '70000000-0000-0000-0000-000000000010';
const SVC_ACCOUNT_ID = 'e0000000-0000-0000-0000-000000000001';
const API_KEY_ID = '70000000-0000-0000-0000-00000000a001';
const CONSULT = '90000000-0000-0000-0001-000000000001';

type Principal = { user?: { id: string }; serviceAccount?: { id: string } };

/* eslint-disable @typescript-eslint/no-explicit-any */
function build(principal: Principal) {
  const noteGenerationService = { generate: vi.fn(async () => ({ generator: 'harness', harnessJobId: 'harness-doc-1' })) };
  const consultationJobService = {
    registerHarnessNoteJob: vi.fn(),
    runIdempotent: vi.fn(async (_scope: unknown, _input: unknown, create: () => Promise<unknown>) => ({ value: await create(), replayed: false })),
  };
  const consultationService = { reopenConsultation: vi.fn(async () => ({ id: CONSULT, status: 'OPEN' })) };
  const values: Record<string, unknown> = { tenantId: TENANT, ...principal };
  const controller = Object.create(ConsultationController.prototype) as ConsultationController;
  Object.assign(controller, {
    noteGenerationService,
    consultationJobService,
    consultationService,
    cls: { get: vi.fn((key: string) => values[key]) },
    logger: { error: vi.fn(), warn: vi.fn(), log: vi.fn() },
    verifyConsultationOwnership: vi.fn(async () => ({ doctorId: DOCTOR, patientId: 'p' })),
  });
  return { controller, noteGenerationService, consultationJobService, consultationService };
}

describe('service-account scopes on the handle verbs', () => {
  it('summary/async declares svc:consultation:report:write (API-key scope unchanged)', () => {
    const handler = ConsultationController.prototype.generateSummaryAsync;
    expect(Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, handler)).toEqual(['svc:consultation:report:write']);
    expect(Reflect.getMetadata(API_KEY_REQUIRED_SCOPES, handler)).toEqual(['consultation:report:write']);
  });

  it('reopen declares svc:consultation:session:write — the scope approve and close carry', () => {
    const handler = ConsultationController.prototype.reopen;
    expect(Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, handler)).toEqual(['svc:consultation:session:write']);
    expect(Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, handler)).toEqual(
      Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, ConsultationController.prototype.approve),
    );
    expect(Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, handler)).toEqual(
      Reflect.getMetadata(SERVICE_ACCOUNT_REQUIRED_SCOPES, ConsultationController.prototype.close),
    );
  });
});

describe('POST :id/summary/async — a service account starts the clinician`s note job', () => {
  it('files the job under the row`s doctor and stamps the service account as initiator', async () => {
    const { controller, noteGenerationService, consultationJobService } = build({ serviceAccount: { id: SVC_ACCOUNT_ID } });

    const response = await controller.generateSummaryAsync(CONSULT, {} as never, 'idem-1');

    expect(response.jobId).toBe('harness-doc-1');
    expect(noteGenerationService.generate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ consultationId: CONSULT, userId: DOCTOR }),
    );
    expect(consultationJobService.registerHarnessNoteJob).toHaveBeenCalledWith('harness-doc-1', CONSULT, TENANT, DOCTOR, SVC_ACCOUNT_ID);
    // The idempotency space is the CALLER's: two service accounts never share one under a key.
    expect(consultationJobService.runIdempotent).toHaveBeenCalledWith(
      { operation: 'summary', tenantId: TENANT, principalId: SVC_ACCOUNT_ID, key: 'idem-1' },
      expect.anything(),
      expect.any(Function),
    );
  });

  it('a machine id never reaches the job`s clinician', async () => {
    const { controller, noteGenerationService, consultationJobService } = build({ serviceAccount: { id: SVC_ACCOUNT_ID } });

    await controller.generateSummaryAsync(CONSULT, {} as never);

    expect((noteGenerationService.generate.mock.calls[0] as any[])[1].userId).not.toBe(SVC_ACCOUNT_ID);
    expect((consultationJobService.registerHarnessNoteJob.mock.calls[0] as any[])[3]).not.toBe(SVC_ACCOUNT_ID);
  });

  it('a human start is unchanged — the caller is clinician, initiator and idempotency principal', async () => {
    const { controller, consultationJobService } = build({ user: { id: OTHER_DOCTOR } });

    await controller.generateSummaryAsync(CONSULT, {} as never, 'idem-2');

    expect(consultationJobService.registerHarnessNoteJob).toHaveBeenCalledWith('harness-doc-1', CONSULT, TENANT, OTHER_DOCTOR, OTHER_DOCTOR);
    expect(consultationJobService.runIdempotent).toHaveBeenCalledWith(
      { operation: 'summary', tenantId: TENANT, principalId: OTHER_DOCTOR, key: 'idem-2' },
      expect.anything(),
      expect.any(Function),
    );
  });
});

describe('POST :id/reopen — attribution', () => {
  it('a service account naming nobody keeps the historical call; the lifecycle attributes it to the row`s clinician', async () => {
    const { controller, consultationService } = build({ serviceAccount: { id: SVC_ACCOUNT_ID } });

    await controller.reopen(CONSULT, 6, undefined, { serviceAccount: { id: SVC_ACCOUNT_ID } } as never);

    expect(consultationService.reopenConsultation).toHaveBeenCalledWith(CONSULT, 6);
  });

  it('a service account naming a clinician forwards the name with the service-account credential', async () => {
    const { controller, consultationService } = build({ serviceAccount: { id: SVC_ACCOUNT_ID } });

    await controller.reopen(CONSULT, 6, { clinicianUserId: OTHER_DOCTOR, reason: 'late result' }, {
      serviceAccount: { id: SVC_ACCOUNT_ID },
    } as never);

    expect(consultationService.reopenConsultation).toHaveBeenCalledWith(CONSULT, 6, {
      reason: 'late result',
      clinicianUserId: OTHER_DOCTOR,
      caller: { credentialClass: 'service-account', principalId: SVC_ACCOUNT_ID },
    });
  });

  it('an API key naming a clinician is classified as an API key bound to its human, never as a JWT', async () => {
    const { controller, consultationService } = build({ user: { id: DOCTOR } });

    await controller.reopen(CONSULT, 6, { clinicianUserId: DOCTOR }, { apiKey: { id: API_KEY_ID, userId: DOCTOR }, user: { id: DOCTOR } } as never);

    expect(consultationService.reopenConsultation).toHaveBeenCalledWith(CONSULT, 6, {
      clinicianUserId: DOCTOR,
      caller: { credentialClass: 'api-key', principalId: API_KEY_ID, boundUserId: DOCTOR },
    });
  });

  it('a JWT or API-key reopen without a name is unchanged (reason only, or the two-argument call)', async () => {
    const { controller, consultationService } = build({ user: { id: DOCTOR } });

    await controller.reopen(CONSULT, 6, { reason: 'late result' }, { user: { id: DOCTOR } } as never);
    await controller.reopen(CONSULT, 7, undefined, { apiKey: { id: API_KEY_ID, userId: DOCTOR }, user: { id: DOCTOR } } as never);

    expect(consultationService.reopenConsultation).toHaveBeenNthCalledWith(1, CONSULT, 6, { reason: 'late result' });
    expect(consultationService.reopenConsultation).toHaveBeenNthCalledWith(2, CONSULT, 7);
  });
});
