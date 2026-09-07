/**
 * workflow SELECTION at consultation open, and DISCOVERY of the
 * workflow that ended up governing.
 *
 * The load-bearing property here is ORDER: the selector is authorized BEFORE any
 * row is written. A gate that ran inside `ConsultationWorkflowDispatchService`
 * would be useless — that service is best-effort by contract and swallows its
 * own failures, so an unauthorized slug would silently degrade to "the cascade
 * chose something else" and the caller would get a 201 for a request the server
 * refused. Refusing before the write is what makes the refusal observable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConsultationService } from '../consultation.service';
import { ResourceStatusType } from '@arcaai/domains';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    ConsultationFactory: {
      CreateNewVisit: vi.fn((data) => ({ ...data, id: 'new-consultation-id', version: 1, createdAt: new Date(), updatedAt: new Date() })),
      CreateRevisit: vi.fn((data) => ({ ...data, id: 'new-revisit-id', version: 1, createdAt: new Date(), updatedAt: new Date() })),
    },
  };
});

const TENANT = 'tenant-1';
const SLUG = 'caller_picked_v1';

function makeMocks() {
  const consultationRepository = {
    findByUniqueKey: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null),
    findWithRelations: vi.fn().mockResolvedValue(null),
    create: vi.fn(async (entity: unknown) => entity),
  };
  const clsService = {
    get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-id-1' } : null)),
    set: vi.fn(),
  };
  return {
    consultationRepository,
    departmentRepository: { findById: vi.fn().mockResolvedValue({ id: 'dept-1', tenantId: TENANT }) },
    userRoleAssignmentRepository: { findFirst: vi.fn().mockResolvedValue({ id: 'ura-1', tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED }) },
    userDepartmentRepository: { findFirst: vi.fn().mockResolvedValue({ id: 'ud-1', tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED }) },
    userRepository: { findFirst: vi.fn().mockResolvedValue({ id: 'doctor-1', isServiceAccount: false }) },
    eventEmitter: { emit: vi.fn() },
    clsService,
    workflowDispatchService: {
      assertSelectableForConsultation: vi.fn().mockResolvedValue(undefined),
      dispatchForConsultation: vi.fn().mockResolvedValue({ dispatched: true, source: 'caller-selected', workflowDefinitionSlug: SLUG, runId: 'run-1', governanceRecorded: true, sttPipelineId: null }),
    },
    workflowDefinitionRepository: {
      findPublishedBySlug: vi.fn().mockResolvedValue({ slug: SLUG, name: 'Caller Picked', description: 'a graph', paletteKey: 'consultation', versionNumber: 3 }),
    },
  };
}

function makeService(m: ReturnType<typeof makeMocks>) {
  return new ConsultationService(
    m.consultationRepository as never,
    m.departmentRepository as never,
    m.userRoleAssignmentRepository as never,
    m.userDepartmentRepository as never,
    m.userRepository as never,
    m.eventEmitter as never,
    m.clsService as never,
    undefined, // entitlements
    undefined, // harnessAudit
    undefined, // tenantSettings
    m.workflowDispatchService as never,
    undefined, // consentGrantService
    m.workflowDefinitionRepository as never,
  );
}

describe('ConsultationService.getOrCreate — workflow selection (OD-1)', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('authorizes the selection against the CLS tenant, never a caller-supplied one', async () => {
    await makeService(m).getOrCreate({ patientId: 'p-1', workflowDefinitionSlug: SLUG } as never, 'doctor-1');
    expect(m.workflowDispatchService.assertSelectableForConsultation).toHaveBeenCalledWith(TENANT, SLUG);
  });

  it('threads the authorized selection into the dispatch input', async () => {
    await makeService(m).getOrCreate({ patientId: 'p-1', workflowDefinitionSlug: SLUG } as never, 'doctor-1');
    expect(m.workflowDispatchService.dispatchForConsultation).toHaveBeenCalledWith(expect.objectContaining({ workflowDefinitionSlug: SLUG }));
  });

  it('does NOT invoke the gate when no selector is supplied — the cascade path is untouched', async () => {
    await makeService(m).getOrCreate({ patientId: 'p-1' } as never, 'doctor-1');
    expect(m.workflowDispatchService.assertSelectableForConsultation).not.toHaveBeenCalled();
    expect(m.workflowDispatchService.dispatchForConsultation).toHaveBeenCalledWith(expect.objectContaining({ workflowDefinitionSlug: undefined }));
  });

  // TASK-891 — the dispatcher derives the reserved `visit-type:<key>` selector tag
  // (OD-2/OD-3) from the consultation's own parent link. Threaded in here rather than
  // re-read by the dispatcher: dispatch is best-effort by contract, and a DB read there
  // would change its failure profile.
  describe('TASK-891 — threading the parent link into dispatch for visit-type selection', () => {
    it('passes the parent link through when the consultation is a revisit', async () => {
      m.consultationRepository.findById.mockResolvedValue({ id: 'parent-1', tenantId: TENANT });

      await makeService(m).getOrCreate({ patientId: 'p-1', parentConsultationId: 'parent-1' } as never, 'doctor-1');

      expect(m.workflowDispatchService.dispatchForConsultation).toHaveBeenCalledWith(expect.objectContaining({ parentConsultationId: 'parent-1' }));
    });

    it('passes no parent link for a brand-new visit — today behaviour, unchanged', async () => {
      await makeService(m).getOrCreate({ patientId: 'p-1' } as never, 'doctor-1');

      expect(m.workflowDispatchService.dispatchForConsultation).toHaveBeenCalledWith(expect.objectContaining({ parentConsultationId: null }));
    });
  });

  it('refuses BEFORE writing anything when the selection 404s — no consultation row, no meter, no consent', async () => {
    m.workflowDispatchService.assertSelectableForConsultation = vi.fn().mockRejectedValue(new NotFoundException('Workflow definition not found'));

    await expect(makeService(m).getOrCreate({ patientId: 'p-1', workflowDefinitionSlug: 'foreign' } as never, 'doctor-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(m.consultationRepository.create).not.toHaveBeenCalled();
    expect(m.workflowDispatchService.dispatchForConsultation).not.toHaveBeenCalled();
  });

  it('propagates the 403 for a visible-but-unselectable definition, and still writes nothing', async () => {
    m.workflowDispatchService.assertSelectableForConsultation = vi.fn().mockRejectedValue(new ForbiddenException('not selectable'));

    await expect(makeService(m).getOrCreate({ patientId: 'p-1', workflowDefinitionSlug: 'summarizer' } as never, 'doctor-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.consultationRepository.create).not.toHaveBeenCalled();
  });

  it('authorizes the selection even when the consultation already exists — the answer must not depend on whether a row happens to be there', async () => {
    m.consultationRepository.findByUniqueKey = vi.fn().mockResolvedValue({ id: 'existing', patientId: 'p-1' });
    m.workflowDispatchService.assertSelectableForConsultation = vi.fn().mockRejectedValue(new NotFoundException('Workflow definition not found'));

    await expect(makeService(m).getOrCreate({ patientId: 'p-1', workflowDefinitionSlug: 'foreign' } as never, 'doctor-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a selection the deployment cannot honour rather than silently running the default engine', async () => {
    const withoutDispatcher = makeMocks();
    const service = new ConsultationService(
      withoutDispatcher.consultationRepository as never,
      withoutDispatcher.departmentRepository as never,
      withoutDispatcher.userRoleAssignmentRepository as never,
      withoutDispatcher.userDepartmentRepository as never,
      withoutDispatcher.userRepository as never,
      withoutDispatcher.eventEmitter as never,
      withoutDispatcher.clsService as never,
      undefined,
      undefined,
      undefined,
      undefined, // dispatcher NOT wired
      undefined,
      withoutDispatcher.workflowDefinitionRepository as never,
    );

    await expect(service.getOrCreate({ patientId: 'p-1', workflowDefinitionSlug: SLUG } as never, 'doctor-1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(withoutDispatcher.consultationRepository.create).not.toHaveBeenCalled();
  });
});

describe('ConsultationService.getGoverningWorkflow — discovery (D-20)', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  const governedConsultation = {
    id: 'c-1',
    tenantId: TENANT,
    metadata: { governingEngine: { engine: 'tenant-workflow', workflowRunId: 'run-1', workflowDefinitionSlug: SLUG, decidedAt: '2026-08-29T00:00:00.000Z' } },
  };

  it('reports the tenant-authored workflow that governs, with its identity', async () => {
    m.consultationRepository.findById = vi.fn().mockResolvedValue(governedConsultation);

    await expect(makeService(m).getGoverningWorkflow('c-1')).resolves.toMatchObject({
      consultationId: 'c-1',
      governed: true,
      workflowDefinitionSlug: SLUG,
      workflowRunId: 'run-1',
      decidedAt: '2026-08-29T00:00:00.000Z',
      name: 'Caller Picked',
      paletteKey: 'consultation',
      activeVersionNumber: 3,
    });
  });

  it('declares the input schema ABSENT rather than inventing one — no per-definition input schema exists in the substrate (D-20)', async () => {
    m.consultationRepository.findById = vi.fn().mockResolvedValue(governedConsultation);
    await expect(makeService(m).getGoverningWorkflow('c-1')).resolves.toMatchObject({ inputSchema: null });
  });

  it('reports the default loop when no marker is present', async () => {
    m.consultationRepository.findById = vi.fn().mockResolvedValue({ id: 'c-2', tenantId: TENANT, metadata: null });

    await expect(makeService(m).getGoverningWorkflow('c-2')).resolves.toMatchObject({
      governed: false,
      workflowDefinitionSlug: null,
      workflowRunId: null,
    });
  });

  it('reads a MALFORMED marker as absent — the fail-safe direction is "the default engine governs"', async () => {
    m.consultationRepository.findById = vi.fn().mockResolvedValue({ id: 'c-3', tenantId: TENANT, metadata: { governingEngine: { engine: 'tenant-workflow' } } });
    await expect(makeService(m).getGoverningWorkflow('c-3')).resolves.toMatchObject({ governed: false });
  });

  it('404s an unknown or cross-tenant consultation id', async () => {
    m.consultationRepository.findById = vi.fn().mockResolvedValue(null);
    await expect(makeService(m).getGoverningWorkflow('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('still answers when the definition row has since been unpublished — identity degrades to the marker, never throws', async () => {
    m.consultationRepository.findById = vi.fn().mockResolvedValue(governedConsultation);
    m.workflowDefinitionRepository.findPublishedBySlug = vi.fn().mockResolvedValue(null);

    await expect(makeService(m).getGoverningWorkflow('c-1')).resolves.toMatchObject({
      governed: true,
      workflowDefinitionSlug: SLUG,
      name: null,
      activeVersionNumber: null,
    });
  });
});

/**
 * the selectable-set route's service half.
 *
 * `ConsultationService` owns exactly two things here, and both are about the REQUEST rather
 * than about workflows: the tenant comes from CLS and never from the caller, and a deployment
 * that cannot answer says so instead of answering "none".
 */
