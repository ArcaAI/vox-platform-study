/**
 * TASK-1038 E2 (fix 3) — every consultation-governed run row names its consultation.
 *
 * The internal consultation-read route admits a run only when its row's `_metadata.consultationId`
 * names the consultation (the exposure plane stamps it, `workflow-exposure.service.ts`). The
 * consultation dispatcher records governance AFTER the start, so a run whose first node reads the
 * consultation before governance lands was refused 404. Both dispatch paths — consultation open
 * and the L-RESUME supersede — now stamp `metaData: { consultationId }` on `recordRunStarted`.
 */
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import { describe, expect, it, vi } from 'vitest';
import { ConsultationWorkflowDispatchService } from '../consultation-workflow-dispatch.service';

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

function service(over: { consultation?: Record<string, unknown> } = {}) {
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
  );
  return { svc, deps };
}

describe('consultation dispatch stamps the consultation on the run row', () => {
  it('consultation open: recordRunStarted carries metaData.consultationId', async () => {
    const { svc, deps } = service();
    await svc.dispatchForConsultation({
      consultationId: CONSULTATION,
      tenantId: TENANT,
      departmentId: null,
      userId: 'u-1',
      externalPatientId: 'p-1',
    });
    expect(deps.workflowRunService.recordRunStarted).toHaveBeenCalledWith(expect.objectContaining({ metaData: { consultationId: CONSULTATION } }));
  });

  it('supersede (L-RESUME): recordRunStarted carries metaData.consultationId', async () => {
    const { svc, deps } = service({
      consultation: {
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
      },
    });
    const result = await svc.supersedeGoverningRun({ consultationId: CONSULTATION, tenantId: TENANT, triggerId: 'trig-1' });
    expect(result.superseded).toBe(true);
    expect(deps.workflowRunService.recordRunStarted).toHaveBeenCalledWith(expect.objectContaining({ metaData: { consultationId: CONSULTATION } }));
  });
});
