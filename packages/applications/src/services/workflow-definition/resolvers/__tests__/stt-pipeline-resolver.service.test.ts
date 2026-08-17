/**
 * TASK-724 Task 6 (realtime-trigger binding, resolver half) — `SttPipelineResolverService`.
 *
 * README §1/§4 Task 6: when a session/consultation open resolves to a PUBLISHED `stt`-palette
 * `WorkflowDefinition`, this resolver returns the `pipelineId` to bind — the SAME id Task 4's
 * `SttPipelineCompilerService` wrote (via the deterministic `sttWorkflowPipelineSlug` mapping),
 * so the caller can pass it straight into the EXISTING `CreateStreamingSessionRequest.pipelineId`
 * path (`packages/applications/src/services/stt/streaming/streamingSession.service.ts`) —
 * this file touches neither that service nor any realtime/streaming code (proved separately by
 * the ticket's `task-724-stt-realtime-untouched.grep-gate.test.ts`).
 *
 * RED-first: this file was authored, and run RED (module did not exist), before
 * `stt-pipeline-resolver.service.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SttPipelineResolverService } from '../stt-pipeline-resolver.service';

const mockWorkflowDefinitionRepository = {
  findPublishedBySlug: vi.fn(),
};

const mockPipelineService = {
  getBySlug: vi.fn(),
};

describe('SttPipelineResolverService', () => {
  let service: SttPipelineResolverService;

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new SttPipelineResolverService(mockWorkflowDefinitionRepository as any, mockPipelineService as any);
  });

  it("resolves the SAME pipelineId Task 4's compiler wrote, for a PUBLISHED stt-palette definition", async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue({ id: 'def-1', slug: 'my_stt_flow', paletteKey: 'stt' });
    mockPipelineService.getBySlug.mockResolvedValue({ id: 'pipe-1', slug: 'wf-stt-my-stt-flow' });

    const pipelineId = await service.resolvePipelineId('tenant-1', 'my_stt_flow');

    expect(mockWorkflowDefinitionRepository.findPublishedBySlug).toHaveBeenCalledWith('tenant-1', 'my_stt_flow');
    expect(mockPipelineService.getBySlug).toHaveBeenCalledWith('wf-stt-my-stt-flow');
    expect(pipelineId).toBe('pipe-1');
  });

  it('returns null when no PUBLISHED WorkflowDefinition exists for that (tenant, slug)', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(null);

    const pipelineId = await service.resolvePipelineId('tenant-1', 'missing_flow');

    expect(pipelineId).toBeNull();
    expect(mockPipelineService.getBySlug).not.toHaveBeenCalled();
  });

  it('returns null (never resolves) for a published definition on a different palette', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue({ id: 'def-1', slug: 'discharge_summary', paletteKey: 'summarization' });

    const pipelineId = await service.resolvePipelineId('tenant-1', 'discharge_summary');

    expect(pipelineId).toBeNull();
    expect(mockPipelineService.getBySlug).not.toHaveBeenCalled();
  });

  it('returns null when the WorkflowDefinition is published but no AsrPipeline row exists yet (compile never ran)', async () => {
    mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue({ id: 'def-1', slug: 'my_stt_flow', paletteKey: 'stt' });
    mockPipelineService.getBySlug.mockResolvedValue(null);

    const pipelineId = await service.resolvePipelineId('tenant-1', 'my_stt_flow');

    expect(pipelineId).toBeNull();
  });
});
