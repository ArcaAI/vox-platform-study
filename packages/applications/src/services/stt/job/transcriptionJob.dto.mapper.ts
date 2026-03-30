import { TranscriptionJobEntity } from '@arcaai/domains';
import { TranscriptionJobResponse } from './dto';
import { PipelineDtoMapper } from '../pipeline/pipeline.dto.mapper';

export class TranscriptionJobDtoMapper {
  static toResponse(entity: TranscriptionJobEntity): TranscriptionJobResponse {
    return {
      id: entity.id,
      jobType: entity.jobType,
      pipelineId: entity.pipelineId,
      pipeline: entity.Pipeline ? PipelineDtoMapper.toResponse(entity.Pipeline) : undefined,
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
      workerId: entity.workerId,
      tenantId: entity.tenantId || '',
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      createdBy: entity.createdBy,
    };
  }
}
