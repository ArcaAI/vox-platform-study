/**
 * TranscriptionJobEntity Unit Tests
 *
 * Tests for the TranscriptionJobEntity that handles transcription job state management.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TranscriptionJobEntity, ITranscriptionJobEntity } from '../TranscriptionJobEntity';
import { TranscriptionJobStatus, TranscriptionJobType, ResourceStatusType } from '../../../../enums';

// Factory function for creating test entities
function createTestEntity(overrides: Partial<ITranscriptionJobEntity> = {}): TranscriptionJobEntity {
  return new TranscriptionJobEntity({
    id: 'job-test-id',
    tenantId: 'tenant-123',
    jobType: TranscriptionJobType.BATCH,
    consultationId: 'consultation-123',
    contextItemId: null,
    mediaId: 'media-123',
    pipelineId: 'pipeline-123',
    status: TranscriptionJobStatus.QUEUED,
    progress: 0,
    queuedAt: new Date('2026-02-02T10:00:00Z'),
    startedAt: null,
    completedAt: null,
    resultText: null,
    resultMetadata: null,
    errorMessage: null,
    errorCode: null,
    retryCount: 0,
    maxRetries: 3,
    workerId: null,
    createdBy: 'user-123',
    updatedBy: null,
    createdAt: new Date('2026-02-02T10:00:00Z'),
    updatedAt: new Date('2026-02-02T10:00:00Z'),
    resourceStatus: ResourceStatusType.ENABLED,
    metaData: null,
    version: 1,
    ...overrides,
  });
}

describe('TranscriptionJobEntity', () => {
  describe('constructor', () => {
    it('should initialize with provided values', () => {
      const entity = createTestEntity();

      expect(entity.id).toBe('job-test-id');
      expect(entity.tenantId).toBe('tenant-123');
      expect(entity.jobType).toBe(TranscriptionJobType.BATCH);
      expect(entity.pipelineId).toBe('pipeline-123');
      expect(entity.status).toBe(TranscriptionJobStatus.QUEUED);
      expect(entity.progress).toBe(0);
      expect(entity.retryCount).toBe(0);
      expect(entity.maxRetries).toBe(3);
    });
  });

  describe('job type helpers', () => {
    it('isBatch should return true for BATCH jobs', () => {
      const entity = createTestEntity({ jobType: TranscriptionJobType.BATCH });
      expect(entity.isBatch).toBe(true);
      expect(entity.isStreaming).toBe(false);
    });

    it('isStreaming should return true for STREAMING jobs', () => {
      const entity = createTestEntity({ jobType: TranscriptionJobType.STREAMING });
      expect(entity.isStreaming).toBe(true);
      expect(entity.isBatch).toBe(false);
    });
  });

  describe('status helpers', () => {
    it('isQueued should return true only for QUEUED status', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.QUEUED });
      expect(entity.isQueued).toBe(true);
      expect(entity.isProcessing).toBe(false);
      expect(entity.isCompleted).toBe(false);
      expect(entity.isFailed).toBe(false);
    });

    it('isProcessing should return true only for PROCESSING status', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.PROCESSING });
      expect(entity.isProcessing).toBe(true);
      expect(entity.isQueued).toBe(false);
    });

    it('isCompleted should return true only for COMPLETED status', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.COMPLETED });
      expect(entity.isCompleted).toBe(true);
    });

    it('isFailed should return true only for FAILED status', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.FAILED });
      expect(entity.isFailed).toBe(true);
    });

    it('isCancelled should return true only for CANCELLED status', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.CANCELLED });
      expect(entity.isCancelled).toBe(true);
    });

    it('isDead should return true only for DEAD status', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.DEAD });
      expect(entity.isDead).toBe(true);
    });

    it('isTerminal should return true for terminal states', () => {
      const terminalStatuses = [
        TranscriptionJobStatus.COMPLETED,
        TranscriptionJobStatus.FAILED,
        TranscriptionJobStatus.CANCELLED,
        TranscriptionJobStatus.DEAD,
      ];

      terminalStatuses.forEach((status) => {
        const entity = createTestEntity({ status });
        expect(entity.isTerminal).toBe(true);
      });
    });

    it('isTerminal should return false for non-terminal states', () => {
      const nonTerminalStatuses = [TranscriptionJobStatus.QUEUED, TranscriptionJobStatus.PROCESSING];

      nonTerminalStatuses.forEach((status) => {
        const entity = createTestEntity({ status });
        expect(entity.isTerminal).toBe(false);
      });
    });
  });

  describe('canRetry', () => {
    it('should return true when failed and retryCount < maxRetries', () => {
      const entity = createTestEntity({
        status: TranscriptionJobStatus.FAILED,
        retryCount: 1,
        maxRetries: 3,
      });
      expect(entity.canRetry).toBe(true);
    });

    it('should return false when retryCount >= maxRetries', () => {
      const entity = createTestEntity({
        status: TranscriptionJobStatus.FAILED,
        retryCount: 3,
        maxRetries: 3,
      });
      expect(entity.canRetry).toBe(false);
    });

    it('should return false when not in FAILED status', () => {
      const entity = createTestEntity({
        status: TranscriptionJobStatus.COMPLETED,
        retryCount: 0,
        maxRetries: 3,
      });
      expect(entity.canRetry).toBe(false);
    });
  });

  describe('durationMs', () => {
    it('should return duration when both startedAt and completedAt are set', () => {
      const entity = createTestEntity({
        startedAt: new Date('2026-02-02T10:00:00Z'),
        completedAt: new Date('2026-02-02T10:01:30Z'), // 90 seconds later
      });
      expect(entity.durationMs).toBe(90000);
    });

    it('should return null when completedAt is not set', () => {
      const entity = createTestEntity({
        startedAt: new Date('2026-02-02T10:00:00Z'),
        completedAt: null,
      });
      expect(entity.durationMs).toBeNull();
    });

    it('should return null when startedAt is not set', () => {
      const entity = createTestEntity({
        startedAt: null,
        completedAt: new Date('2026-02-02T10:01:30Z'),
      });
      expect(entity.durationMs).toBeNull();
    });
  });

  describe('waitTimeMs', () => {
    it('should return wait time when startedAt is set', () => {
      const entity = createTestEntity({
        queuedAt: new Date('2026-02-02T10:00:00Z'),
        startedAt: new Date('2026-02-02T10:00:30Z'), // 30 seconds later
      });
      expect(entity.waitTimeMs).toBe(30000);
    });

    it('should return null when startedAt is not set', () => {
      const entity = createTestEntity({
        queuedAt: new Date('2026-02-02T10:00:00Z'),
        startedAt: null,
      });
      expect(entity.waitTimeMs).toBeNull();
    });
  });

  describe('startProcessing', () => {
    it('should transition job from QUEUED to PROCESSING', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.QUEUED });

      entity.startProcessing('worker-001');

      expect(entity.status).toBe(TranscriptionJobStatus.PROCESSING);
      expect(entity.workerId).toBe('worker-001');
      expect(entity.startedAt).not.toBeNull();
      expect(entity.progress).toBe(0);
      expect(entity.hasChanges).toBe(true);
    });

    it('should throw error when job is not QUEUED', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.PROCESSING });

      expect(() => entity.startProcessing('worker-001')).toThrow('Cannot start job in PROCESSING status');
    });
  });

  describe('updateProgress', () => {
    it('should update progress within valid range', () => {
      const entity = createTestEntity();

      entity.updateProgress(50);

      expect(entity.progress).toBe(50);
      expect(entity.hasChanges).toBe(true);
    });

    it('should throw error for progress below 0', () => {
      const entity = createTestEntity();

      expect(() => entity.updateProgress(-1)).toThrow('Progress must be between 0 and 100');
    });

    it('should throw error for progress above 100', () => {
      const entity = createTestEntity();

      expect(() => entity.updateProgress(101)).toThrow('Progress must be between 0 and 100');
    });
  });

  describe('complete', () => {
    it('should mark job as completed with results', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.PROCESSING });
      const resultText = 'This is the transcription result.';
      const resultMetadata = { confidence: 0.95 };

      entity.complete(resultText, resultMetadata);

      expect(entity.status).toBe(TranscriptionJobStatus.COMPLETED);
      expect(entity.resultText).toBe(resultText);
      expect(entity.resultMetadata).toEqual(resultMetadata);
      expect(entity.progress).toBe(100);
      expect(entity.completedAt).not.toBeNull();
    });

    it('should throw error when job is not PROCESSING', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.QUEUED });

      expect(() => entity.complete('result')).toThrow('Cannot complete job in QUEUED status');
    });
  });

  describe('fail', () => {
    it('should mark job as failed with error details', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.PROCESSING });

      entity.fail('Audio file is corrupted', 'AUDIO_CORRUPT');

      expect(entity.status).toBe(TranscriptionJobStatus.FAILED);
      expect(entity.errorMessage).toBe('Audio file is corrupted');
      expect(entity.errorCode).toBe('AUDIO_CORRUPT');
      expect(entity.completedAt).not.toBeNull();
    });

    it('should fail job without error code', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.PROCESSING });

      entity.fail('Unknown error');

      expect(entity.status).toBe(TranscriptionJobStatus.FAILED);
      expect(entity.errorMessage).toBe('Unknown error');
      expect(entity.errorCode).toBeNull();
    });

    it('should throw error when job is in terminal state', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.COMPLETED });

      expect(() => entity.fail('Error')).toThrow('Cannot fail job in COMPLETED status');
    });
  });

  describe('incrementRetry', () => {
    it('should increment retry count and reset job to QUEUED', () => {
      const entity = createTestEntity({
        status: TranscriptionJobStatus.FAILED,
        retryCount: 1,
        maxRetries: 3,
        workerId: 'worker-001',
        errorMessage: 'Previous error',
      });

      const result = entity.incrementRetry();

      expect(result).toBe(true);
      expect(entity.retryCount).toBe(2);
      expect(entity.status).toBe(TranscriptionJobStatus.QUEUED);
      expect(entity.workerId).toBeNull();
      expect(entity.errorMessage).toBeNull();
      expect(entity.progress).toBe(0);
    });

    it('should return false when max retries reached', () => {
      const entity = createTestEntity({
        status: TranscriptionJobStatus.FAILED,
        retryCount: 3,
        maxRetries: 3,
      });

      const result = entity.incrementRetry();

      expect(result).toBe(false);
      expect(entity.retryCount).toBe(3); // Unchanged
    });

    it('should return false when job is not failed', () => {
      const entity = createTestEntity({
        status: TranscriptionJobStatus.COMPLETED,
        retryCount: 0,
        maxRetries: 3,
      });

      const result = entity.incrementRetry();

      expect(result).toBe(false);
    });
  });

  describe('markAsDead', () => {
    it('should mark job as DEAD', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.FAILED });

      entity.markAsDead();

      expect(entity.status).toBe(TranscriptionJobStatus.DEAD);
      expect(entity.completedAt).not.toBeNull();
    });
  });

  describe('cancel', () => {
    it('should cancel job in QUEUED status', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.QUEUED });

      entity.cancel();

      expect(entity.status).toBe(TranscriptionJobStatus.CANCELLED);
      expect(entity.completedAt).not.toBeNull();
    });

    it('should cancel job in PROCESSING status', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.PROCESSING });

      entity.cancel();

      expect(entity.status).toBe(TranscriptionJobStatus.CANCELLED);
    });

    it('should throw error when job is in terminal state', () => {
      const entity = createTestEntity({ status: TranscriptionJobStatus.COMPLETED });

      expect(() => entity.cancel()).toThrow('Cannot cancel job in COMPLETED status');
    });
  });

  describe('setContextItem', () => {
    it('should set contextItemId', () => {
      const entity = createTestEntity({ contextItemId: null });

      entity.setContextItem('context-item-123');

      expect(entity.contextItemId).toBe('context-item-123');
      expect(entity.hasChanges).toBe(true);
    });
  });

  describe('validate', () => {
    it('should pass validation for valid entity', () => {
      const entity = createTestEntity();

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw error when the job is keyed to neither a pipeline nor an agent (TASK-861 relaxed pipelineId)', () => {
      const entity = createTestEntity({ pipelineId: '' });

      expect(() => entity.validate()).toThrow('Either agentVersionId or pipelineId is required');
    });

    it('should throw error for invalid progress', () => {
      const entity = createTestEntity();
      entity['_progress'] = -1; // Bypass setter

      expect(() => entity.validate()).toThrow('Progress must be between 0 and 100');
    });

    it('should throw error for negative retryCount', () => {
      const entity = createTestEntity();
      entity['_retryCount'] = -1; // Bypass setter

      expect(() => entity.validate()).toThrow('Retry count cannot be negative');
    });

    it('should throw error for negative maxRetries', () => {
      const entity = createTestEntity();
      entity['_maxRetries'] = -1; // Bypass setter

      expect(() => entity.validate()).toThrow('Max retries cannot be negative');
    });
  });

  describe('change tracking', () => {
    it('should track changes when properties are modified', () => {
      const entity = createTestEntity();

      entity.progress = 50;

      expect(entity.hasChanges).toBe(true);
      expect(entity.changes).toHaveProperty('progress', 50);
    });

    it('should clear changes', () => {
      const entity = createTestEntity();
      entity.progress = 50;

      expect(entity.hasChanges).toBe(true);

      entity.clearChanges();

      expect(entity.hasChanges).toBe(false);
      expect(entity.changes).toEqual({});
    });
  });

  describe('job lifecycle', () => {
    it('should handle complete batch job lifecycle', () => {
      const entity = createTestEntity({
        jobType: TranscriptionJobType.BATCH,
        status: TranscriptionJobStatus.QUEUED,
      });

      // Start processing
      entity.startProcessing('worker-001');
      expect(entity.isProcessing).toBe(true);

      // Update progress
      entity.updateProgress(50);
      expect(entity.progress).toBe(50);

      // Complete
      entity.complete('Transcription result', { confidence: 0.9 });
      expect(entity.isCompleted).toBe(true);
      expect(entity.resultText).toBe('Transcription result');
    });

    it('should handle failed job with retry lifecycle', () => {
      const entity = createTestEntity({
        jobType: TranscriptionJobType.BATCH,
        status: TranscriptionJobStatus.QUEUED,
      });

      // Start processing
      entity.startProcessing('worker-001');

      // Fail
      entity.fail('Timeout', 'TIMEOUT');
      expect(entity.isFailed).toBe(true);
      expect(entity.canRetry).toBe(true);

      // Retry
      const retried = entity.incrementRetry();
      expect(retried).toBe(true);
      expect(entity.isQueued).toBe(true);
      expect(entity.retryCount).toBe(1);

      // Start again
      entity.startProcessing('worker-002');
      expect(entity.workerId).toBe('worker-002');
    });
  });
});

// TASK-861 — a job is keyed EITHER to the deprecated pipeline row OR to the ASR
// Agent version that ran it (+ the resolved spec snapshot). Exactly what the
// migration `task_861_transcription_job_agent_version` allows.
describe('TranscriptionJobEntity — agent re-key (TASK-861)', () => {
  const resolvedSpec = { schemaVersion: 1, runtimeKey: 'agent-v-1', models: { asr: { slug: 'whisper' } } };

  it('validates an agent-keyed job with no pipelineId', () => {
    const entity = createTestEntity({ pipelineId: null, agentVersionId: 'agent-v-1', resolvedSpec });
    expect(() => entity.validate()).not.toThrow();
    expect(entity.agentVersionId).toBe('agent-v-1');
    expect(entity.resolvedSpec).toEqual(resolvedSpec);
    expect(entity.pipelineId).toBeNull();
  });

  it('still validates a legacy pipeline-keyed job (history rows stay readable)', () => {
    const entity = createTestEntity({ pipelineId: 'pipeline-123', agentVersionId: null, resolvedSpec: null });
    expect(() => entity.validate()).not.toThrow();
  });

  it('rejects a job keyed to neither — an unattributable job is never persisted', () => {
    const entity = createTestEntity({ pipelineId: null, agentVersionId: null, resolvedSpec: null });
    expect(() => entity.validate()).toThrow(/agentVersionId|pipelineId/);
  });

  it('rejects an agentVersionId without its resolvedSpec snapshot (the job must be reproducible from its row)', () => {
    const entity = createTestEntity({ pipelineId: null, agentVersionId: 'agent-v-1', resolvedSpec: null });
    expect(() => entity.validate()).toThrow(/resolvedSpec/);
  });

  it('tracks agentVersionId / resolvedSpec as change-tracked properties', () => {
    const entity = createTestEntity();
    entity.agentVersionId = 'agent-v-2';
    entity.resolvedSpec = resolvedSpec;
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes).toMatchObject({ agentVersionId: 'agent-v-2', resolvedSpec });
  });
});
