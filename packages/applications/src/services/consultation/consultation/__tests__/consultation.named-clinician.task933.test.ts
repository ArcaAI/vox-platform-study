/**
 * TASK-933 §3.2 — opening a consultation FOR a named clinician.
 *
 * A service account is a machine identity: it has no CLS `user`, and it must never be recorded
 * as the clinician (`Consultation.doctorId` names a person, and every downstream consumer —
 * DNA style, the redaction gate, the doctor's report, the prompt tier — reads that column).
 * So the machine NAMES the clinician it acts for, on the open request, and the service
 * validates that name exactly as it validates a human `doctorId` today (tenant membership)
 * PLUS one thing a human caller has already proved by reaching the route at all: that the named
 * user may own a consultation.
 *
 * Two halves, tested here:
 *   · the DTO — `clinicianUserId` is declared (the global pipe runs `forbidNonWhitelisted`, so
 *     an undeclared field is a 400 for the WHOLE open) and is a uuid;
 *   · the service — the named user's own CASL ability must grant `create:Consultation`, and
 *     every failure is a 404, never a 403 (404-over-403: the user id space is not the caller's
 *     to probe, and "that user exists but may not" is exactly the disclosure to avoid).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { ResourceStatusType } from '@arcaai/domains';
import { ConsultationService } from '../consultation.service';
import { OpenConsultationRequest } from '../dto/open-consultation.request';

// ─── DTO ────────────────────────────────────────────────────────────────────

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
});
const metatype = { type: 'body' as const, metatype: OpenConsultationRequest };

const CLINICIAN = '70000000-0000-0000-0000-000000000040';

describe('OpenConsultationRequest.clinicianUserId — wire contract', () => {
  it('accepts the clinician a service account names', async () => {
    await expect(pipe.transform({ patientId: 'p-1', clinicianUserId: CLINICIAN }, metatype)).resolves.toMatchObject({
      clinicianUserId: CLINICIAN,
    });
  });

  it('stays optional — a human caller opens exactly as before', async () => {
    await expect(pipe.transform({ patientId: 'p-1' }, metatype)).resolves.toMatchObject({ patientId: 'p-1' });
  });

  it('rejects a non-uuid clinician at the edge, before any tenant read', async () => {
    await expect(pipe.transform({ patientId: 'p-1', clinicianUserId: 'not-a-uuid' }, metatype)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-string clinician', async () => {
    await expect(pipe.transform({ patientId: 'p-1', clinicianUserId: { id: CLINICIAN } }, metatype)).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─── Service ────────────────────────────────────────────────────────────────

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...(actual as Record<string, unknown>),
    ConsultationFactory: {
      CreateNewVisit: vi.fn((data) => ({ ...data, id: 'new-consultation-id', createdAt: new Date(), updatedAt: new Date() })),
      CreateRevisit: vi.fn((data) => ({ ...data, id: 'new-revisit-id', createdAt: new Date(), updatedAt: new Date() })),
    },
  };
});

describe('ConsultationService.getOrCreate — the named clinician must be able to OWN a consultation', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let consultationRepository: any;
  let departmentRepository: any;
  let userRoleAssignmentRepository: any;
  let userDepartmentRepository: any;
  let userRepository: any;
  let policyEngine: any;
  let service: ConsultationService;

  const buildService = (engine?: unknown) =>
    new ConsultationService(
      consultationRepository,
      departmentRepository,
      userRoleAssignmentRepository,
      userDepartmentRepository,
      userRepository,
      { emit: vi.fn() } as any,
      {
        get: vi.fn((key: string) => {
          if (key === 'tenantId') return 'tenant-1';
          // A SERVICE ACCOUNT sets no CLS `user` — that is the whole point of the class.
          return null;
        }),
        set: vi.fn(),
      } as any,
      // entitlements, harnessAudit, tenantSettings, workflowDispatch, consentGrant,
      // workflowDefinitionRepository — then the policy engine this block is about.
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      engine as any,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    consultationRepository = {
      findByUniqueKey: vi.fn().mockResolvedValue(null),
      findWithRelations: vi.fn().mockResolvedValue(null),
      create: vi.fn(async (entity: unknown) => entity),
    };
    departmentRepository = { findById: vi.fn().mockResolvedValue({ id: 'dept-1', tenantId: 'tenant-1' }) };
    userRoleAssignmentRepository = {
      findFirst: vi.fn().mockResolvedValue({ id: 'ura-1', userId: CLINICIAN, tenantId: 'tenant-1', resourceStatus: ResourceStatusType.ENABLED }),
    };
    userDepartmentRepository = {
      findFirst: vi.fn().mockResolvedValue({ id: 'ud-1', userId: CLINICIAN, tenantId: 'tenant-1', resourceStatus: ResourceStatusType.ENABLED }),
    };
    userRepository = { findFirst: vi.fn().mockResolvedValue({ id: CLINICIAN, isServiceAccount: false }) };
    policyEngine = { buildAbility: vi.fn().mockResolvedValue({ can: vi.fn().mockReturnValue(true) }) };
    service = buildService(policyEngine);
  });

  it('opens for the named clinician and writes them as the doctor', async () => {
    const saved = await service.getOrCreate({ patientId: 'p-1', clinicianUserId: CLINICIAN } as OpenConsultationRequest, CLINICIAN);

    expect(saved).toBeDefined();
    expect(consultationRepository.create).toHaveBeenCalledWith(expect.objectContaining({ doctorId: CLINICIAN }));
    // The ability is built for the CLINICIAN, in the caller's tenant — never for the machine.
    expect(policyEngine.buildAbility).toHaveBeenCalledWith({ userId: CLINICIAN, tenantId: 'tenant-1' });
  });

  it('404s when the named user cannot create a consultation (a nurse, say) — never 403', async () => {
    policyEngine.buildAbility.mockResolvedValue({ can: vi.fn().mockReturnValue(false) });

    await expect(service.getOrCreate({ patientId: 'p-1', clinicianUserId: CLINICIAN } as OpenConsultationRequest, CLINICIAN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(consultationRepository.create).not.toHaveBeenCalled();
  });

  it('404s when the named user is not in the tenant — the membership guard runs FIRST', async () => {
    userRoleAssignmentRepository.findFirst.mockResolvedValue(null);
    userDepartmentRepository.findFirst.mockResolvedValue(null);
    userRepository.findFirst.mockResolvedValue(null);

    await expect(service.getOrCreate({ patientId: 'p-1', clinicianUserId: CLINICIAN } as OpenConsultationRequest, CLINICIAN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // Cross-tenant is answered before any ability is built: nothing about the foreign user's
    // privileges is computed, let alone disclosed.
    expect(policyEngine.buildAbility).not.toHaveBeenCalled();
  });

  it('404s when the ability build itself fails — fail CLOSED, never "assume they may"', async () => {
    policyEngine.buildAbility.mockRejectedValue(new Error('redis down'));

    await expect(service.getOrCreate({ patientId: 'p-1', clinicianUserId: CLINICIAN } as OpenConsultationRequest, CLINICIAN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s when the policy engine is not wired — an unanswered question is not a yes', async () => {
    service = buildService(undefined);

    await expect(service.getOrCreate({ patientId: 'p-1', clinicianUserId: CLINICIAN } as OpenConsultationRequest, CLINICIAN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('does NOT build an ability when no clinician was named — the human path is untouched', async () => {
    await service.getOrCreate({ patientId: 'p-1' } as OpenConsultationRequest, 'doctor-1');

    expect(policyEngine.buildAbility).not.toHaveBeenCalled();
    expect(consultationRepository.create).toHaveBeenCalledWith(expect.objectContaining({ doctorId: 'doctor-1' }));
  });

  it("threads the named clinician into the run payload's subject when the caller is a machine", async () => {
    const dispatch = { dispatchForConsultation: vi.fn().mockResolvedValue({ dispatched: false }), assertSelectableForConsultation: vi.fn() };
    const wired = new ConsultationService(
      consultationRepository,
      departmentRepository,
      userRoleAssignmentRepository,
      userDepartmentRepository,
      userRepository,
      { emit: vi.fn() } as any,
      { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : null)), set: vi.fn() } as any,
      undefined,
      undefined,
      undefined,
      dispatch as any,
      undefined,
      undefined,
      policyEngine,
    );

    await wired.getOrCreate({ patientId: 'p-1', clinicianUserId: CLINICIAN } as OpenConsultationRequest, CLINICIAN);

    // `requestUserId` is null for a machine, so `userId ?? doctorId` must resolve to the
    // clinician — never to the service account, and never to null.
    expect(dispatch.dispatchForConsultation).toHaveBeenCalledWith(expect.objectContaining({ userId: CLINICIAN }));
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
});
