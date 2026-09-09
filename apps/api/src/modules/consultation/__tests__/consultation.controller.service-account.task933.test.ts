/**
 * TASK-933 §3.2/§3.3 — the consultation surface as driven by a SERVICE ACCOUNT.
 *
 * A machine principal lives on CLS key `serviceAccount` and NEVER on `user` (`unified-auth.
 * guard.ts`: "every `requestUser?.id` read would otherwise record this machine's actions
 * against a person"). Every access check on this controller went through `getDoctorId()`, which
 * reads `user` and throws 401 otherwise — so before this ticket a service account could not read
 * a consultation it had just opened, let alone record one.
 *
 * The three shapes proved here:
 *
 *  1. OPEN names the clinician. Required for a machine, refused for everyone else.
 *  2. ACCESS for a machine is tenant + scope. There is no doctor equality to check — the machine
 *     is not a doctor — and the row itself supplies the clinician. The tenant boundary is
 *     enforced one layer out (`TenantOwnedResourceInterceptor`, and the tenant-scoped Prisma
 *     extension behind `getById`), which is why a cross-tenant id is a 404 and not a 403.
 *  3. Anything downstream that needs a CLINICIAN reads `consultation.doctorId`, never the
 *     principal. A service-account id must never reach `liveDocumentationService.start` or a
 *     job's `userId`.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConsultationController } from '../consultation.controller';

const TENANT = 'tenant-1';
const DOCTOR = '70000000-0000-0000-0000-000000000040';
const OTHER_DOCTOR = '70000000-0000-0000-0000-000000000010';
const SVC_ACCOUNT_ID = 'e0000000-0000-0000-0000-000000000001';
const CONSULT = '90000000-0000-0000-0001-000000000001';

/* eslint-disable @typescript-eslint/no-explicit-any */
function buildController(opts: { principal: 'user' | 'serviceAccount'; userId?: string } = { principal: 'serviceAccount' }) {
  const consultationService = {
    getById: vi.fn(),
    getByIdWithRelations: vi.fn(),
    getOrCreate: vi.fn(),
    startRecording: vi.fn().mockResolvedValue({ status: 'RECORDING' }),
    stopRecording: vi.fn().mockResolvedValue({ status: 'OPEN' }),
    doctorHasPatientRelationship: vi.fn().mockResolvedValue(false),
  };
  const contextService = { addContext: vi.fn() };
  const summaryService = { getLatestSummary: vi.fn() };
  const jobService = { createPreSummaryJob: vi.fn().mockResolvedValue({ jobId: 'job-1' }) };
  const liveDocumentationService = { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };
  const loopContextSignalService = { signalConsultationEnding: vi.fn().mockResolvedValue(undefined) };
  const policyEngine = { can: vi.fn().mockReturnValue(false), cannot: vi.fn().mockReturnValue(true) };

  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'tenantId') return TENANT;
      if (key === 'user') return opts.principal === 'user' ? { id: opts.userId ?? DOCTOR, tenantId: TENANT } : null;
      if (key === 'serviceAccount') return opts.principal === 'serviceAccount' ? { id: SVC_ACCOUNT_ID, scopes: [] } : undefined;
      return undefined;
    }),
  };

  const controller = new ConsultationController(
    consultationService as any,
    contextService as any,
    summaryService as any,
    {} as any, // chainSummaryService
    jobService as any,
    {} as any, // noteGenerationService
    {} as any, // timelineService
    cls as any,
    policyEngine as any,
    { findAll: vi.fn().mockResolvedValue([]) } as any, // globalSettingRepository
    {} as any, // tagService
    liveDocumentationService as any,
    {} as any, // highlightService
    {} as any, // harnessProgressService
    {} as any, // harnessAssuranceService
    {} as any, // harnessLiveAssistService
    {} as any, // redisSubscriber
    loopContextSignalService as any,
    {} as any, // documentSectionService
  );

  return { controller, consultationService, contextService, summaryService, jobService, liveDocumentationService, policyEngine };
}

const consultationRow = (overrides: Record<string, unknown> = {}) => ({
  id: CONSULT,
  doctorId: DOCTOR,
  patientId: 'p-1',
  tenantId: TENANT,
  ...overrides,
});

