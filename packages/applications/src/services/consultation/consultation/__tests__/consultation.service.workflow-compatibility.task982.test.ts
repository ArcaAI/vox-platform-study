/**
 * The pre-dispatch compatibility check at `open`.
 *
 * ## The failure it closes
 *
 * `open` validates the caller's context against the tenant's CURRENT pinned schema, then hands
 * the same payload to a governing workflow whose trigger may have been frozen against an OLDER
 * version — and the interpreter validates it with `additionalProperties: false`. So a tenant that
 * publishes a kind and opens a consultation got a 201, a written row, a metered unit, persisted
 * PHI context items, and a governing run that failed on its FIRST node minutes later with nothing
 * the clinician could act on.
 *
 * Checking here makes that a precise, synchronous 400 naming the workflow and the problems.
 *
 * ## The two rules that keep it safe
 *
 *   1. **CREATE path only.** A re-open dispatches nothing, so there is nothing to be incompatible
 *      with, and refusing one would break a consultation that is already running.
 *   2. **Only a CONCLUSIVE check may refuse.** No assignment, an unreadable config, a withdrawn
 *      pin, a dependency outage — every one of those falls through to today's ungoverned open. A
 *      clinician must never be blocked from opening a consultation because a lookup failed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ResourceStatusType } from '@arcaai/domains';
import { ConsultationService } from '../consultation.service';

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
const SLUG = 'arcaai-consultation-v1';

/** A trigger that admits `encounter` and nothing else — the frozen v1 shape. */
const ACCEPTS_ENCOUNTER_ONLY = {
  type: 'object',
  additionalProperties: false,
  properties: { encounter: { type: 'object', properties: { note: { type: 'string' } } } },
};

function makeMocks() {
  return {
    consultationRepository: {
      findByUniqueKey: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(null),
      findWithRelations: vi.fn().mockResolvedValue(null),
      create: vi.fn(async (entity: unknown) => entity),
    },
    departmentRepository: { findById: vi.fn().mockResolvedValue({ id: 'dept-1', tenantId: TENANT }) },
    userRoleAssignmentRepository: {
      findFirst: vi.fn().mockResolvedValue({ id: 'ura-1', tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED }),
    },
    userDepartmentRepository: { findFirst: vi.fn().mockResolvedValue({ id: 'ud-1', tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED }) },
    userRepository: { findFirst: vi.fn().mockResolvedValue({ id: 'doctor-1', isServiceAccount: false }) },
    eventEmitter: { emit: vi.fn() },
    clsService: { get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-id-1' } : null)), set: vi.fn() },
    entitlements: { assertMeterQuota: vi.fn().mockResolvedValue(undefined) },
    workflowDispatchService: {
      assertSelectableForConsultation: vi.fn().mockResolvedValue(undefined),
      previewGoverningWorkflow: vi.fn().mockResolvedValue({ workflowDefinitionSlug: SLUG, resolved: ACCEPTS_ENCOUNTER_ONLY, boundSchemaVersion: 1 }),
      dispatchForConsultation: vi.fn().mockResolvedValue({
        dispatched: true,
        source: 'tenant',
        workflowDefinitionSlug: SLUG,
        runId: 'run-1',
        governanceRecorded: true,
        sttPipelineId: null,
      }),
    },
    workflowDefinitionRepository: { findPublishedBySlug: vi.fn().mockResolvedValue(null) },
    contextSchemaService: {
      // The tenant's CURRENT schema admits both kinds — which is the whole point: `open`'s own
      // validation passes and the payload still has to face the governing workflow's FROZEN
      // trigger, which may be older. These tests measure that second check.
      getEffectiveBundle: vi.fn().mockResolvedValue({
        contextSchemaId: 'schema-1',
        contextSchemaVersionId: 'version-4',
        versionNumber: 4,
        definition: {
          kinds: [
            { key: 'encounter', primitive: 'STRUCTURED', fields: { type: 'object', properties: { note: { type: 'string' } } } },
            { key: 'referral', primitive: 'STRUCTURED', fields: { type: 'object', properties: { reason: { type: 'string' } } } },
          ],
        },
      }),
      validateContextPayload: vi.fn(async ({ kindKey }: { kindKey: string }) => ({
        kindKey,
        primitive: 'STRUCTURED',
        contextSchemaVersionId: 'version-4',
      })),
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
    m.entitlements as never,
    undefined, // harnessAudit
    undefined, // tenantSettings
    m.workflowDispatchService as never,
    undefined, // consentGrantService
    m.workflowDefinitionRepository as never,
    undefined, // policyEngine
    m.contextSchemaService as never,
  );
}

async function openWith(m: ReturnType<typeof makeMocks>, context?: Record<string, unknown>) {
  return makeService(m).getOrCreate({ patientId: 'p-1', ...(context ? { context } : {}) } as never, 'doctor-1');
}

function expectNothingWritten(m: ReturnType<typeof makeMocks>) {
  expect(m.entitlements.assertMeterQuota).not.toHaveBeenCalled();
  expect(m.consultationRepository.create).not.toHaveBeenCalled();
  expect(m.workflowDispatchService.dispatchForConsultation).not.toHaveBeenCalled();
}

describe('open refuses a context the governing workflow would reject', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('answers 400 WORKFLOW_CONTEXT_INCOMPATIBLE naming the workflow, the bound version and every problem', async () => {
    const error = await openWith(m, { encounter: { note: 'x' }, referral: { reason: 'y' } }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse() as Record<string, unknown>;
    expect(body.code).toBe('WORKFLOW_CONTEXT_INCOMPATIBLE');
    expect(body.workflowDefinitionSlug).toBe(SLUG);
    expect(body.boundSchemaVersion).toBe(1);
    expect(body.problems).toEqual(expect.arrayContaining([expect.stringContaining('referral')]));
  });

  it('writes NOTHING — no meter unit, no row, no dispatch', async () => {
    await openWith(m, { encounter: { note: 'x' }, referral: { reason: 'y' } }).catch(() => undefined);

    expectNothingWritten(m);
  });

  it('opens normally when the governing trigger accepts the context', async () => {
    await openWith(m, { encounter: { note: 'x' } });

    expect(m.consultationRepository.create).toHaveBeenCalled();
    expect(m.workflowDispatchService.dispatchForConsultation).toHaveBeenCalled();
  });

  it('asks the preview for the SAME workflow dispatch will select', async () => {
    await openWith(m, { encounter: { note: 'x' } });

    expect(m.workflowDispatchService.previewGoverningWorkflow).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }));
  });
});

