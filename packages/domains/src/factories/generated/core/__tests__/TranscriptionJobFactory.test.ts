/**
 * TranscriptionJobFactory Unit Tests
 *
 * Tests for the TranscriptionJobFactory that creates TranscriptionJob entities.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranscriptionJobFactory, CreateTranscriptionJobProps, CreateBatchJobProps, CreateStreamingJobProps } from '../TranscriptionJobFactory';
import { TranscriptionJobType, TranscriptionJobStatus } from '../../../../enums';

// Mock the generateId function
vi.mock('../../../../utils', () => ({
  generateId: vi.fn(() => 'generated-uuid-7'),
}));

describe('TranscriptionJobFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('CreateTranscriptionJob', () => {
    const baseProps: CreateTranscriptionJobProps = {
      tenantId: 'tenant-123',
      jobType: TranscriptionJobType.BATCH,
      pipelineId: 'pipeline-123',
    };

    it('should create a transcription job with required fields', () => {
      const job = TranscriptionJobFactory.CreateTranscriptionJob(baseProps);

      expect(job.id).toBe('generated-uuid-7');
      expect(job.tenantId).toBe('tenant-123');
      expect(job.jobType).toBe(TranscriptionJobType.BATCH);
      expect(job.pipelineId).toBe('pipeline-123');
    });

    it('should default status to QUEUED', () => {
      const job = TranscriptionJobFactory.CreateTranscriptionJob(baseProps);

      expect(job.status).toBe(TranscriptionJobStatus.QUEUED);
    });

    it('should default progress to 0', () => {
      const job = TranscriptionJobFactory.CreateTranscriptionJob(baseProps);

      expect(job.progress).toBe(0);
    });

    it('should default retryCount to 0', () => {
      const job = TranscriptionJobFactory.CreateTranscriptionJob(baseProps);

      expect(job.retryCount).toBe(0);
    });

    it('should default maxRetries to 3', () => {
      const job = TranscriptionJobFactory.CreateTranscriptionJob(baseProps);

      expect(job.maxRetries).toBe(3);
    });

    it('should allow custom maxRetries', () => {
      const job = TranscriptionJobFactory.CreateTranscriptionJob({
        ...baseProps,
        maxRetries: 5,
      });

      expect(job.maxRetries).toBe(5);
    });

    it('should set queuedAt to current time', () => {
      const beforeCreate = new Date();
      const job = TranscriptionJobFactory.CreateTranscriptionJob(baseProps);
      const afterCreate = new Date();

      expect(job.queuedAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());
      expect(job.queuedAt.getTime()).toBeLessThanOrEqual(afterCreate.getTime());
    });

    it('should set createdAt and updatedAt to current time', () => {
      const beforeCreate = new Date();
      const job = TranscriptionJobFactory.CreateTranscriptionJob(baseProps);
      const afterCreate = new Date();

      expect(job.createdAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());
      expect(job.createdAt.getTime()).toBeLessThanOrEqual(afterCreate.getTime());
      expect(job.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());
      expect(job.updatedAt.getTime()).toBeLessThanOrEqual(afterCreate.getTime());
    });

    it('should allow custom createdAt and updatedAt', () => {
      const customDate = new Date('2026-01-15T10:00:00Z');
      const job = TranscriptionJobFactory.CreateTranscriptionJob({
        ...baseProps,
        createdAt: customDate,
        updatedAt: customDate,
      });

      expect(job.createdAt).toEqual(customDate);
      expect(job.updatedAt).toEqual(customDate);
    });

    it('should set optional consultationId', () => {
      const job = TranscriptionJobFactory.CreateTranscriptionJob({
        ...baseProps,
        consultationId: 'consultation-123',
      });

      expect(job.consultationId).toBe('consultation-123');
    });

    it('should default consultationId to null', () => {
      const job = TranscriptionJobFactory.CreateTranscriptionJob(baseProps);

      expect(job.consultationId).toBeNull();
    });

    it('should set optional mediaId', () => {
      const job = TranscriptionJobFactory.CreateTranscriptionJob({
        ...baseProps,
        mediaId: 'media-123',
      });

      expect(job.mediaId).toBe('media-123');
    });

    it('should default mediaId to null', () => {
      const job = TranscriptionJobFactory.CreateTranscriptionJob(baseProps);

      expect(job.mediaId).toBeNull();
    });

    it('should set createdBy when provided', () => {
      const job = TranscriptionJobFactory.CreateTranscriptionJob({
        ...baseProps,
        createdBy: 'user-123',
      });

      expect(job.createdBy).toBe('user-123');
    });

    it('should default createdBy to null', () => {
      const job = TranscriptionJobFactory.CreateTranscriptionJob(baseProps);

      expect(job.createdBy).toBeNull();
    });

    it('should initialize all nullable fields to null', () => {
      const job = TranscriptionJobFactory.CreateTranscriptionJob(baseProps);

      expect(job.startedAt).toBeNull();
      expect(job.completedAt).toBeNull();
      expect(job.resultText).toBeNull();
      expect(job.resultMetadata).toBeNull();
      expect(job.errorMessage).toBeNull();
      expect(job.errorCode).toBeNull();
      expect(job.workerId).toBeNull();
      // contextItemId is not set by factory - it's set later via setContextItem
      expect(job.contextItemId === null || job.contextItemId === undefined).toBe(true);
    });

    it('should create entity that passes validation', () => {
      const job = TranscriptionJobFactory.CreateTranscriptionJob(baseProps);

      expect(() => job.validate()).not.toThrow();
    });
  });

  describe('CreateBatchJob', () => {
    const batchProps: CreateBatchJobProps = {
      tenantId: 'tenant-123',
      pipelineId: 'pipeline-123',
      mediaId: 'media-123',
    };

    it('should create a batch job with BATCH type', () => {
      const job = TranscriptionJobFactory.CreateBatchJob(batchProps);

      expect(job.jobType).toBe(TranscriptionJobType.BATCH);
      expect(job.isBatch).toBe(true);
    });

    it('should require mediaId for batch jobs', () => {
      const job = TranscriptionJobFactory.CreateBatchJob(batchProps);

      expect(job.mediaId).toBe('media-123');
    });

    it('should set all other defaults like CreateTranscriptionJob', () => {
      const job = TranscriptionJobFactory.CreateBatchJob(batchProps);

      expect(job.status).toBe(TranscriptionJobStatus.QUEUED);
      expect(job.progress).toBe(0);
      expect(job.retryCount).toBe(0);
      expect(job.maxRetries).toBe(3);
    });

    it('should allow optional consultationId', () => {
      const job = TranscriptionJobFactory.CreateBatchJob({
        ...batchProps,
        consultationId: 'consultation-123',
      });

      expect(job.consultationId).toBe('consultation-123');
    });

    it('should allow custom maxRetries', () => {
      const job = TranscriptionJobFactory.CreateBatchJob({
        ...batchProps,
        maxRetries: 5,
      });

      expect(job.maxRetries).toBe(5);
    });
  });

  describe('CreateStreamingJob', () => {
    const streamingProps: CreateStreamingJobProps = {
      tenantId: 'tenant-123',
      pipelineId: 'pipeline-123',
    };

    it('should create a streaming job with STREAMING type', () => {
      const job = TranscriptionJobFactory.CreateStreamingJob(streamingProps);

      expect(job.jobType).toBe(TranscriptionJobType.STREAMING);
      expect(job.isStreaming).toBe(true);
    });

    it('should not require mediaId for streaming jobs', () => {
      const job = TranscriptionJobFactory.CreateStreamingJob(streamingProps);

      expect(job.mediaId).toBeNull();
    });

    it('should allow optional mediaId for streaming jobs', () => {
      const job = TranscriptionJobFactory.CreateStreamingJob({
        ...streamingProps,
        mediaId: 'media-optional',
      });

      expect(job.mediaId).toBe('media-optional');
    });

    it('should set all other defaults like CreateTranscriptionJob', () => {
      const job = TranscriptionJobFactory.CreateStreamingJob(streamingProps);

      expect(job.status).toBe(TranscriptionJobStatus.QUEUED);
      expect(job.progress).toBe(0);
      expect(job.retryCount).toBe(0);
      expect(job.maxRetries).toBe(3);
    });

    it('should allow optional consultationId', () => {
      const job = TranscriptionJobFactory.CreateStreamingJob({
        ...streamingProps,
        consultationId: 'consultation-123',
      });

      expect(job.consultationId).toBe('consultation-123');
    });
  });

  describe('entity state after creation', () => {
    it('should create entity with no changes tracked', () => {
      const job = TranscriptionJobFactory.CreateTranscriptionJob({
        tenantId: 'tenant-123',
        jobType: TranscriptionJobType.BATCH,
        pipelineId: 'pipeline-123',
      });

      expect(job.hasChanges).toBe(false);
      expect(job.changes).toEqual({});
    });

    it('should create entity that can be started', () => {
      const job = TranscriptionJobFactory.CreateTranscriptionJob({
        tenantId: 'tenant-123',
        jobType: TranscriptionJobType.BATCH,
        pipelineId: 'pipeline-123',
      });

      expect(job.isQueued).toBe(true);
      expect(() => job.startProcessing('worker-001')).not.toThrow();
      expect(job.isProcessing).toBe(true);
    });
  });
});

// TASK-861 — the agent path creates jobs without a pipeline row.
describe('TranscriptionJobFactory — agent re-key (TASK-861)', () => {
  const resolvedSpec = { schemaVersion: 1, runtimeKey: 'agent-v-1' };

  it('creates an agent-keyed batch job with no pipelineId', () => {
    const job = TranscriptionJobFactory.CreateBatchJob({
      tenantId: 'tenant-123',
      mediaId: 'media-1',
      agentVersionId: 'agent-v-1',
      resolvedSpec,
    });
    expect(job.pipelineId).toBeNull();
    expect(job.agentVersionId).toBe('agent-v-1');
    expect(job.resolvedSpec).toEqual(resolvedSpec);
    expect(() => job.validate()).not.toThrow();
  });

  it('keeps the deprecated pipeline path working for the window', () => {
    const job = TranscriptionJobFactory.CreateStreamingJob({ tenantId: 'tenant-123', pipelineId: 'pipeline-123' });
    expect(job.pipelineId).toBe('pipeline-123');
    expect(job.agentVersionId).toBeNull();
    expect(job.resolvedSpec).toBeNull();
  });
});