describe('ConsultationController — open for a named clinician', () => {
  it('a service account names the clinician, and that is what reaches the service', async () => {
    const { controller, consultationService } = buildController();
    consultationService.getOrCreate.mockResolvedValue(consultationRow());

    await controller.open({ patientId: 'p-1', clinicianUserId: DOCTOR } as any);

    expect(consultationService.getOrCreate).toHaveBeenCalledWith(expect.objectContaining({ clinicianUserId: DOCTOR }), DOCTOR);
  });

  it('a service account that names nobody is a 400 CLINICIAN_REQUIRED — never the account itself', async () => {
    const { controller, consultationService } = buildController();

    await expect(controller.open({ patientId: 'p-1' } as any)).rejects.toMatchObject({
      response: { code: 'CLINICIAN_REQUIRED' },
    });
    await expect(controller.open({ patientId: 'p-1' } as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(consultationService.getOrCreate).not.toHaveBeenCalled();
  });

  it('a HUMAN caller that names a clinician is a 400 CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER', async () => {
    const { controller, consultationService } = buildController({ principal: 'user', userId: DOCTOR });

    await expect(controller.open({ patientId: 'p-1', clinicianUserId: OTHER_DOCTOR } as any)).rejects.toMatchObject({
      response: { code: 'CLINICIAN_NOT_ALLOWED_FOR_USER_CALLER' },
    });
    expect(consultationService.getOrCreate).not.toHaveBeenCalled();
  });

  it('a human caller still opens as themselves', async () => {
    const { controller, consultationService } = buildController({ principal: 'user', userId: DOCTOR });
    consultationService.getOrCreate.mockResolvedValue(consultationRow());

    await controller.open({ patientId: 'p-1' } as any);

    expect(consultationService.getOrCreate).toHaveBeenCalledWith(expect.anything(), DOCTOR);
  });

  it('an unauthenticated caller is still a 401 — the machine branch opens nothing new', async () => {
    const { controller } = buildController({ principal: 'user', userId: undefined as unknown as string });
    const cls = (controller as any).cls;
    cls.get.mockImplementation((key: string) => (key === 'tenantId' ? TENANT : null));

    await expect(controller.open({ patientId: 'p-1' } as any)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('ConsultationController — access checks for a machine principal', () => {
  it('reads a consultation in its own tenant without any doctor equality', async () => {
    const { controller, consultationService, policyEngine } = buildController();
    consultationService.getById.mockResolvedValue(consultationRow());
    consultationService.getByIdWithRelations.mockResolvedValue(consultationRow());

    await expect(controller.getById(CONSULT)).resolves.toMatchObject({ id: CONSULT });
    // The machine has no CASL user ability and no shared-patient relationship; neither is consulted.
    expect(policyEngine.can).not.toHaveBeenCalled();
    expect(consultationService.doctorHasPatientRelationship).not.toHaveBeenCalled();
  });

  it('404s a consultation the tenant-scoped read cannot see', async () => {
    const { controller, consultationService } = buildController();
    consultationService.getById.mockResolvedValue(null);

    await expect(controller.getById(CONSULT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s a row in another tenant — the boundary is the service's, and it runs FIRST", async () => {
    // `ConsultationService.getById` runs `assertEqualTenants` against the CLS tenant (and the
    // extended Prisma client has already scoped the read), so a foreign row never reaches the
    // controller as a row: it arrives as a 404. Pinned here so the machine branch can never be
    // "fixed" into resolving one.
    const { controller, consultationService } = buildController();
    consultationService.getById.mockRejectedValue(new NotFoundException('Resource not found'));

    await expect(controller.getById(CONSULT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('writes to a consultation in its own tenant (ownership check) without doctor equality', async () => {
    const { controller, consultationService, contextService } = buildController();
    consultationService.getById.mockResolvedValue(consultationRow());
    contextService.addContext.mockResolvedValue({ id: 'ctx-1' });

    await expect(controller.addContext(CONSULT, { content: 'note' } as any, undefined)).resolves.toMatchObject({ id: 'ctx-1' });
  });

  it('404s a WRITE against a foreign-tenant row, for the same reason', async () => {
    const { controller, consultationService } = buildController();
    consultationService.getById.mockRejectedValue(new NotFoundException('Resource not found'));

    await expect(controller.addContext(CONSULT, { content: 'note' } as any, undefined)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ConsultationController — the CLINICIAN comes from the ROW, never from the principal', () => {
  it('startRecording opens the live session for consultation.doctorId', async () => {
    const { controller, consultationService, liveDocumentationService } = buildController();
    consultationService.getById.mockResolvedValue(consultationRow());

    await controller.startRecording(CONSULT, { sessionId: 'sess-1' } as any);

    expect(liveDocumentationService.start).toHaveBeenCalledWith(expect.objectContaining({ userId: DOCTOR, consultationId: CONSULT }));
    const call = liveDocumentationService.start.mock.calls[0][0];
    expect(call.userId).not.toBe(SVC_ACCOUNT_ID);
  });

  it('a human caller still records as themselves', async () => {
    const { controller, consultationService, liveDocumentationService } = buildController({ principal: 'user', userId: DOCTOR });
    consultationService.getById.mockResolvedValue(consultationRow());

    await controller.startRecording(CONSULT, {} as any);

    expect(liveDocumentationService.start).toHaveBeenCalledWith(expect.objectContaining({ userId: DOCTOR }));
  });

  it("generatePreSummaryAsync files the job under the row's doctor, not the machine", async () => {
    const { controller, consultationService, jobService } = buildController();
    consultationService.getById.mockResolvedValue(consultationRow());

    await controller.generatePreSummaryAsync(CONSULT, {} as any);

    expect(jobService.createPreSummaryJob).toHaveBeenCalledWith(CONSULT, TENANT, DOCTOR, expect.anything(), undefined, undefined);
  });

  it('stopRecording works for a machine principal', async () => {
    const { controller, consultationService } = buildController();
    consultationService.getById.mockResolvedValue(consultationRow());

    await expect(controller.stopRecording(CONSULT, {} as any)).resolves.toMatchObject({ recording: false });
  });

  it('summary/latest is readable by a machine principal', async () => {
    const { controller, consultationService, summaryService } = buildController();
    consultationService.getById.mockResolvedValue(consultationRow());
    summaryService.getLatestSummary.mockResolvedValue({ id: 'sum-1' });

    await expect(controller.getLatestSummary(CONSULT)).resolves.toMatchObject({ id: 'sum-1' });
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