describe('ConsultationService.listSelectableWorkflows — discovery of the selectable set (§8)', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  const SELECTABLE = { data: [{ slug: SLUG, name: 'Caller Picked', description: 'a graph', isTenantDefault: true }] };

  it('asks the dispatcher for the CLS tenant set — the tenant is never a request field', async () => {
    m.workflowDispatchService.listSelectableForConsultation = vi.fn().mockResolvedValue(SELECTABLE);

    await expect(makeService(m).listSelectableWorkflows()).resolves.toEqual(SELECTABLE);
    expect(m.workflowDispatchService.listSelectableForConsultation).toHaveBeenCalledWith(TENANT);
  });

  it('passes an empty set straight through — a tenant that authored nothing is not an error', async () => {
    m.workflowDispatchService.listSelectableForConsultation = vi.fn().mockResolvedValue({ data: [] });
    await expect(makeService(m).listSelectableWorkflows()).resolves.toEqual({ data: [] });
  });

  it('503s when dispatch is not wired rather than answering "no workflows are selectable"', async () => {
    // Same posture as the SELECTION gate, and for the same reason: an empty list would be a
    // claim about the tenant's authoring, when the truth is that this deployment cannot tell.
    const withoutDispatcher = makeMocks();
    const service = new ConsultationService(
      withoutDispatcher.consultationRepository as never,
      withoutDispatcher.departmentRepository as never,
      withoutDispatcher.userRoleAssignmentRepository as never,
      withoutDispatcher.userDepartmentRepository as never,
      withoutDispatcher.userRepository as never,
      withoutDispatcher.eventEmitter as never,
      withoutDispatcher.clsService as never,
      undefined,
      undefined,
      undefined,
      undefined, // dispatcher NOT wired
      undefined,
      withoutDispatcher.workflowDefinitionRepository as never,
    );

    await expect(service.listSelectableWorkflows()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('400s without a resolved tenant rather than reading some other tenant set', async () => {
    m.clsService.get = vi.fn(() => null);
    m.workflowDispatchService.listSelectableForConsultation = vi.fn().mockResolvedValue(SELECTABLE);

    await expect(makeService(m).listSelectableWorkflows()).rejects.toBeInstanceOf(BadRequestException);
    expect(m.workflowDispatchService.listSelectableForConsultation).not.toHaveBeenCalled();
  });
});