describe('the check never blocks an open it cannot conclude', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('opens UNGOVERNED-as-today when no workflow resolves', async () => {
    m.workflowDispatchService.previewGoverningWorkflow.mockResolvedValue(null);

    await openWith(m, { encounter: { note: 'x' }, referral: { reason: 'y' } });

    expect(m.consultationRepository.create).toHaveBeenCalled();
  });

  it('opens when the preview itself throws — a dependency outage is not a caller error', async () => {
    m.workflowDispatchService.previewGoverningWorkflow.mockRejectedValue(new Error('harness gateway unreachable'));

    await openWith(m, { encounter: { note: 'x' }, referral: { reason: 'y' } });

    expect(m.consultationRepository.create).toHaveBeenCalled();
  });

  it('opens when no dispatcher is wired at all', async () => {
    const svc = new ConsultationService(
      m.consultationRepository as never,
      m.departmentRepository as never,
      m.userRoleAssignmentRepository as never,
      m.userDepartmentRepository as never,
      m.userRepository as never,
      m.eventEmitter as never,
      m.clsService as never,
      m.entitlements as never,
      undefined,
      undefined,
      undefined, // no dispatcher
      undefined,
      m.workflowDefinitionRepository as never,
      undefined, // policyEngine
      m.contextSchemaService as never,
    );

    await svc.getOrCreate({ patientId: 'p-1', context: { referral: { reason: 'y' } } } as never, 'doctor-1');

    expect(m.consultationRepository.create).toHaveBeenCalled();
  });

  it('skips the check entirely when the caller sent no context', async () => {
    await openWith(m);

    expect(m.workflowDispatchService.previewGoverningWorkflow).not.toHaveBeenCalled();
    expect(m.consultationRepository.create).toHaveBeenCalled();
  });
});

describe('the RE-OPEN path is never checked', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('returns the existing consultation without previewing anything, even for a context the workflow would refuse', async () => {
    const existing = {
      id: 'existing-1',
      tenantId: TENANT,
      version: 1,
      metadata: null,
      appointmentDate: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    m.consultationRepository.findByUniqueKey.mockResolvedValue(existing);
    m.consultationRepository.findWithRelations.mockResolvedValue(existing);

    const result = await openWith(m, { encounter: { note: 'x' }, referral: { reason: 'y' } });

    expect(result.id).toBe('existing-1');
    expect(m.workflowDispatchService.previewGoverningWorkflow).not.toHaveBeenCalled();
    expectNothingWritten(m);
  });
});
