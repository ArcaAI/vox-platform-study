/**
 * TASK-950 §D-6 — opening a consultation for a clinician identified by STAFF ID.
 *
 * The owner's ask is that an integrator authenticated as a SERVICE ACCOUNT never has to learn
 * HOPE user ids: it sends the consultant id its own roster already uses, inside the
 * schema-typed `context` payload, and HOPE resolves it — provisioning the user when the tenant
 * allows it — before `Consultation.doctorId` is written.
 *
 * Four properties are pinned here, because each one is a way the feature could be wrong rather
 * than merely incomplete:
 *
 *  1. THE PAYLOAD IS CHECKED FIRST, for every credential class, and a violation is a 400 that
 *     lists every problem at once (`CONTEXT_SCHEMA_VIOLATION`) — never a 404 about a clinician
 *     the caller never named, and never a partially-opened consultation.
 *  2. THE MARKER IS READ FROM THE SAME SCHEMA THE PAYLOAD VALIDATED AGAINST, and only for kinds
 *     the caller actually sent.
 *  3. `clinicianUserId` AND the identity value may both be sent, but they must AGREE (D-7).
 *     Silent precedence either way would let an integrator believe it named a clinician it did
 *     not.
 *  4. A HUMAN CALLER IS NEVER RESOLVED FROM A BODY FIELD (D-5). Their clinician is their own
 *     authenticated identity; the field is content and nothing more.
 *
 * The identity service's OWN failures (`USER_IDENTITY_UNKNOWN` and its siblings) belong to that
 * service and are asserted here only to prove this layer does not re-label them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ResourceStatusType } from '@arcaai/domains';
import { ConsultationService } from '../consultation.service';
import { OpenConsultationRequest } from '../dto/open-consultation.request';

const TENANT = 'tenant-1';
const DEPARTMENT = 'dept-1';
const SVC_ACCOUNT = 'e0000000-0000-0000-0000-000000000001';
const HUMAN_CALLER = '70000000-0000-0000-0000-000000000010';
const NAMED_CLINICIAN = '70000000-0000-0000-0000-000000000040';
const RESOLVED_CLINICIAN = '70000000-0000-0000-0000-000000000099';
const STAFF_ID = 'DR-950-1';

/** The kind the tenant marked: STRUCTURED, cardinality ONE, one string property. */
const KIND_KEY = 'vitals';
const IDENTITY_FIELD = 'consultant_id';

const DEFINITION = {
  schemaVersion: '1.0',
  kinds: [
    {
      key: KIND_KEY,
      label: 'Vitals',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      userIdentity: { field: IDENTITY_FIELD },
      fields: {
        type: 'object',
        properties: { [IDENTITY_FIELD]: { type: 'string' }, heartRate: { type: 'number' } },
      },
    },
  ],
  outputs: [],
};

