/**
 * lane A step 2 — the authorized selection is DURABLE from the moment the
 * consultation exists, not only when the durable dispatch succeeds.
 *
 * ## The gap
 *
 * authorizes `workflowDefinitionSlug` at open and threads it into
 * `dispatchForConsultation`. The only place it was ever written down is
 * `Consultation.metadata.governingEngine`, and `governing-engine.ts` requires a non-empty
 * `workflowRunId` — which exists ONLY after Temporal actually started a run. Every other outcome
 * (`harness gateway down`, `no claim-check storage`, `dispatcher not wired`, a definition with no
 * compiled config) returns `dispatched: false` and leaves NOTHING on the row.
 *
 * That is the same set of outcomes in which the REALTIME lane still runs — the substrate gate
 * stands the live engine down only when a `governingEngine` marker IS present — so it is exactly
 * when the selection must survive for lane A's resolver to honour it.
 *
 * ## Why at CREATE, and not after dispatch
 *
 * The write is folded into the factory call, before `dispatchForConsultation` is even reached, so
 * it cannot be lost by any dispatch outcome. It records what was ASKED FOR (and authorized); the
 * `governingEngine` marker continues to record what actually TOOK OWNERSHIP. Two different claims,
 * two keys, and neither is inferred from the other.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConsultationService } from '../consultation.service';
import { WORKFLOW_SELECTION_METADATA_KEY } from '../workflow-selection';
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
const SLUG = 'arcaai-rheum-consultation-soap';

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
    userDepartmentRepository: {
      findFirst: vi.fn().mockResolvedValue({ id: 'ud-1', tenantId: TENANT, resourceStatus: ResourceStatusType.ENABLED }),
    },
    userRepository: { findFirst: vi.fn().mockResolvedValue({ id: 'doctor-1', isServiceAccount: false }) },
    eventEmitter: { emit: vi.fn() },
    clsService: {
      get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-id-1' } : null)),
      set: vi.fn(),
    },
    workflowDispatchService: {
      assertSelectableForConsultation: vi.fn().mockResolvedValue(undefined),
      dispatchForConsultation: vi.fn().mockResolvedValue({
        dispatched: true,
        source: 'caller-selected',
        workflowDefinitionSlug: SLUG,
        runId: 'run-1',
        governanceRecorded: true,
        sttPipelineId: null,
      }),
    },
    workflowDefinitionRepository: { findPublishedBySlug: vi.fn().mockResolvedValue(null) },
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

/** The metadata the factory was handed for the row that was created. */
function createdMetadata(m: ReturnType<typeof makeMocks>): Record<string, unknown> | null | undefined {
  const created = m.consultationRepository.create.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> | null };
  return created?.metadata;
}

describe('the authorized workflow selection is persisted on the consultation', () => {
  let m: ReturnType<typeof makeMocks>;
  beforeEach(() => {
    m = makeMocks();
  });

  it('records the selected slug under its own metadata key at CREATE', async () => {
    await makeService(m).getOrCreate({ patientId: 'p-1', workflowDefinitionSlug: SLUG } as never, 'doctor-1');

    expect(createdMetadata(m)).toMatchObject({
      [WORKFLOW_SELECTION_METADATA_KEY]: { workflowDefinitionSlug: SLUG },
    });
  });

  it('survives a FAILED dispatch — the case the `governingEngine` marker cannot cover', async () => {
    m.workflowDispatchService.dispatchForConsultation = vi.fn().mockResolvedValue({
      dispatched: false,
      source: 'caller-selected',
      workflowDefinitionSlug: SLUG,
      runId: null,
      governanceRecorded: false,
      skippedReason: 'harness gateway unreachable',
      sttPipelineId: null,
    });

    await makeService(m).getOrCreate({ patientId: 'p-1', workflowDefinitionSlug: SLUG } as never, 'doctor-1');

    // Written before dispatch was even attempted, so no dispatch outcome can lose it.
    expect(createdMetadata(m)).toMatchObject({
      [WORKFLOW_SELECTION_METADATA_KEY]: { workflowDefinitionSlug: SLUG },
    });
  });

  it('preserves caller-supplied metadata alongside it', async () => {
    await makeService(m).getOrCreate(
      { patientId: 'p-1', workflowDefinitionSlug: SLUG, metadata: { schedulingRef: 'ext-42' } } as never,
      'doctor-1',
    );

    const metadata = createdMetadata(m);
    expect(metadata).toMatchObject({ schedulingRef: 'ext-42' });
    expect(metadata).toMatchObject({ [WORKFLOW_SELECTION_METADATA_KEY]: { workflowDefinitionSlug: SLUG } });
  });

  it('writes NOTHING when no selector was supplied — the cascade path keeps today’s metadata exactly', async () => {
    await makeService(m).getOrCreate({ patientId: 'p-1', metadata: { schedulingRef: 'ext-42' } } as never, 'doctor-1');

    expect(createdMetadata(m)).toEqual({ schedulingRef: 'ext-42' });
  });

  it('stamps `selectedAt` so the record says WHEN, not just what', async () => {
    await makeService(m).getOrCreate({ patientId: 'p-1', workflowDefinitionSlug: SLUG } as never, 'doctor-1');

    const marker = createdMetadata(m)?.[WORKFLOW_SELECTION_METADATA_KEY] as { selectedAt?: string };
    expect(typeof marker.selectedAt).toBe('string');
    expect(Number.isNaN(Date.parse(marker.selectedAt as string))).toBe(false);
  });
});
