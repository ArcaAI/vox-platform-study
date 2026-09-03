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

/**
 * In-memory + Redis-persisted job status struct used by
 * `ConsultationJobService` and surfaced over HTTP via `JobStatusResponse`.
 *
 * Release-window risk: `tenantId` and `userId` are typed as REQUIRED, but
 * jobs created before this shape was adopted (`d969b25c`) were persisted to
 * Redis without these fields. The JOB_TTL is 24h, so for up to 24h after any
 * such deploy `getJobStatus()` may return a parsed struct whose `tenantId` /
 * `userId` are actually `undefined` at runtime even though the TS type
 * says otherwise. Downstream consumers (the `@TenantOwnedResource`
 * interceptor) will treat an `undefined` tenantId as a tenant-mismatch
 * → 404, so old jobs are not leaked cross-tenant; they are merely
 * unreadable for the remaining 24h of their TTL.
 */
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
  tenantId: string;
  userId: string;
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

  @ApiProperty({ description: 'Owning tenant id (ownership check carry-through)' })
  tenantId: string;

  @ApiProperty({ description: 'Owning user id (ownership check carry-through)' })
  userId: string;
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
  /**
   * set when this job was routed to the harness document workflow
   * instead of running legacy generation. `contextItemId`/`content` are empty
   * in that case: the harness produces the note asynchronously via its own
   * callback path into HarnessInternalController, not this BullMQ job.
   */
  harnessJobId?: string;
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
