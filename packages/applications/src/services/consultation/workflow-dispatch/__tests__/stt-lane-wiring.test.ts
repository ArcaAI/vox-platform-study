/**
 * the STT assignment lane resolves to a real `pipelineId`.
 *
 * `SttPipelineResolverService` was exported for a consumer its own module comment calls "a
 * FUTURE, separate wiring pass" and was injected NOWHERE — zero production callers. Meanwhile
 * the rest of the lane is genuinely live: publishing an `stt`-palette graph already writes a real
 * `AsrPipeline` + `AsrPipelineVersion` through the production `PipelineService` , and
 * the compiled pipeline already appears in the consultation Listener selector. The only missing
 * link was assignment -> slug -> pipelineId.
 *
 * Wired at consultation open, beside the consultation-palette dispatch that landed
 * the one place that already resolves the assignment cascade for a tenant + department. The two
 * lanes are INDEPENDENT: a tenant may assign an `stt` graph and no `consultation` graph, so the
 * STT resolution must not be skipped by the consultation lane's early return.
 *
 * Deliberately NOT wired here: the final bind of this id into the realtime WS session. That lives
 * under `apps/api/src/modules/streaming/**`, which grep-gate deliberately fences
 * touching it must force an explicit decision, not ride along in this change.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConsultationWorkflowDispatchService } from '../consultation-workflow-dispatch.service';

const mockAssignments = { resolve: vi.fn() };
const mockDefinitionRepository = { findPublishedBySlug: vi.fn() };
const mockWorkflowRunService = { recordRunStarted: vi.fn(), recordRunFinished: vi.fn() };
const mockHarnessGateway = { startWorkflowRun: vi.fn() };
const mockS3Service = { putFile: vi.fn().mockResolvedValue(undefined) };
const mockSttResolver = { resolvePipelineId: vi.fn() };

const INPUT = { consultationId: 'c-1', tenantId: 'tenant-1', departmentId: 'dept-1', userId: 'u-1', externalPatientId: 'p-1' };

const noAssignment = { workflowDefinitionSlug: null, source: 'platform-default' as const };

function build(withResolver = true) {
  return new ConsultationWorkflowDispatchService(
    mockAssignments as any,
    mockDefinitionRepository as any,
    // the dispatcher now records which engine governs.
    ({ findById: vi.fn().mockResolvedValue({ id: 'c-1', metadata: null }), update: vi.fn().mockResolvedValue({}) }) as any,
    mockWorkflowRunService as any,
    mockHarnessGateway as any,
    mockS3Service as any,
    withResolver ? (mockSttResolver as any) : undefined,
  );
}

describe(' W4 — STT pipeline resolution at consultation open (H-5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssignments.resolve.mockResolvedValue(noAssignment);
    mockSttResolver.resolvePipelineId.mockResolvedValue(null);
  });

  it('resolves the stt-palette assignment for the same tenant + department', async () => {
    mockAssignments.resolve.mockImplementation(async (_t: string, palette: string) =>
      palette === 'stt' ? { workflowDefinitionSlug: 'clinic-asr', source: 'department' as const } : noAssignment,
    );
    mockSttResolver.resolvePipelineId.mockResolvedValue('pipe-42');

    const result = await build().dispatchForConsultation(INPUT);

    expect(mockAssignments.resolve).toHaveBeenCalledWith('tenant-1', 'stt', 'dept-1');
    expect(mockSttResolver.resolvePipelineId).toHaveBeenCalledWith('tenant-1', 'clinic-asr');
    expect(result.sttPipelineId).toBe('pipe-42');
  });

  it('resolves the STT lane even when NO consultation graph is assigned — the lanes are independent', async () => {
    mockAssignments.resolve.mockImplementation(async (_t: string, palette: string) =>
      palette === 'stt' ? { workflowDefinitionSlug: 'clinic-asr', source: 'tenant' as const } : noAssignment,
    );
    mockSttResolver.resolvePipelineId.mockResolvedValue('pipe-42');

    const result = await build().dispatchForConsultation(INPUT);

    expect(result.dispatched).toBe(false);
    expect(result.sttPipelineId).toBe('pipe-42');
  });

  it('is null when no stt graph is assigned — fall back to the tenant existing pipeline resolution', async () => {
    const result = await build().dispatchForConsultation(INPUT);

    expect(result.sttPipelineId).toBeNull();
    expect(mockSttResolver.resolvePipelineId).not.toHaveBeenCalled();
  });

  it('never blocks the consultation when STT resolution throws — best-effort, like the rest of this service', async () => {
    mockAssignments.resolve.mockImplementation(async (_t: string, palette: string) =>
      palette === 'stt' ? { workflowDefinitionSlug: 'clinic-asr', source: 'tenant' as const } : noAssignment,
    );
    mockSttResolver.resolvePipelineId.mockRejectedValue(new Error('pipeline service down'));

    const result = await build().dispatchForConsultation(INPUT);

    expect(result.sttPipelineId).toBeNull();
  });

  it('is null when the resolver is not wired (unit fixtures)', async () => {
    const result = await build(false).dispatchForConsultation(INPUT);

    expect(result.sttPipelineId).toBeNull();
  });
});
