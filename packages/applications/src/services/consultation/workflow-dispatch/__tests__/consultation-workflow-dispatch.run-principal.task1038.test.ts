/**
 * TASK-1038 OD-35 — a consultation-governed run records the principal that started it.
 *
 * Governed runs are readable on the business plane (`workflows/{slug}/runs/{runId}/…`), and every
 * business-plane run read is bound to the run's starter. The consultation dispatcher therefore
 * stamps `_metadata.startedBy` like the exposure plane does: on consultation open, the principal
 * that opened it; on a governed resume (L-RESUME supersede), the superseded run's starter — the
 * same visit, so whoever followed the governed run keeps following it — falling back to the
 * principal triggering the resume.
 */
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { describe, expect, it, vi } from 'vitest';
import { ConsultationWorkflowDispatchService } from '../consultation-workflow-dispatch.service';
import type { RunPrincipal, RunPrincipalAccessService } from '../../../workflow-run/run-principal-access';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CONSULTATION = 'c-1';

const definition = {
  id: 'wd-1',
  slug: 'arcaai-consultation-v1',
  versionNumber: 3,
  name: 'ArcaAI Consultation',
  paletteKey: 'core',
  compiledConfig: { formatVersion: 1, stages: [], checksum: 'abc' },
};

function service(over: { consultation?: Record<string, unknown>; principal?: RunPrincipal | null; governingStartedBy?: RunPrincipal | null } = {}) {
  let row: Record<string, unknown> = over.consultation ?? { id: CONSULTATION, metadata: null, version: 1 };
  const deps = {
    assignments: { resolve: vi.fn().mockResolvedValue({ workflowDefinitionSlug: definition.slug, source: 'tenant' }) },
    definitionRepository: { findPublishedBySlug: vi.fn().mockResolvedValue(definition), findById: vi.fn().mockResolvedValue(definition) },
    consultationRepository: {
      findById: vi.fn(async () => structuredClone(row)),
      update: vi.fn().mockResolvedValue({}),
      updateWithVersion: vi.fn(async (_id: string, entity: Record<string, unknown>, expected: number) => {
        if (expected !== row.version)
          throw new OptimisticConcurrencyException('Consultation', CONSULTATION, {
            expectedVersion: expected,
            currentVersion: row.version as number,
          });
        row = { ...structuredClone(entity), version: (row.version as number) + 1 };
        return row;
      }),
    },
    workflowRunService: {
      recordRunStarted: vi.fn().mockResolvedValue({}),
      getRun: vi.fn().mockResolvedValue({ runId: 'run-old', workflowVersionId: definition.id }),
      getRunForReader: vi.fn().mockResolvedValue({
        run: { runId: 'run-old', workflowVersionId: definition.id },
        startedBy: over.governingStartedBy ?? null,
      }),
      recordRunFinished: vi.fn().mockResolvedValue({}),
      recordRunSuperseded: vi.fn().mockResolvedValue({}),
    },
    harnessGateway: { startWorkflowRun: vi.fn().mockResolvedValue({ status: 'RUNNING' }), terminateWorkflowRun: vi.fn().mockResolvedValue({}) },
    s3Service: { putFile: vi.fn().mockResolvedValue(undefined) },
  };
  const svc = new ConsultationWorkflowDispatchService(
    deps.assignments as never,
    deps.definitionRepository as never,
    deps.consultationRepository as never,
    deps.workflowRunService as never,
    deps.harnessGateway as never,
    deps.s3Service as never,
    undefined /* visit types */,
    undefined /* run completion */,
    undefined /* effective trigger schema */,
    { currentPrincipal: () => over.principal ?? null } as unknown as RunPrincipalAccessService,
  );
  return { svc, deps };
}

const GOVERNED = {
  id: CONSULTATION,
  tenantId: TENANT,
  doctorId: 'doc-1',
  version: 4,
  metadata: {
    governingEngine: {
      engine: 'tenant-workflow',
      workflowRunId: 'run-old',
      workflowDefinitionSlug: definition.slug,
      decidedAt: '2026-10-01T00:00:00.000Z',
    },
  },
};

const stampedMeta = (deps: ReturnType<typeof service>['deps']) =>
  (deps.workflowRunService.recordRunStarted.mock.calls[0][0] as { metaData?: Record<string, unknown> }).metaData;

describe('OD-35 — consultation dispatch stamps the starting principal', () => {
  it('consultation open: the principal that opened it', async () => {
    const { svc, deps } = service({ principal: { type: 'serviceAccount', id: 'sa-alaas' } });
    await svc.dispatchForConsultation({
      consultationId: CONSULTATION,
      tenantId: TENANT,
      departmentId: null,
      userId: 'u-1',
      externalPatientId: 'p-1',
    });
    expect(stampedMeta(deps)).toEqual({ consultationId: CONSULTATION, startedBy: { type: 'serviceAccount', id: 'sa-alaas' } });
  });

  it('consultation open with no principal in context: no stamp (tenant-wide readers only)', async () => {
    const { svc, deps } = service({ principal: null });
    await svc.dispatchForConsultation({
      consultationId: CONSULTATION,
      tenantId: TENANT,
      departmentId: null,
      userId: 'u-1',
      externalPatientId: 'p-1',
    });
    expect(stampedMeta(deps)).toEqual({ consultationId: CONSULTATION });
  });

  it('governed resume: the superseded run’s starter carries over, whoever triggers the resume', async () => {
    const { svc, deps } = service({
      consultation: structuredClone(GOVERNED),
      principal: { type: 'user', id: 'someone-else' },
      governingStartedBy: { type: 'apiKey', id: 'key-A' },
    });
    const result = await svc.supersedeGoverningRun({ consultationId: CONSULTATION, tenantId: TENANT, triggerId: 'trig-1' });
    expect(result.superseded).toBe(true);
    expect(stampedMeta(deps)).toEqual({ consultationId: CONSULTATION, startedBy: { type: 'apiKey', id: 'key-A' } });
  });

  it('governed resume of an unstamped run: the principal triggering the resume', async () => {
    const { svc, deps } = service({ consultation: structuredClone(GOVERNED), principal: { type: 'apiKey', id: 'key-B' }, governingStartedBy: null });
    await svc.supersedeGoverningRun({ consultationId: CONSULTATION, tenantId: TENANT, triggerId: 'trig-1' });
    expect(stampedMeta(deps)).toEqual({ consultationId: CONSULTATION, startedBy: { type: 'apiKey', id: 'key-B' } });
  });
});
