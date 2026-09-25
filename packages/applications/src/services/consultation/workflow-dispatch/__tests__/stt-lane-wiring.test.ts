/**
 * TASK-893 — the `stt` palette is RETIRED with the rest of the legacy vocabulary, so the STT
 * assignment lane this file used to pin (assignment -> `stt` graph slug -> compiled `AsrPipeline`
 * id) no longer exists. The ASR binding is the tenant's SPEECH_TO_TEXT Agent, resolved by the
 * gateway at session start (TASK-861 `ResolvedAsrSpec`).
 *
 * TASK-1006 — and the vestige is gone too: the dispatch result no longer carries an always-null
 * `sttPipelineId`, and the dispatcher holds no pipeline resolver.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConsultationWorkflowDispatchService } from '../consultation-workflow-dispatch.service';

const mockAssignments = { resolve: vi.fn() };
const mockDefinitionRepository = { findPublishedBySlug: vi.fn() };
const mockWorkflowRunService = { recordRunStarted: vi.fn(), recordRunFinished: vi.fn() };
const mockHarnessGateway = { startWorkflowRun: vi.fn() };
const mockS3Service = { putFile: vi.fn().mockResolvedValue(undefined) };

const INPUT = { consultationId: 'c-1', tenantId: 'tenant-1', departmentId: 'dept-1', userId: 'u-1', externalPatientId: 'p-1' };

const noAssignment = { workflowDefinitionSlug: null, source: 'platform-default' as const };

function build() {
  return new ConsultationWorkflowDispatchService(
    mockAssignments as any,
    mockDefinitionRepository as any,
    // the dispatcher now records which engine governs.
    { findById: vi.fn().mockResolvedValue({ id: 'c-1', metadata: null }), update: vi.fn().mockResolvedValue({}) } as any,
    mockWorkflowRunService as any,
    mockHarnessGateway as any,
    mockS3Service as any,
  );
}

describe('TASK-893 / TASK-1006 — the STT assignment lane is retired', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssignments.resolve.mockResolvedValue(noAssignment);
  });

  it('never resolves an `stt` assignment, and the result names no pipeline', async () => {
    const result = await build().dispatchForConsultation(INPUT);
    expect(result).not.toHaveProperty('sttPipelineId');
    for (const call of mockAssignments.resolve.mock.calls) expect(call[1]).not.toBe('stt');
  });

  it('the consultation lane still resolves the `core` assignment for the same tenant + department', async () => {
    await build().dispatchForConsultation(INPUT);
    expect(mockAssignments.resolve).toHaveBeenCalledWith('tenant-1', 'core', 'dept-1', expect.anything());
  });
});
