/**
 * TASK-951 §D-2…D-6 — what `open` MAPS out of the context payload, not merely validates.
 *
 * TASK-950 established that a tenant can MARK one field of its consultation context schema and
 * have HOPE act on it (the clinician's staff id). This ticket is that idea taken to its
 * conclusion: the owner's ask is that an integrator states the facts of the encounter ONCE, in
 * the vocabulary its own schema declares, and HOPE turns each of them into the thing it means —
 * a department, a visit type, a durable external reference, persisted context, and a workflow
 * trigger that can see all of it.
 *
 * Five properties are pinned here, each because it is a way the feature could be WRONG rather
 * than merely incomplete:
 *
 *  1. THE DEPARTMENT IS RESOLVED BEFORE THE REST IS VALIDATED (D-2). It selects the schema, so
 *     getting the order wrong would validate a payload against one tenant schema and write the
 *     consultation under another. A caller that states it twice and disagrees is a 400, never a
 *     silent precedence; an unknown department is a 404, an ambiguous NAME a 400.
 *  2. THE STATED VISIT TYPE OUTRANKS THE PARENT LINK (D-3), alias-matched through the one
 *     platform vocabulary. An unmatchable value is a 400 — quietly documenting the encounter
 *     under the other visit type's prompt is a wrong-prompt clinical failure.
 *  3. THE EXTERNAL REFERENCE IS A LABEL, NOT A KEY (D-4). Folding it into the get-or-create tuple
 *     would turn a re-open into a second consultation the moment a client regenerated its id.
 *  4. WHAT WAS VALIDATED IS PERSISTED (D-5) — one STRUCTURED item per kind, plus one `CASE_NOTE`
 *     per materialized entry, written BEFORE dispatch so the warm-start pre-summary sees them.
 *  5. WHAT WAS VALIDATED REACHES THE GRAPH (D-6). Before this, `trigger.context.*` was empty for
 *     every consultation-open run, so a schema-bound trigger saw nothing a client sent.
 *
 * Marker DERIVATION itself (`openBindingsFromDefinition`) belongs to the grammar and is tested
 * there; this file feeds it real definitions and asserts what `open` does with the result, which
 * is also what makes the two halves prove they agree.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ContextItemType, ResourceStatusType } from '@arcaai/domains';
import { ConsultationService } from '../consultation.service';
import { OpenConsultationRequest } from '../dto/open-consultation.request';
import { CONSULTATION_EXTERNAL_REF_MARKER, CONSULTATION_VISIT_TYPE_MARKER, readRecordedVisitType } from '../open-markers';
import { DEFAULT_VISIT_TYPE_SERVICE } from '../../visit-type';

const TENANT = 'tenant-1';
const SVC_ACCOUNT = 'e0000000-0000-0000-0000-000000000001';
const HUMAN_CALLER = '70000000-0000-0000-0000-000000000010';
const CLINICIAN = '70000000-0000-0000-0000-000000000040';

const GEN_DEPARTMENT = '70000000-0000-0000-0001-000000000001';
const RHEUM_DEPARTMENT = '70000000-0000-0000-0001-000000000002';

const ENCOUNTER = 'encounter';
const VITALS = 'vitals';
const PRIOR_NOTES = 'previous_case_notes';

/** The scribe schema's shape: one marked STRUCTURED kind, plus two the client fills in. */
const definitionWith = (departmentBy: 'code' | 'name' = 'code') => ({
  schemaVersion: '1.0',
  kinds: [
    {
      key: ENCOUNTER,
      label: 'Encounter',
      primitive: 'STRUCTURED',
      phiClass: 'NON_PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      userIdentity: { field: 'doctor_id' },
      department: { field: departmentBy === 'code' ? 'department_code' : 'department_name', by: departmentBy },
      visitType: { field: 'visit_type' },
      externalRef: { field: 'event_id' },
      fields: {
        type: 'object',
        properties: {
          doctor_id: { type: 'string' },
          event_id: { type: 'string' },
          department_code: { type: 'string' },
          department_name: { type: 'string' },
          visit_type: { type: 'string' },
        },
      },
    },
    {
      key: VITALS,
      label: 'Vitals',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      fields: { type: 'object', properties: { heartRate: { type: 'number' } } },
    },
    {
      key: PRIOR_NOTES,
      label: 'Previous case notes',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: ['CLIENT'],
      materializeAs: 'CASE_NOTE',
      fields: { type: 'object', properties: { notes: { type: 'array' } } },
    },
  ],
  outputs: [],
});

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
describe('ConsultationService.getOrCreate — the TASK-951 open-time mappings', () => {
  let consultationRepository: any;
  let departmentRepository: any;
  let userRoleAssignmentRepository: any;
  let userDepartmentRepository: any;
  let userRepository: any;
  let policyEngine: any;
  let contextSchemaService: any;
  let userIdentityService: any;
  let contextService: any;
  let workflowDispatchService: any;

  const buildService = (principal: 'serviceAccount' | 'user' = 'serviceAccount') =>
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
      // entitlements, harnessAudit, tenantSettings
      undefined,
      undefined,
      undefined,
      workflowDispatchService as any,
      // consentGrant, workflowDefinitionRepository
      undefined,
      undefined,
      policyEngine as any,
      contextSchemaService as any,
      userIdentityService as any,
      // visitTypes — the shared stateless instance, exactly as an unwired composition resolves it
      DEFAULT_VISIT_TYPE_SERVICE,
      contextService as any,
    );

  const encounter = (overrides: Record<string, unknown> = {}) => ({
    doctor_id: 'DR-951-1',
    event_id: 'EVT-88213',
    department_code: 'GEN',
    visit_type: 'new-visit',
    ...overrides,
  });

  const openRequest = (overrides: Partial<OpenConsultationRequest> = {}): OpenConsultationRequest =>
    ({
      patientId: 'p-1',
      context: { [ENCOUNTER]: encounter() },
      ...overrides,
    }) as OpenConsultationRequest;

  /** The metadata the factory was asked to write — the row as it would be persisted. */
  const writtenMetadata = (): Record<string, unknown> => (consultationRepository.create.mock.calls[0][0] as any).metadata ?? {};

  beforeEach(() => {
    vi.clearAllMocks();
    consultationRepository = {
      findByUniqueKey: vi.fn().mockResolvedValue(null),
      findWithRelations: vi.fn().mockResolvedValue(null),
      create: vi.fn(async (entity: unknown) => entity),
    };
    departmentRepository = {
      // Echo the id asked for, so `assertParentInScope` accepts whichever department resolution
      // produced — the guard's own behaviour is TASK-933's and is not what this file pins.
      findById: vi.fn(async (id: string) => ({ id, tenantId: TENANT })),
      findByCode: vi.fn(async (_tenantId: string, code: string) => (code === 'GEN' ? { id: GEN_DEPARTMENT, tenantId: TENANT, code } : null)),
      findAllByTenant: vi.fn().mockResolvedValue([
        { id: GEN_DEPARTMENT, tenantId: TENANT, name: 'General Medicine' },
        { id: RHEUM_DEPARTMENT, tenantId: TENANT, name: 'Rheumatology' },
      ]),
    };
    userRoleAssignmentRepository = {
      findFirst: vi.fn().mockResolvedValue({ id: 'ura-1', tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED }),
    };
    userDepartmentRepository = {
      findFirst: vi.fn().mockResolvedValue({ id: 'ud-1', tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED }),
    };
    userRepository = { findFirst: vi.fn().mockResolvedValue({ id: CLINICIAN, isServiceAccount: false }) };
    policyEngine = { buildAbility: vi.fn().mockResolvedValue({ can: vi.fn().mockReturnValue(true) }) };
    contextSchemaService = {
      validateContextPayload: vi.fn(async ({ kindKey }: { kindKey: string }) => ({ kindKey, primitive: 'STRUCTURED', contextSchemaVersionId: 'ver-1' })),
      getEffectiveBundle: vi.fn().mockResolvedValue({ schemaId: 'schema-1', versionNumber: 3, definition: definitionWith('code') }),
    };
    userIdentityService = { resolveOrProvision: vi.fn().mockResolvedValue({ userId: CLINICIAN, provisioned: false }) };
    contextService = { addContext: vi.fn().mockResolvedValue({ id: 'ctx-1' }) };
    workflowDispatchService = {
      dispatchForConsultation: vi.fn().mockResolvedValue({ dispatched: false, source: 'platform-default', workflowDefinitionSlug: null, runId: null }),
      assertSelectableForConsultation: vi.fn().mockResolvedValue(undefined),
    };
  });

  // ── 1. Department (D-2) ───────────────────────────────────────────────────

  it('resolves the stated CODE to this tenant’s department and writes the consultation under it', async () => {
    await buildService().getOrCreate(openRequest(), null as unknown as string);

    expect(departmentRepository.findByCode).toHaveBeenCalledWith(TENANT, 'GEN');
    expect(consultationRepository.create).toHaveBeenCalledWith(expect.objectContaining({ departmentId: GEN_DEPARTMENT }));
  });

  it('validates every OTHER kind against the schema the RESOLVED department selects, not the request’s', async () => {
    await buildService().getOrCreate(
      openRequest({ context: { [ENCOUNTER]: encounter(), [VITALS]: { heartRate: 72 } } as Record<string, unknown> }),
      null as unknown as string,
    );

    // Pass 1 read the tenant default (no `departmentId` on the request); pass 2 re-read for the
    // department the payload named. Getting this backwards would check a payload against one
    // schema and write the consultation under another.
    expect(contextSchemaService.getEffectiveBundle).toHaveBeenNthCalledWith(1, undefined);
    expect(contextSchemaService.getEffectiveBundle).toHaveBeenNthCalledWith(2, GEN_DEPARTMENT);
    expect(contextSchemaService.validateContextPayload).toHaveBeenCalledWith(expect.objectContaining({ kindKey: VITALS, departmentId: GEN_DEPARTMENT }));
  });

  it('resolves a stated NAME when exactly one department carries it', async () => {
    contextSchemaService.getEffectiveBundle.mockResolvedValue({ schemaId: 'schema-1', versionNumber: 3, definition: definitionWith('name') });

    await buildService().getOrCreate(
      openRequest({ context: { [ENCOUNTER]: encounter({ department_name: 'rheumatology' }) } as Record<string, unknown> }),
      null as unknown as string,
    );

    // Case-insensitive: a roster's casing is not a reason to refuse an unambiguous department.
    expect(consultationRepository.create).toHaveBeenCalledWith(expect.objectContaining({ departmentId: RHEUM_DEPARTMENT }));
  });

  it('refuses 400 DEPARTMENT_AMBIGUOUS when two departments share the stated name', async () => {
    contextSchemaService.getEffectiveBundle.mockResolvedValue({ schemaId: 'schema-1', versionNumber: 3, definition: definitionWith('name') });
    departmentRepository.findAllByTenant.mockResolvedValue([
      { id: GEN_DEPARTMENT, tenantId: TENANT, name: 'General Medicine' },
      { id: RHEUM_DEPARTMENT, tenantId: TENANT, name: 'General Medicine' },
    ]);

    await expect(
      buildService().getOrCreate(
        openRequest({ context: { [ENCOUNTER]: encounter({ department_name: 'General Medicine' }) } as Record<string, unknown> }),
        null as unknown as string,
      ),
    ).rejects.toMatchObject({ response: { code: 'DEPARTMENT_AMBIGUOUS' } });
    expect(consultationRepository.create).not.toHaveBeenCalled();
  });

  it('answers 404 DEPARTMENT_UNKNOWN for a code this tenant does not carry', async () => {
    const failure = buildService().getOrCreate(
      openRequest({ context: { [ENCOUNTER]: encounter({ department_code: 'NOPE' }) } as Record<string, unknown> }),
      null as unknown as string,
    );

    // 404, not 403 and not 400: an unknown code and another tenant's code must be
    // indistinguishable, exactly as every other cross-aggregate reference is.
    await expect(failure).rejects.toBeInstanceOf(NotFoundException);
    await expect(failure).rejects.toMatchObject({ response: { code: 'DEPARTMENT_UNKNOWN' } });
    expect(consultationRepository.create).not.toHaveBeenCalled();
  });

  it('refuses 400 DEPARTMENT_MISMATCH when `departmentId` and the payload name two different departments', async () => {
    await expect(
      buildService().getOrCreate(openRequest({ departmentId: RHEUM_DEPARTMENT }), null as unknown as string),
    ).rejects.toMatchObject({ response: { code: 'DEPARTMENT_MISMATCH' } });
    expect(consultationRepository.create).not.toHaveBeenCalled();
  });

  it('accepts `departmentId` and the payload when they AGREE', async () => {
    await buildService().getOrCreate(openRequest({ departmentId: GEN_DEPARTMENT }), null as unknown as string);

    expect(consultationRepository.create).toHaveBeenCalledWith(expect.objectContaining({ departmentId: GEN_DEPARTMENT }));
  });

  // ── 2. Visit type (D-3) ───────────────────────────────────────────────────

  it('records the stated visit type on the row', async () => {
    await buildService().getOrCreate(openRequest(), null as unknown as string);

    expect(writtenMetadata()[CONSULTATION_VISIT_TYPE_MARKER]).toBe('new-visit');
  });

  it.each([
    ['referral', 'new-visit'],
    ['new-patient', 'new-visit'],
    ['follow-up', 'revisit'],
    ['Re-Visit', 'revisit'],
  ])('alias-matches %s onto the catalogue key %s', async (stated, expected) => {
    await buildService().getOrCreate(
      openRequest({ context: { [ENCOUNTER]: encounter({ visit_type: stated }) } as Record<string, unknown> }),
      null as unknown as string,
    );

    expect(writtenMetadata()[CONSULTATION_VISIT_TYPE_MARKER]).toBe(expected);
  });

  it('refuses 400 VISIT_TYPE_INVALID rather than silently falling back to the parent-link derivation', async () => {
    await expect(
      buildService().getOrCreate(
        openRequest({ context: { [ENCOUNTER]: encounter({ visit_type: 'emergency' }) } as Record<string, unknown> }),
        null as unknown as string,
      ),
    ).rejects.toMatchObject({ response: { code: 'VISIT_TYPE_INVALID' } });
    expect(consultationRepository.create).not.toHaveBeenCalled();
  });

  it('threads the RECORDED visit type into dispatch, so the selector tag follows the caller’s statement', async () => {
    await buildService().getOrCreate(
      openRequest({ context: { [ENCOUNTER]: encounter({ visit_type: 'revisit' }) } as Record<string, unknown> }),
      null as unknown as string,
    );

    expect(workflowDispatchService.dispatchForConsultation).toHaveBeenCalledWith(expect.objectContaining({ visitType: 'revisit' }));
  });

  it('leaves the derivation untouched when the schema declares no visit-type binding', async () => {
    const definition = definitionWith('code');
    delete (definition.kinds[0] as Record<string, unknown>).visitType;
    contextSchemaService.getEffectiveBundle.mockResolvedValue({ schemaId: 'schema-1', versionNumber: 3, definition });

    await buildService().getOrCreate(openRequest(), null as unknown as string);

    expect(writtenMetadata()[CONSULTATION_VISIT_TYPE_MARKER]).toBeUndefined();
    expect(workflowDispatchService.dispatchForConsultation).toHaveBeenCalledWith(expect.objectContaining({ visitType: null }));
  });

  /**
   * The composition every `forConsultation` call site now performs, table-driven.
   *
   * The eleven call sites live in eight different services, so asserting each one here would mean
   * constructing eight services to re-prove one rule. What they SHARE is this expression, and it
   * is the expression that carries the behaviour: a recorded value wins, an unmatchable one falls
   * back to the parent link (never to a guess), and absent metadata is byte-identical to before.
   */
  it.each([
    ['new-visit', false, 'new-visit'],
    ['revisit', false, 'revisit'],
    ['new-visit', true, 'new-visit'],
    ['referral', true, 'new-visit'],
    [null, true, 'revisit'],
    [null, false, 'new-visit'],
    ['not-a-visit-type', true, 'revisit'],
  ])('recorded %s with isFollowUp=%s selects %s at every call site', (recorded, isFollowUp, expected) => {
    const metadata = recorded === null ? {} : { [CONSULTATION_VISIT_TYPE_MARKER]: recorded };

    const selected = DEFAULT_VISIT_TYPE_SERVICE.forConsultation(TENANT, {
      recorded: readRecordedVisitType(metadata),
      isFollowUp: isFollowUp as boolean,
    });

    expect(selected.key).toBe(expected);
  });

  // ── 3. External reference (D-4) ───────────────────────────────────────────

  it('records the external reference WITHOUT changing the re-open idempotency key', async () => {
    await buildService().getOrCreate(openRequest(), null as unknown as string);

    expect(writtenMetadata()[CONSULTATION_EXTERNAL_REF_MARKER]).toBe('EVT-88213');
    // Four arguments, and the event id is not one of them: a client that regenerates its event id
    // must still re-open the SAME consultation.
    expect(consultationRepository.findByUniqueKey).toHaveBeenCalledWith(TENANT, 'p-1', expect.any(Date), CLINICIAN);
  });

  it('preserves caller-supplied metadata alongside every marker', async () => {
    await buildService().getOrCreate(openRequest({ metadata: { source: 'alaas', alaasSessionId: 'S-1' } }), null as unknown as string);

    expect(writtenMetadata()).toMatchObject({
      source: 'alaas',
      alaasSessionId: 'S-1',
      [CONSULTATION_VISIT_TYPE_MARKER]: 'new-visit',
      [CONSULTATION_EXTERNAL_REF_MARKER]: 'EVT-88213',
    });
  });

  // ── 4. Persistence (D-5) ──────────────────────────────────────────────────

  it('persists every validated kind as a STRUCTURED context item carrying its kindKey', async () => {
    await buildService().getOrCreate(
      openRequest({ context: { [ENCOUNTER]: encounter(), [VITALS]: { heartRate: 72 } } as Record<string, unknown> }),
      null as unknown as string,
    );

    expect(contextService.addContext).toHaveBeenCalledWith(
      'new-consultation-id',
      expect.objectContaining({ type: ContextItemType.STRUCTURED, kindKey: ENCOUNTER, payload: encounter() }),
    );
    expect(contextService.addContext).toHaveBeenCalledWith(
      'new-consultation-id',
      expect.objectContaining({ type: ContextItemType.STRUCTURED, kindKey: VITALS, payload: { heartRate: 72 } }),
    );
  });

  it('materializes a marked kind into one CASE_NOTE per note, before dispatch', async () => {
    const notes = [
      { date: '2026-01-02', title: 'Cardiology review', text: 'Stable on current dose.' },
      { date: '2026-02-11', text: 'No new complaints.' },
    ];

    await buildService().getOrCreate(
      openRequest({ context: { [ENCOUNTER]: encounter(), [PRIOR_NOTES]: { notes } } as Record<string, unknown> }),
      null as unknown as string,
    );

    const caseNotes = contextService.addContext.mock.calls.filter(([, request]: [string, any]) => request.type === ContextItemType.CASE_NOTE);
    expect(caseNotes).toHaveLength(2);
    // `title` and `text` are joined: `ContextItem` has ONE content column, and every reader of a
    // case note reads exactly that column.
    expect(caseNotes[0][1].content).toBe('Cardiology review\nStable on current dose.');
    expect(caseNotes[1][1].content).toBe('No new complaints.');
    expect(caseNotes[0][1].metadata).toMatchObject({ origin: 'open.context', kindKey: PRIOR_NOTES, index: 0 });

    // Order is the requirement, not an accident: the warm-start pre-summary reads CASE_NOTE items,
    // so a graph dispatched first would warm-start on nothing.
    const lastWrite = contextService.addContext.mock.invocationCallOrder.at(-1)!;
    const dispatch = workflowDispatchService.dispatchForConsultation.mock.invocationCallOrder[0];
    expect(lastWrite).toBeLessThan(dispatch);
  });

  it('opens the consultation even when a context item cannot be persisted', async () => {
    contextService.addContext.mockRejectedValue(new Error('transit unavailable'));

    // The row exists and `ResourceCreated` has already been broadcast by this point, so throwing
    // would answer 500 for a consultation that exists — and the retry would return that same
    // consultation without re-attempting the write.
    await expect(buildService().getOrCreate(openRequest(), null as unknown as string)).resolves.toBeDefined();
    expect(workflowDispatchService.dispatchForConsultation).toHaveBeenCalled();
  });

  it('persists for a HUMAN caller too — validation ran for them, so the values are just as real', async () => {
    await buildService('user').getOrCreate(openRequest(), HUMAN_CALLER);

    expect(contextService.addContext).toHaveBeenCalledWith('new-consultation-id', expect.objectContaining({ kindKey: ENCOUNTER }));
    // …and their own identity still wins: the marked field is content for a human (TASK-950 D-5).
    expect(userIdentityService.resolveOrProvision).not.toHaveBeenCalled();
    expect(consultationRepository.create).toHaveBeenCalledWith(expect.objectContaining({ doctorId: HUMAN_CALLER }));
  });

  it('persists nothing on a RE-open — get-or-create must not append a second copy', async () => {
    consultationRepository.findByUniqueKey.mockResolvedValue({
      id: 'existing-id',
      tenantId: TENANT,
      doctorId: CLINICIAN,
      patientId: 'p-1',
      appointmentDate: new Date('2026-01-29'),
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
    });

    await buildService().getOrCreate(openRequest(), null as unknown as string);

    expect(contextService.addContext).not.toHaveBeenCalled();
    expect(workflowDispatchService.dispatchForConsultation).not.toHaveBeenCalled();
  });

  // ── 5. The run payload (D-6) ──────────────────────────────────────────────

  it('threads the validated context into the run payload so `trigger.context.*` resolves', async () => {
    const context = { [ENCOUNTER]: encounter(), [VITALS]: { heartRate: 72 } };

    await buildService().getOrCreate(openRequest({ context } as Partial<OpenConsultationRequest>), null as unknown as string);

    expect(workflowDispatchService.dispatchForConsultation).toHaveBeenCalledWith(expect.objectContaining({ authoredContext: context }));
  });

  it('sends no authored context when the caller sent none', async () => {
    await buildService('user').getOrCreate({ patientId: 'p-1', departmentId: GEN_DEPARTMENT } as OpenConsultationRequest, HUMAN_CALLER);

    expect(workflowDispatchService.dispatchForConsultation).toHaveBeenCalledWith(expect.objectContaining({ authoredContext: undefined }));
    expect(contextSchemaService.getEffectiveBundle).not.toHaveBeenCalled();
  });

  // ── 6. The TASK-950 contract still holds ──────────────────────────────────

  it('still resolves the clinician from the identity field, now against the RESOLVED department', async () => {
    await buildService().getOrCreate(openRequest(), null as unknown as string);

    expect(userIdentityService.resolveOrProvision).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, staffId: 'DR-951-1', departmentId: GEN_DEPARTMENT }),
    );
    expect(consultationRepository.create).toHaveBeenCalledWith(expect.objectContaining({ doctorId: CLINICIAN }));
  });

  it('still reports every schema problem at once, and writes nothing', async () => {
    contextSchemaService.validateContextPayload.mockRejectedValue(new BadRequestException({ message: 'bad', problems: ['visit_type: required'] }));

    await expect(buildService().getOrCreate(openRequest(), null as unknown as string)).rejects.toMatchObject({
      response: { code: 'CONTEXT_SCHEMA_VIOLATION' },
    });
    expect(consultationRepository.create).not.toHaveBeenCalled();
    expect(contextService.addContext).not.toHaveBeenCalled();
    // A payload the department binding's kind cannot satisfy leaves the department unresolved and
    // falls through to the FULL report — never a half-report naming only that one kind.
    expect(departmentRepository.findByCode).not.toHaveBeenCalled();
  });
});
