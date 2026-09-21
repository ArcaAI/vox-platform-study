import { TranscriptionJobEntity } from '@arcaai/domains';
import { ServedByResponse, TranscriptionJobResponse } from './dto';
import { PipelineDtoMapper } from '../pipeline/pipeline.dto.mapper';

export class TranscriptionJobDtoMapper {
  static toResponse(entity: TranscriptionJobEntity): TranscriptionJobResponse {
    return {
      id: entity.id,
      jobType: entity.jobType,
      pipelineId: entity.pipelineId ?? null,
      pipeline: entity.Pipeline ? PipelineDtoMapper.toResponse(entity.Pipeline) : undefined,
      agentVersionId: entity.agentVersionId ?? null,
      resolvedSpec: entity.resolvedSpec ?? null,
      // TASK-999 §3.1 C-2 — the telemetry block. `servedBy` is persisted as the
      // `ServedBy` shape this package writes, so it is cast rather than re-parsed;
      // a row written before TASK-999 carries `null` and stays `null`.
      streamSessionId: entity.streamSessionId ?? null,
      servedBy: (entity.servedBy as unknown as ServedByResponse | null | undefined) ?? null,
      resultWordCount: entity.resultWordCount ?? null,
      resultCharCount: entity.resultCharCount ?? null,
      // Computed, never stored: the entity already derives it from
      // `completedAt - startedAt` and the mapper simply stopped omitting it.
      durationMs: entity.durationMs ?? null,
      consultationId: entity.consultationId,
      contextItemId: entity.contextItemId,
      mediaId: entity.mediaId,
      status: entity.status,
      progress: entity.progress,
      queuedAt: entity.queuedAt,
      startedAt: entity.startedAt,
      completedAt: entity.completedAt,
      resultText: entity.resultText,
      resultMetadata: entity.resultMetadata,
      errorMessage: entity.errorMessage,
      errorCode: entity.errorCode,
      retryCount: entity.retryCount,
      maxRetries: entity.maxRetries,
      reclaimCount: entity.reclaimCount,
      workerId: entity.workerId,
      tenantId: entity.tenantId || '',
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      createdBy: entity.createdBy,
    };
  }
}
