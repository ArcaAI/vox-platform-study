import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TranscriptionJobStatus, TranscriptionJobType } from '@arcaai/domains';
import { JsonValue } from '@arcaai/domains';
import { PipelineResponse } from '../../pipeline/dto';

export class TranscriptionJobResponse {
  @ApiProperty({ description: 'Job ID' })
  id: string;

  @ApiProperty({ description: 'Job type', enum: TranscriptionJobType })
  jobType: TranscriptionJobType;

  @ApiProperty({ description: 'Pipeline ID' })
  pipelineId: string;

  @ApiPropertyOptional({ description: 'Pipeline details' })
  pipeline?: PipelineResponse;

  @ApiPropertyOptional({ description: 'Consultation ID' })
  consultationId?: string | null;

  @ApiPropertyOptional({ description: 'Context item ID (after completion)' })
  contextItemId?: string | null;

  @ApiPropertyOptional({ description: 'Media ID (for batch jobs)' })
  mediaId?: string | null;

  @ApiProperty({ description: 'Job status', enum: TranscriptionJobStatus })
  status: TranscriptionJobStatus;

  @ApiProperty({ description: 'Progress (0-100)' })
  progress: number;

  @ApiProperty({ description: 'Queued at timestamp' })
  queuedAt: Date;

  @ApiPropertyOptional({ description: 'Started at timestamp' })
  startedAt?: Date | null;

  @ApiPropertyOptional({ description: 'Completed at timestamp' })
  completedAt?: Date | null;

  @ApiPropertyOptional({ description: 'Transcription result text' })
  resultText?: string | null;

  @ApiPropertyOptional({ description: 'Result metadata' })
  resultMetadata?: JsonValue | null;

  @ApiPropertyOptional({ description: 'Error message' })
  errorMessage?: string | null;

  @ApiPropertyOptional({ description: 'Error code' })
  errorCode?: string | null;

  @ApiProperty({ description: 'Retry count' })
  retryCount: number;

  @ApiProperty({ description: 'Maximum retries' })
  maxRetries: number;

  @ApiPropertyOptional({ description: 'Worker ID' })
  workerId?: string | null;

  @ApiProperty({ description: 'Tenant ID' })
  tenantId: string;

  @ApiProperty({ description: 'Created at timestamp' })
  createdAt: Date;

  @ApiProperty({ description: 'Updated at timestamp' })
  updatedAt: Date;

  @ApiPropertyOptional({ description: 'Created by user ID' })
  createdBy?: string | null;
}

export class PaginatedTranscriptionJobResponse {
  @ApiProperty({ type: [TranscriptionJobResponse] })
  data: TranscriptionJobResponse[];

  @ApiProperty({ description: 'Total number of records' })
  total: number;

  @ApiProperty({ description: 'Current page number' })
  page: number;

  @ApiProperty({ description: 'Number of records per page' })
  limit: number;

  @ApiProperty({ description: 'Total number of pages' })
  totalPages: number;
}

export class TranscriptionJobStatusCountResponse {
  @ApiProperty({ description: 'Number of queued jobs' })
  queued: number;

  @ApiProperty({ description: 'Number of processing jobs' })
  processing: number;

  @ApiProperty({ description: 'Number of completed jobs' })
  completed: number;

  @ApiProperty({ description: 'Number of failed jobs' })
  failed: number;

  @ApiProperty({ description: 'Number of cancelled jobs' })
  cancelled: number;

  @ApiProperty({ description: 'Number of dead jobs' })
  dead: number;
}