/** The same schema WITHOUT the marker — the "tenant has not opted in" case. */
const DEFINITION_WITHOUT_MARKER = {
  ...DEFINITION,
  kinds: [{ ...DEFINITION.kinds[0], userIdentity: undefined }],
};

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

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('ConsultationService.getOrCreate — the context-schema user identity', () => {
  let consultationRepository: any;
  let departmentRepository: any;
  let userRoleAssignmentRepository: any;
  let userDepartmentRepository: any;
  let userRepository: any;
  let policyEngine: any;
  let contextSchemaService: any;
  let userIdentityService: any;

  /**
   * `principal: 'serviceAccount'` puts a MACHINE on its own CLS key and leaves `user` null —
   * exactly what `UnifiedAuthGuard` does, and the whole reason `doctorId` has to come from
   * somewhere other than the principal.
   */
  const buildService = (principal: 'serviceAccount' | 'user') =>
    new ConsultationService(
      consultationRepository,
      departmentRepository,
      userRoleAssignmentRepository,
      userDepartmentRepository,
      userRepository,
      { emit: vi.fn() } as any,
      {
        get: vi.fn((key: string) => {
          if (key === 'tenantId') return TENANT;
          if (key === 'user') return principal === 'user' ? { id: HUMAN_CALLER, tenantId: TENANT } : null;
          if (key === 'serviceAccount') return principal === 'serviceAccount' ? { id: SVC_ACCOUNT, scopes: [] } : null;
          return null;
        }),
        set: vi.fn(),
      } as any,
      // entitlements, harnessAudit, tenantSettings, workflowDispatch, consentGrant,
      // workflowDefinitionRepository — then the three this block needs.
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      policyEngine as any,
      contextSchemaService as any,
      userIdentityService as any,
    );

  const openRequest = (overrides: Partial<OpenConsultationRequest> = {}): OpenConsultationRequest =>
    ({
      patientId: 'p-1',
      departmentId: DEPARTMENT,
      context: { [KIND_KEY]: { [IDENTITY_FIELD]: STAFF_ID, heartRate: 72 } },
      ...overrides,
    }) as OpenConsultationRequest;

  beforeEach(() => {
    vi.clearAllMocks();
    consultationRepository = {
      findByUniqueKey: vi.fn().mockResolvedValue(null),
      findWithRelations: vi.fn().mockResolvedValue(null),
      create: vi.fn(async (entity: unknown) => entity),
    };
    departmentRepository = { findById: vi.fn().mockResolvedValue({ id: DEPARTMENT, tenantId: TENANT }) };
    userRoleAssignmentRepository = {
      findFirst: vi.fn().mockResolvedValue({ id: 'ura-1', tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED }),
    };
    userDepartmentRepository = {
      findFirst: vi.fn().mockResolvedValue({ id: 'ud-1', tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED }),
    };
    userRepository = { findFirst: vi.fn().mockResolvedValue({ id: RESOLVED_CLINICIAN, isServiceAccount: false }) };
    policyEngine = { buildAbility: vi.fn().mockResolvedValue({ can: vi.fn().mockReturnValue(true) }) };
    contextSchemaService = {
      validateContextPayload: vi.fn().mockResolvedValue({ kindKey: KIND_KEY, primitive: 'STRUCTURED', contextSchemaVersionId: 'ver-1' }),
      getEffectiveBundle: vi.fn().mockResolvedValue({
        schemaId: 'schema-1',
        versionNumber: 3,
        contextSchemaVersionId: 'ver-1',
        definition: DEFINITION,
      }),
    };
    userIdentityService = { resolveOrProvision: vi.fn().mockResolvedValue({ userId: RESOLVED_CLINICIAN, provisioned: true }) };
  });

  // ── 1. The payload is checked first ───────────────────────────────────────

  it('reports EVERY schema problem at once as 400 CONTEXT_SCHEMA_VIOLATION, and writes nothing', async () => {
    contextSchemaService.validateContextPayload
      .mockRejectedValueOnce(new BadRequestException({ message: 'bad vitals', problems: ['heartRate: must be a number'] }))
      .mockRejectedValueOnce(new BadRequestException("Context schema version 3 does not declare a kind 'nonsense'."));

    const request = openRequest({ context: { [KIND_KEY]: { heartRate: 'seventy' }, nonsense: {} } as Record<string, unknown> });

    await expect(buildService('serviceAccount').getOrCreate(request, null as unknown as string)).rejects.toMatchObject({
      response: {
        code: 'CONTEXT_SCHEMA_VIOLATION',
        problems: [`${KIND_KEY}: heartRate: must be a number`, "nonsense: Context schema version 3 does not declare a kind 'nonsense'."],
      },
    });
    // A violation is a 400 about the payload — never a 404 about a clinician, and never a row.
    expect(consultationRepository.create).not.toHaveBeenCalled();
    expect(userIdentityService.resolveOrProvision).not.toHaveBeenCalled();
  });

  it('does not disguise an infrastructure failure as a payload problem', async () => {
    contextSchemaService.validateContextPayload.mockRejectedValue(new Error('vault unreachable'));

    await expect(buildService('serviceAccount').getOrCreate(openRequest(), null as unknown as string)).rejects.toThrow('vault unreachable');
  });

  // ── 2. Identity → doctorId ────────────────────────────────────────────────

  it('resolves the marked field to a user and records THEM as the doctor', async () => {
    const saved = await buildService('serviceAccount').getOrCreate(openRequest(), null as unknown as string);

    expect(userIdentityService.resolveOrProvision).toHaveBeenCalledWith({
      tenantId: TENANT,
      staffId: STAFF_ID,
      departmentId: DEPARTMENT,
      provenance: {
        plane: 'consultation-open',
        kindKey: KIND_KEY,
        field: IDENTITY_FIELD,
        serviceAccountId: SVC_ACCOUNT,
        schemaId: 'schema-1',
        versionNumber: 3,
      },
    });
    expect(consultationRepository.create).toHaveBeenCalledWith(expect.objectContaining({ doctorId: RESOLVED_CLINICIAN }));
    expect(saved).toBeDefined();
    // The machine is never the doctor. That is the whole point.
    expect(consultationRepository.create).not.toHaveBeenCalledWith(expect.objectContaining({ doctorId: SVC_ACCOUNT }));
  });

  it('still asks whether the RESOLVED clinician may own a consultation — a provisioned user is no more proven than a named one', async () => {
    await buildService('serviceAccount').getOrCreate(openRequest(), null as unknown as string);

    expect(policyEngine.buildAbility).toHaveBeenCalledWith({ userId: RESOLVED_CLINICIAN, tenantId: TENANT });
  });

  it('validates against the DEPARTMENT-effective schema — the same bundle the marker is read from', async () => {
    await buildService('serviceAccount').getOrCreate(openRequest(), null as unknown as string);

    expect(contextSchemaService.validateContextPayload).toHaveBeenCalledWith(
      expect.objectContaining({ kindKey: KIND_KEY, departmentId: DEPARTMENT }),
    );
    expect(contextSchemaService.getEffectiveBundle).toHaveBeenCalledWith(DEPARTMENT);
  });

  it('leaves the clinician unresolved when the effective schema declares no marker', async () => {
    contextSchemaService.getEffectiveBundle.mockResolvedValue({ schemaId: 'schema-1', versionNumber: 3, definition: DEFINITION_WITHOUT_MARKER });

    await expect(buildService('serviceAccount').getOrCreate(openRequest(), null as unknown as string)).rejects.toMatchObject({
      response: { code: 'CLINICIAN_REQUIRED' },
    });
    expect(userIdentityService.resolveOrProvision).not.toHaveBeenCalled();
  });

  // ── 3. Agreement (D-7) ────────────────────────────────────────────────────

  it('accepts `clinicianUserId` and the identity value when they AGREE, resolving once', async () => {
    userIdentityService.resolveOrProvision.mockResolvedValue({ userId: NAMED_CLINICIAN, provisioned: false });

    await buildService('serviceAccount').getOrCreate(openRequest({ clinicianUserId: NAMED_CLINICIAN }), NAMED_CLINICIAN);

    expect(userIdentityService.resolveOrProvision).toHaveBeenCalledTimes(1);
    expect(consultationRepository.create).toHaveBeenCalledWith(expect.objectContaining({ doctorId: NAMED_CLINICIAN }));
  });

  it('refuses 400 CLINICIAN_MISMATCH when they name two different clinicians', async () => {
    await expect(
      buildService('serviceAccount').getOrCreate(openRequest({ clinicianUserId: NAMED_CLINICIAN }), NAMED_CLINICIAN),
    ).rejects.toMatchObject({ response: { code: 'CLINICIAN_MISMATCH' } });
    expect(consultationRepository.create).not.toHaveBeenCalled();
  });

  it('keeps `clinicianUserId` working on its own — a TASK-933 integrator sends no context at all', async () => {
    await buildService('serviceAccount').getOrCreate(
      { patientId: 'p-1', departmentId: DEPARTMENT, clinicianUserId: NAMED_CLINICIAN } as OpenConsultationRequest,
      NAMED_CLINICIAN,
    );

    expect(contextSchemaService.validateContextPayload).not.toHaveBeenCalled();
    expect(userIdentityService.resolveOrProvision).not.toHaveBeenCalled();
    expect(consultationRepository.create).toHaveBeenCalledWith(expect.objectContaining({ doctorId: NAMED_CLINICIAN }));
  });

  it('refuses 400 CLINICIAN_REQUIRED when a machine identifies nobody by either route', async () => {
    const bare = { patientId: 'p-1', departmentId: DEPARTMENT } as OpenConsultationRequest;

    await expect(buildService('serviceAccount').getOrCreate(bare, null as unknown as string)).rejects.toMatchObject({
      response: { code: 'CLINICIAN_REQUIRED' },
    });
  });

  // ── 4. A human is never resolved from a body field (D-5) ──────────────────

  it('validates the context a HUMAN caller sends but opens for the CALLER, resolving nobody', async () => {
    userRepository.findFirst.mockResolvedValue({ id: HUMAN_CALLER, isServiceAccount: false });

    await buildService('user').getOrCreate(openRequest(), HUMAN_CALLER);

    expect(contextSchemaService.validateContextPayload).toHaveBeenCalledTimes(1);
    expect(userIdentityService.resolveOrProvision).not.toHaveBeenCalled();
    // TASK-951: the effective bundle IS read for every caller now — department / visit-type / external-ref
    // markers and PRE-item persistence apply to humans too. Only IDENTITY resolution stays machine-only,
    // which the `resolveOrProvision` assertion above still pins.
    expect(consultationRepository.create).toHaveBeenCalledWith(expect.objectContaining({ doctorId: HUMAN_CALLER }));
    // ...and nothing asks whether the caller may own a consultation: `@Authorize` already did.
    expect(policyEngine.buildAbility).not.toHaveBeenCalled();
  });

  // ── 5. The identity service owns its own failures ─────────────────────────

  it('propagates USER_IDENTITY_UNKNOWN untouched — this layer never re-labels it', async () => {
    userIdentityService.resolveOrProvision.mockRejectedValue(
      new NotFoundException({ message: 'No user in this tenant carries that staff identifier.', code: 'USER_IDENTITY_UNKNOWN' }),
    );

    await expect(buildService('serviceAccount').getOrCreate(openRequest(), null as unknown as string)).rejects.toMatchObject({
      response: { code: 'USER_IDENTITY_UNKNOWN' },
    });
    expect(consultationRepository.create).not.toHaveBeenCalled();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
