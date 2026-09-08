/**
 * TASK-893 — the `stt` palette is RETIRED with the rest of the legacy vocabulary, so the STT
 * assignment lane this file used to pin (assignment -> `stt` graph slug -> compiled `AsrPipeline`
 * id) no longer exists. The ASR binding is the tenant's SPEECH_TO_TEXT Agent, resolved by the
 * gateway at session start (TASK-861 `ResolvedAsrSpec`). `sttPipelineId` stays on the result for
 * wire compatibility and is always `null`; nothing asks the assignment cascade for `stt`.
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

describe('TASK-893 — the STT assignment lane is retired', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssignments.resolve.mockResolvedValue(noAssignment);
    mockSttResolver.resolvePipelineId.mockResolvedValue('pipe-42');
  });

  it('never resolves an `stt` assignment and never asks the pipeline resolver, with or without one wired', async () => {
    for (const withResolver of [true, false]) {
      const result = await build(withResolver).dispatchForConsultation(INPUT);
      expect(result.sttPipelineId).toBeNull();
      expect(mockSttResolver.resolvePipelineId).not.toHaveBeenCalled();
      for (const call of mockAssignments.resolve.mock.calls) expect(call[1]).not.toBe('stt');
    }
  });

  it('the consultation lane still resolves the `core` assignment for the same tenant + department', async () => {
    await build().dispatchForConsultation(INPUT);
    expect(mockAssignments.resolve).toHaveBeenCalledWith('tenant-1', 'core', 'dept-1', expect.anything());
  });
});
