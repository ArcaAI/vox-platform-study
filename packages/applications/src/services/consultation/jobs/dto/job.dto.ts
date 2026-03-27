import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// =============================================================================
// Job Status Types
// =============================================================================

export type JobStatusType = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type JobType = 'PRE_SUMMARY' | 'SUMMARY' | 'COMPREHENSIVE_SUMMARY' | 'NER';

// =============================================================================
// Job Payload Interfaces (Internal - used by processors)
// =============================================================================

export interface GeneratePreSummaryJobPayload {
  jobId: string;
  consultationId: string;
  tenantId: string;
  userId: string;
  request: {
    dnaStyleId?: string;
    caseNoteIds?: string[];
    options?: Record<string, unknown>;
  };
  callbackUrl?: string;
}

export interface GenerateSummaryJobPayload {
  jobId: string;
  consultationId: string;
  tenantId: string;
  userId: string;
  request: {
    dnaStyleId?: string;
    template?: string;
    includeNER?: boolean;
    contextItemIds?: string[];
    options?: Record<string, unknown>;
  };
  callbackUrl?: string;
}

export interface GenerateComprehensiveSummaryJobPayload {
  jobId: string;
  consultationId: string;
  tenantId: string;
  userId: string;
  request: {
    dnaStyleId?: string;
    template?: string;
    includeNER?: boolean;
    includeLabResults?: boolean;
    options?: Record<string, unknown>;
  };
  callbackUrl?: string;
}

export interface ExtractNerJobPayload {
  jobId: string;
  contextItemId: string;
  consultationId: string;
  tenantId: string;
  userId: string;
  callbackUrl?: string;
}

// =============================================================================
// Job Status Interface (Stored in Redis)
// =============================================================================

export interface ConsultationJobStatus {
  jobId: string;
  type: JobType;
  status: JobStatusType;
  consultationId?: string;
  contextItemId?: string;
  progress: number;
  currentStep?: string;
  result?: unknown;
  error?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

// =============================================================================
// API Response DTOs
// =============================================================================

export class JobResponse {
  @ApiProperty({ description: 'Unique job identifier' })
  jobId: string;

  @ApiProperty({
    description: 'Current job status',
    enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  })
  status: JobStatusType;

  @ApiProperty({ description: 'SSE endpoint for real-time updates' })
  sseUrl: string;

  @ApiPropertyOptional({ description: 'WebSocket endpoint for real-time updates' })
  wsUrl?: string;

  @ApiPropertyOptional({ description: 'Estimated completion time in seconds' })
  estimatedSeconds?: number;
}

export class JobStatusResponse {
  @ApiProperty({ description: 'Unique job identifier' })
  jobId: string;

  @ApiProperty({ description: 'Job type', enum: ['PRE_SUMMARY', 'SUMMARY', 'COMPREHENSIVE_SUMMARY', 'NER'] })
  type: JobType;

  @ApiProperty({
    description: 'Current job status',
    enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'],
  })
  status: JobStatusType;

  @ApiPropertyOptional({ description: 'Associated consultation ID' })
  consultationId?: string;

  @ApiPropertyOptional({ description: 'Associated context item ID' })
  contextItemId?: string;

  @ApiProperty({ description: 'Progress percentage 0-100' })
  progress: number;

  @ApiPropertyOptional({ description: 'Current processing step' })
  currentStep?: string;

  @ApiPropertyOptional({ description: 'Result when completed' })
  result?: unknown;

  @ApiPropertyOptional({ description: 'Error message if failed' })
  error?: string;

  @ApiProperty({ description: 'Job creation timestamp' })
  createdAt: Date;

  @ApiPropertyOptional({ description: 'Job start timestamp' })
  startedAt?: Date;

  @ApiPropertyOptional({ description: 'Job completion timestamp' })
  completedAt?: Date;
}

// =============================================================================
// Job Result Interfaces
// =============================================================================

export interface PreSummaryJobResult {
  contextItemId: string;
  content: string;
  summaryMeta?: {
    aiModelId?: string;
    processingTimeMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface SummaryJobResult {
  contextItemId: string;
  content: string;
  summaryMeta?: {
    aiModelId?: string;
    processingTimeMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  namedEntities?: Array<{
    id: string;
    entityType: string;
    value: string;
    confidence?: number;
  }>;
}

export interface NerJobResult {
  contextItemId: string;
  namedEntities: Array<{
    id: string;
    entityType: string;
    value: string;
    confidence?: number;
    startPosition?: number;
    endPosition?: number;
  }>;
}

export interface ComprehensiveSummaryJobResult {
  contextItemId: string;
  content: string;
  sourceConsultationIds: string[];
  sectionCount: number;
  summaryMeta?: {
    aiModelId?: string;
    processingTimeMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  namedEntities?: Record<
    string,
    Array<{
      text: string;
      confidence?: number;
      sourceConsultationId: string;
    }>
  >;
}
