/**
 * The context an integrator sends at open, on an encounter APPEND.
 *
 * A broker re-sends the whole context on every visit of the episode. Before, each append stored
 * every kind again — the same 13.7 kB of structured context three times over three encounters.
 * Now a kind whose canonical payload equals the live item of that kind is skipped, and a kind that
 * CHANGED is stored once more, stamped with the new encounter. A new consultation still stores
 * everything it was sent, stamped with encounter 1.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConsultationEntity, ConsultationProcessing, ConsultationStatus, ContextItemType, ResourceStatusType } from '@arcaai/domains';
import { canonicalJson } from '../../../consultation-context-schema/context-schema-definition';
import { ConsultationService } from '../consultation.service';
import { encounterServiceDouble, lifecycleDouble, type EncounterServiceDouble } from './consultation-service.fixture';
import { OpenConsultationRequest } from '../dto/open-consultation.request';
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
describe('ConsultationService.getOrCreate — open context on an encounter append', () => {
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
  let encounters: EncounterServiceDouble;

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
      encounters as any,
      lifecycleDouble(), // lifecycle
      // entitlements, tenantSettings
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

  beforeEach(() => {
    vi.clearAllMocks();
    consultationRepository = {
      // TASK-1045 — the open key (no non-closed consultation) and the closed one to chain to (none).
      findOpenByKey: vi.fn().mockResolvedValue(null),
      findLatestClosedByKey: vi.fn().mockResolvedValue(null),
      findWithRelations: vi.fn().mockResolvedValue(null),
      create: vi.fn(async (entity: unknown) => entity),
    };
    // The encounters of the episode: a payload carrying `event_id` is matched by its encounter ref
    // first. Default: no encounter carries it.
    encounters = encounterServiceDouble(consultationRepository);
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
      validateContextPayload: vi.fn(async ({ kindKey }: { kindKey: string }) => ({
        kindKey,
        primitive: 'STRUCTURED',
        contextSchemaVersionId: 'ver-1',
      })),
      getEffectiveBundle: vi.fn().mockResolvedValue({ schemaId: 'schema-1', versionNumber: 3, definition: definitionWith('code') }),
    };
    userIdentityService = { resolveOrProvision: vi.fn().mockResolvedValue({ userId: CLINICIAN, provisioned: false }) };
    contextService = { addContext: vi.fn().mockResolvedValue({ id: 'ctx-1' }) };
    workflowDispatchService = {
      dispatchForConsultation: vi
        .fn()
        .mockResolvedValue({ dispatched: false, source: 'platform-default', workflowDefinitionSlug: null, runId: null }),
      assertSelectableForConsultation: vi.fn().mockResolvedValue(undefined),
    };
  });

  const openConsultation = (seq = 1) =>
    new ConsultationEntity({
      id: 'open-consultation-id',
      tenantId: TENANT,
      patientId: 'p-1',
      doctorId: CLINICIAN,
      appointmentDate: new Date('2026-10-05'),
      departmentId: GEN_DEPARTMENT,
      parentConsultationId: null,
      metadata: null,
      externalRef: 'EVT-1',
      status: ConsultationStatus.OPEN,
      processing: ConsultationProcessing.IDLE,
      currentEncounterSeq: seq,
      lastActivityAt: new Date('2026-10-05T08:00:00Z'),
      degradedReasons: [],
      createdAt: new Date('2026-10-05T08:00:00Z'),
      updatedAt: new Date('2026-10-05T08:00:00Z'),
      createdBy: CLINICIAN,
      updatedBy: null,
      resourceStatus: ResourceStatusType.ENABLED,
      version: 2,
    } as any);

  /** The STRUCTURED items stored at encounter 1, as the context service answers them (decrypted). */
  const liveStructured = (vitals: Record<string, unknown>) => [
    {
      id: 'ci-enc',
      type: ContextItemType.STRUCTURED,
      kindKey: ENCOUNTER,
      content: canonicalJson(encounter({ event_id: 'EVT-1' })),
      createdAt: '2026-10-05T08:00:00Z',
    },
    { id: 'ci-vit', type: ContextItemType.STRUCTURED, kindKey: VITALS, content: canonicalJson(vitals), createdAt: '2026-10-05T08:00:01Z' },
  ];

  const structuredWrites = () =>
    contextService.addContext.mock.calls
      .filter(([, request]: [string, any]) => request.type === ContextItemType.STRUCTURED)
      .map(([, request]: [string, any]) => request);

  const appendWith = async (vitals: Record<string, unknown>) => {
    consultationRepository.findOpenByKey.mockResolvedValue(openConsultation(1));
    encounters.appendEncounter.mockImplementation(async () => ({ consultation: openConsultation(2), encounter: { seq: 2 } }));
    contextService.getContextItems = vi.fn().mockResolvedValue(liveStructured({ heartRate: 72 }));
    await buildService().getOrCreate(
      openRequest({ context: { [ENCOUNTER]: encounter({ event_id: 'EVT-2' }), [VITALS]: vitals } as Record<string, unknown> }),
      null as unknown as string,
    );
  };

  it('an append that re-sends IDENTICAL context stores no new STRUCTURED row for it', async () => {
    await appendWith({ heartRate: 72 });

    expect(encounters.appendEncounter).toHaveBeenCalledTimes(1);
    expect(contextService.getContextItems).toHaveBeenCalledWith('open-consultation-id', { type: ContextItemType.STRUCTURED });
    // Vitals are unchanged: nothing. The encounter kind carries the new visit's id: one row.
    expect(structuredWrites().map((request: any) => request.kindKey)).toEqual([ENCOUNTER]);
  });

  it('a kind that CHANGED is stored once, stamped with the new encounter', async () => {
    await appendWith({ heartRate: 90 });

    const vitals = structuredWrites().filter((request: any) => request.kindKey === VITALS);
    expect(vitals).toHaveLength(1);
    expect(vitals[0]).toMatchObject({ payload: { heartRate: 90 }, encounterSeq: 2 });
    expect(structuredWrites().find((request: any) => request.kindKey === ENCOUNTER)).toMatchObject({ encounterSeq: 2 });
  });

  it('a key order the client changed is still the same payload', async () => {
    consultationRepository.findOpenByKey.mockResolvedValue(openConsultation(1));
    encounters.appendEncounter.mockImplementation(async () => ({ consultation: openConsultation(2), encounter: { seq: 2 } }));
    contextService.getContextItems = vi.fn().mockResolvedValue(liveStructured({ heartRate: 72, systolic: 120 }));

    await buildService().getOrCreate(
      openRequest({
        context: { [ENCOUNTER]: encounter({ event_id: 'EVT-2' }), [VITALS]: { systolic: 120, heartRate: 72 } } as Record<string, unknown>,
      }),
      null as unknown as string,
    );

    expect(structuredWrites().map((request: any) => request.kindKey)).toEqual([ENCOUNTER]);
  });

  it('an unreadable live context degrades to storing everything (a duplicate beats a missing kind)', async () => {
    consultationRepository.findOpenByKey.mockResolvedValue(openConsultation(1));
    encounters.appendEncounter.mockImplementation(async () => ({ consultation: openConsultation(2), encounter: { seq: 2 } }));
    contextService.getContextItems = vi.fn().mockRejectedValue(new Error('transit unavailable'));

    await buildService().getOrCreate(
      openRequest({ context: { [ENCOUNTER]: encounter({ event_id: 'EVT-2' }), [VITALS]: { heartRate: 72 } } as Record<string, unknown> }),
      null as unknown as string,
    );

    expect(
      structuredWrites()
        .map((request: any) => request.kindKey)
        .sort(),
    ).toEqual([ENCOUNTER, VITALS].sort());
  });

  it('a NEW consultation stores every kind it was sent, stamped with encounter 1, without reading the live context', async () => {
    contextService.getContextItems = vi.fn();

    await buildService().getOrCreate(
      openRequest({ context: { [ENCOUNTER]: encounter(), [VITALS]: { heartRate: 72 } } as Record<string, unknown> }),
      null as unknown as string,
    );

    expect(contextService.getContextItems).not.toHaveBeenCalled();
    expect(structuredWrites()).toHaveLength(2);
    for (const request of structuredWrites()) expect(request.encounterSeq).toBe(1);
  });
});
