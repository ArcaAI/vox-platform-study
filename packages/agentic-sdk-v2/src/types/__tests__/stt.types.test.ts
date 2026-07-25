/**
 * @arcaai/vox - STT Types Tests
 * @vitest-environment jsdom
 *
 * Tests for new type definitions required by Layer 0 (Foundation).
 * These types must align with backend DTOs from:
 * - apps/api/src/modules/stt/dto/
 * - packages/applications/src/services/stt/
 * - packages/domains/src/enums/generated/
 */

import { describe, it, expect } from 'vitest';
import type {
  // Streaming session types
  CreateStreamingSessionRequest,
  StreamingSessionResponse,
  StreamingSessionStatus,
  // WebSocket protocol types (client → server)
  WsAudioFrame,
  WsStopMessage,
  WsCloseMessage,
  WsClientMessage,
  // WebSocket protocol types (server → client)
  WsTranscriptResult,
  WsStatusMessage,
  WsErrorMessage,
  WsServerMessage,
  // Transcription job types
  TranscriptionJobResponse,
  TranscriptionJobStatusCounts,
  // Pipeline types
  AsrPipelineResponse,
  // AI Model types
  AiModelResponse,
} from '../stt';

import {
  TranscriptionJobType,
  TranscriptionJobStatus,
  AiModelDownloadStatus,
  ResourceStatus,
} from '../stt';

// =============================================================================
// Streaming Session Types
// =============================================================================

describe('STT types', () => {
  describe('CreateStreamingSessionRequest', () => {
    it('should accept valid request with required fields only', () => {
      const req: CreateStreamingSessionRequest = {
        pipelineId: 'pipe-uuid-123',
      };
      expect(req.pipelineId).toBe('pipe-uuid-123');
      expect(req.consultationId).toBeUndefined();
      expect(req.sampleRate).toBeUndefined();
      expect(req.language).toBeUndefined();
      expect(req.codeSwitching).toBeUndefined();
      expect(req.microphoneId).toBeUndefined();
    });

    it('should accept valid request with all optional fields', () => {
      const req: CreateStreamingSessionRequest = {
        pipelineId: 'pipe-uuid-123',
        consultationId: 'consult-uuid-456',
        sampleRate: 16000,
        language: 'en',
        codeSwitching: true,
        microphoneId: 'mic-device-1',
      };
      expect(req.pipelineId).toBe('pipe-uuid-123');
      expect(req.consultationId).toBe('consult-uuid-456');
      expect(req.sampleRate).toBe(16000);
      expect(req.language).toBe('en');
      expect(req.codeSwitching).toBe(true);
      expect(req.microphoneId).toBe('mic-device-1');
    });
  });

  describe('StreamingSessionResponse', () => {
    it('should contain all expected fields from backend', () => {
      const response: StreamingSessionResponse = {
        sessionId: 'session-abc',
        status: 'active',
        maxConcurrent: 5,
        currentActive: 2,
        wsUrl: '/ws/stt/stream',
      };
      expect(response.sessionId).toBe('session-abc');
      expect(response.status).toBe('active');
      expect(response.maxConcurrent).toBe(5);
      expect(response.currentActive).toBe(2);
      expect(response.wsUrl).toBe('/ws/stt/stream');
    });
  });

  describe('StreamingSessionResponse with edge case values', () => {
    it('should handle zero concurrency values', () => {
      const response: StreamingSessionResponse = {
        sessionId: 'session-edge',
        status: 'rejected',
        maxConcurrent: 0,
        currentActive: 0,
        wsUrl: '/ws/stt/stream',
      };
      expect(response.maxConcurrent).toBe(0);
      expect(response.currentActive).toBe(0);
      expect(response.status).toBe('rejected');
    });
  });

  describe('StreamingSessionStatus', () => {
    it('should accept all valid status values', () => {
      const statuses: StreamingSessionStatus[] = [
        'active', 'finalizing', 'closed', 'rejected',
      ];
      expect(statuses).toHaveLength(4);
    });
  });

  // =============================================================================
  // WebSocket Protocol Types
  // =============================================================================

  describe('WebSocket Client Messages', () => {
    it('should create valid WsAudioFrame with base64 data', () => {
      const frame: WsAudioFrame = {
        type: 'audio',
        seq: 42,
        data: 'SGVsbG8gV29ybGQ=',
      };
      expect(frame.type).toBe('audio');
      expect(frame.seq).toBe(42);
      expect(frame.data).toBe('SGVsbG8gV29ybGQ=');
      expect(frame.microphoneId).toBeUndefined();
    });

    it('should create WsAudioFrame with optional microphoneId', () => {
      const frame: WsAudioFrame = {
        type: 'audio',
        seq: 1,
        data: 'base64data',
        microphoneId: 'mic-1',
      };
      expect(frame.microphoneId).toBe('mic-1');
    });

    it('should create valid WsStopMessage', () => {
      const msg: WsStopMessage = { type: 'stop' };
      expect(msg.type).toBe('stop');
    });

    it('should create valid WsCloseMessage', () => {
      const msg: WsCloseMessage = { type: 'close' };
      expect(msg.type).toBe('close');
    });

    it('should support WsClientMessage union type', () => {
      const messages: WsClientMessage[] = [
        { type: 'audio', seq: 1, data: 'data' },
        { type: 'stop' },
        { type: 'close' },
      ];
      expect(messages).toHaveLength(3);
    });
  });

  describe('WebSocket Server Messages', () => {
    it('should create valid WsTranscriptResult', () => {
      const result: WsTranscriptResult = {
        type: 'transcript',
        text: 'The patient presented with chest pain.',
        startTime: 1.5,
        endTime: 4.2,
        isFinal: true,
      };
      expect(result.type).toBe('transcript');
      expect(result.text).toBe('The patient presented with chest pain.');
      expect(result.startTime).toBe(1.5);
      expect(result.endTime).toBe(4.2);
      expect(result.isFinal).toBe(true);
    });

    it('should create valid WsStatusMessage', () => {
      const msg: WsStatusMessage = {
        type: 'status',
        status: 'connected',
        message: 'Session active',
      };
      expect(msg.type).toBe('status');
      expect(msg.status).toBe('connected');
      expect(msg.message).toBe('Session active');
    });

    it('should create valid WsErrorMessage', () => {
      const msg: WsErrorMessage = {
        type: 'error',
        code: 'SESSION_EXPIRED',
        message: 'Streaming session has expired',
      };
      expect(msg.type).toBe('error');
      expect(msg.code).toBe('SESSION_EXPIRED');
      expect(msg.message).toBe('Streaming session has expired');
    });

    it('should support WsServerMessage union type', () => {
      const messages: WsServerMessage[] = [
        { type: 'transcript', text: 'hello', startTime: 0, endTime: 1, isFinal: false },
        { type: 'status', status: 'connected', message: 'ok' },
        { type: 'error', code: 'ERR', message: 'failed' },
      ];
      expect(messages).toHaveLength(3);
    });
  });

  // =============================================================================
  // Transcription Job Types
  // =============================================================================

  describe('TranscriptionJobType enum', () => {
    it('should have BATCH value', () => {
      expect(TranscriptionJobType.BATCH).toBe('BATCH');
    });

    it('should have STREAMING value', () => {
      expect(TranscriptionJobType.STREAMING).toBe('STREAMING');
    });
  });

  describe('TranscriptionJobStatus enum', () => {
    it('should have all status values', () => {
      expect(TranscriptionJobStatus.QUEUED).toBe('QUEUED');
      expect(TranscriptionJobStatus.PROCESSING).toBe('PROCESSING');
      expect(TranscriptionJobStatus.COMPLETED).toBe('COMPLETED');
      expect(TranscriptionJobStatus.FAILED).toBe('FAILED');
      expect(TranscriptionJobStatus.CANCELLED).toBe('CANCELLED');
      expect(TranscriptionJobStatus.DEAD).toBe('DEAD');
    });
  });

  describe('TranscriptionJobResponse', () => {
    it('should contain all required fields from backend', () => {
      const job: TranscriptionJobResponse = {
        id: 'job-uuid-123',
        jobType: TranscriptionJobType.STREAMING,
        pipelineId: 'pipe-uuid-456',
        status: TranscriptionJobStatus.PROCESSING,
        progress: 45,
        retryCount: 0,
        maxRetries: 3,
        tenantId: 'tenant-1',
        createdAt: '2026-02-17T10:00:00Z',
        updatedAt: '2026-02-17T10:05:00Z',
      };
      expect(job.id).toBe('job-uuid-123');
      expect(job.jobType).toBe('STREAMING');
      expect(job.status).toBe('PROCESSING');
      expect(job.progress).toBe(45);
    });

    it('should accept all optional fields', () => {
      const job: TranscriptionJobResponse = {
        id: 'job-uuid-123',
        jobType: TranscriptionJobType.BATCH,
        pipelineId: 'pipe-uuid-456',
        status: TranscriptionJobStatus.COMPLETED,
        progress: 100,
        retryCount: 1,
        maxRetries: 3,
        tenantId: 'tenant-1',
        createdAt: '2026-02-17T10:00:00Z',
        updatedAt: '2026-02-17T10:05:00Z',
        consultationId: 'consult-789',
        contextItemId: 'ctx-abc',
        mediaId: 'media-def',
        queuedAt: '2026-02-17T10:00:00Z',
        startedAt: '2026-02-17T10:01:00Z',
        completedAt: '2026-02-17T10:05:00Z',
        resultText: 'The patient said...',
        resultMetadata: { confidence: 0.95 },
        errorMessage: null,
        errorCode: null,
        workerId: 'worker-1',
        createdBy: 'user-abc',
      };
      expect(job.consultationId).toBe('consult-789');
      expect(job.resultText).toBe('The patient said...');
    });
  });

  describe('TranscriptionJobStatusCounts', () => {
    it('should contain all status count fields', () => {
      const counts: TranscriptionJobStatusCounts = {
        queued: 5,
        processing: 2,
        completed: 100,
        failed: 3,
        cancelled: 1,
        dead: 0,
      };
      expect(counts.queued).toBe(5);
      expect(counts.processing).toBe(2);
      expect(counts.completed).toBe(100);
      expect(counts.failed).toBe(3);
      expect(counts.cancelled).toBe(1);
      expect(counts.dead).toBe(0);
    });
  });

  // =============================================================================
  // Pipeline Types
  // =============================================================================

  describe('AsrPipelineResponse', () => {
    it('should contain all required fields', () => {
      const pipeline: AsrPipelineResponse = {
        id: 'pipe-uuid-123',
        name: 'Whisper Large V3 Streaming',
        slug: 'whisper-large-v3-streaming',
        configYaml: 'pipeline:\n  model: whisper-large-v3',
        resourceStatus: ResourceStatus.ENABLED,
        tags: ['production', 'streaming'],
        tenantId: 'tenant-1',
        createdAt: '2026-02-17T10:00:00Z',
        updatedAt: '2026-02-17T10:00:00Z',
      };
      expect(pipeline.id).toBe('pipe-uuid-123');
      expect(pipeline.name).toBe('Whisper Large V3 Streaming');
      expect(pipeline.slug).toBe('whisper-large-v3-streaming');
      expect(pipeline.resourceStatus).toBe('ENABLED');
      expect(pipeline.tags).toEqual(['production', 'streaming']);
    });

    it('should accept optional description', () => {
      const pipeline: AsrPipelineResponse = {
        id: 'pipe-1',
        name: 'Test Pipeline',
        slug: 'test-pipeline',
        description: 'A test pipeline for development',
        configYaml: 'pipeline: {}',
        resourceStatus: ResourceStatus.ENABLED,
        tags: [],
        tenantId: 'tenant-1',
        createdAt: '2026-02-17T10:00:00Z',
        updatedAt: '2026-02-17T10:00:00Z',
      };
      expect(pipeline.description).toBe('A test pipeline for development');
    });
  });

  // =============================================================================
  // AI Model Types
  // =============================================================================

  describe('AiModelDownloadStatus enum', () => {
    it('should have all download status values', () => {
      expect(AiModelDownloadStatus.NOT_DOWNLOADED).toBe('NOT_DOWNLOADED');
      expect(AiModelDownloadStatus.DOWNLOADING).toBe('DOWNLOADING');
      expect(AiModelDownloadStatus.DOWNLOADED).toBe('DOWNLOADED');
      expect(AiModelDownloadStatus.DOWNLOAD_FAILED).toBe('DOWNLOAD_FAILED');
    });
  });

  describe('ResourceStatus enum', () => {
    it('should have all resource status values', () => {
      expect(ResourceStatus.ENABLED).toBe('ENABLED');
      expect(ResourceStatus.DISABLED).toBe('DISABLED');
      expect(ResourceStatus.ARCHIVED).toBe('ARCHIVED');
      expect(ResourceStatus.DELETED).toBe('DELETED');
    });
  });

  describe('AiModelResponse', () => {
    it('should contain all required fields from backend', () => {
      const model: AiModelResponse = {
        id: 'model-uuid-123',
        name: 'Whisper Large V3',
        slug: 'whisper-large-v3',
        category: 'AUDIO',
        taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
        modelType: 'BASE_MODEL',
        source: 'HUGGINGFACE',
        sourceUri: 'openai/whisper-large-v3',
        format: 'ONNX',
        downloadStatus: AiModelDownloadStatus.DOWNLOADED,
        resourceStatus: ResourceStatus.ENABLED,
        tags: ['stt', 'whisper', 'production'],
        tenantId: 'tenant-1',
        createdAt: '2026-02-17T10:00:00Z',
        updatedAt: '2026-02-17T10:00:00Z',
      };
      expect(model.id).toBe('model-uuid-123');
      expect(model.name).toBe('Whisper Large V3');
      expect(model.taskType).toBe('AUTOMATIC_SPEECH_RECOGNITION');
      expect(model.downloadStatus).toBe('DOWNLOADED');
    });

    it('should accept all optional fields', () => {
      const model: AiModelResponse = {
        id: 'model-1',
        name: 'Test Model',
        slug: 'test-model',
        description: 'A test model for development',
        category: 'NLP',
        taskType: 'TOKEN_CLASSIFICATION',
        modelType: 'FINETUNED_MODEL',
        source: 'LOCAL',
        sourceUri: '/models/test',
        sourceRevision: 'v2.1',
        format: 'PYTORCH',
        memorySizeMb: 512,
        computeType: 'gpu',
        downloadStatus: AiModelDownloadStatus.DOWNLOADED,
        localPath: '/opt/models/test',
        downloadedAt: '2026-02-17T10:00:00Z',
        fileSizeMb: 256,
        checksum: 'sha256:abc123',
        resourceStatus: ResourceStatus.ENABLED,
        tags: [],
        tenantId: 'tenant-1',
        createdAt: '2026-02-17T10:00:00Z',
        updatedAt: '2026-02-17T10:00:00Z',
        createdBy: 'admin-user',
        updatedBy: 'admin-user',
      };
      expect(model.description).toBe('A test model for development');
      expect(model.memorySizeMb).toBe(512);
      expect(model.sourceRevision).toBe('v2.1');
    });

    it('should accept explicit null for nullable fields (matching backend JSON)', () => {
      const model: AiModelResponse = {
        id: 'model-null',
        name: 'Null Fields Model',
        slug: 'null-fields',
        description: null,
        category: 'AUDIO',
        taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
        modelType: 'BASE_MODEL',
        source: 'HUGGINGFACE',
        sourceUri: 'openai/whisper-tiny',
        sourceRevision: null,
        format: 'ONNX',
        memorySizeMb: null,
        computeType: null,
        downloadStatus: AiModelDownloadStatus.NOT_DOWNLOADED,
        localPath: null,
        downloadedAt: null,
        fileSizeMb: null,
        checksum: null,
        resourceStatus: ResourceStatus.DISABLED,
        tags: [],
        tenantId: 'tenant-1',
        createdAt: '2026-02-17T10:00:00Z',
        updatedAt: '2026-02-17T10:00:00Z',
        createdBy: null,
        updatedBy: null,
      };
      expect(model.description).toBeNull();
      expect(model.sourceRevision).toBeNull();
      expect(model.memorySizeMb).toBeNull();
      expect(model.localPath).toBeNull();
      expect(model.createdBy).toBeNull();
    });
  });

  // =============================================================================
  // Edge Cases & Anti-Pattern Prevention
  // =============================================================================

  describe('Enum exhaustiveness', () => {
    it('TranscriptionJobType should have exactly 2 members', () => {
      const members = Object.values(TranscriptionJobType);
      expect(members).toHaveLength(2);
      expect(members).toEqual(expect.arrayContaining(['BATCH', 'STREAMING']));
    });

    it('TranscriptionJobStatus should have exactly 6 members', () => {
      const members = Object.values(TranscriptionJobStatus);
      expect(members).toHaveLength(6);
      expect(members).toEqual(
        expect.arrayContaining(['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DEAD'])
      );
    });

    it('AiModelDownloadStatus should have exactly 4 members', () => {
      const members = Object.values(AiModelDownloadStatus);
      expect(members).toHaveLength(4);
      expect(members).toEqual(
        expect.arrayContaining(['NOT_DOWNLOADED', 'DOWNLOADING', 'DOWNLOADED', 'DOWNLOAD_FAILED'])
      );
    });

    it('ResourceStatus should have exactly 4 members', () => {
      const members = Object.values(ResourceStatus);
      expect(members).toHaveLength(4);
      expect(members).toEqual(
        expect.arrayContaining(['ENABLED', 'DISABLED', 'ARCHIVED', 'DELETED'])
      );
    });
  });

  describe('WsServerMessage discriminated union narrowing', () => {
    it('should narrow to WsTranscriptResult by type field', () => {
      const msg: WsServerMessage = {
        type: 'transcript',
        text: 'hello world',
        startTime: 0,
        endTime: 1.5,
        isFinal: true,
      };
      if (msg.type === 'transcript') {
        expect(msg.text).toBe('hello world');
        expect(msg.isFinal).toBe(true);
      } else {
        throw new Error('should have narrowed to transcript');
      }
    });

    it('should narrow to WsStatusMessage by type field', () => {
      const msg: WsServerMessage = {
        type: 'status',
        status: 'finalizing',
        message: 'Waiting for final results',
      };
      if (msg.type === 'status') {
        expect(msg.status).toBe('finalizing');
      } else {
        throw new Error('should have narrowed to status');
      }
    });

    it('should narrow to WsErrorMessage by type field', () => {
      const msg: WsServerMessage = {
        type: 'error',
        code: 'TIMEOUT',
        message: 'Session timeout',
      };
      if (msg.type === 'error') {
        expect(msg.code).toBe('TIMEOUT');
      } else {
        throw new Error('should have narrowed to error');
      }
    });
  });

  describe('TranscriptionJobResponse null vs undefined edge cases', () => {
    it('should accept null for all nullable optional fields (backend sends null)', () => {
      const job: TranscriptionJobResponse = {
        id: 'job-1',
        jobType: TranscriptionJobType.BATCH,
        pipelineId: 'pipe-1',
        status: TranscriptionJobStatus.QUEUED,
        progress: 0,
        retryCount: 0,
        maxRetries: 3,
        tenantId: 'tenant-1',
        createdAt: '2026-02-17T10:00:00Z',
        updatedAt: '2026-02-17T10:00:00Z',
        consultationId: null,
        contextItemId: null,
        mediaId: null,
        queuedAt: null,
        startedAt: null,
        completedAt: null,
        resultText: null,
        resultMetadata: null,
        errorMessage: null,
        errorCode: null,
        workerId: null,
        createdBy: null,
      };
      expect(job.consultationId).toBeNull();
      expect(job.resultText).toBeNull();
      expect(job.errorMessage).toBeNull();
      expect(job.progress).toBe(0);
    });

    it('should handle progress boundary values (0 and 100)', () => {
      const queued: TranscriptionJobResponse = {
        id: 'job-q',
        jobType: TranscriptionJobType.STREAMING,
        pipelineId: 'pipe-1',
        status: TranscriptionJobStatus.QUEUED,
        progress: 0,
        retryCount: 0,
        maxRetries: 3,
        tenantId: 'tenant-1',
        createdAt: '2026-02-17T10:00:00Z',
        updatedAt: '2026-02-17T10:00:00Z',
      };
      expect(queued.progress).toBe(0);

      const done: TranscriptionJobResponse = {
        id: 'job-d',
        jobType: TranscriptionJobType.BATCH,
        pipelineId: 'pipe-1',
        status: TranscriptionJobStatus.COMPLETED,
        progress: 100,
        retryCount: 0,
        maxRetries: 3,
        tenantId: 'tenant-1',
        createdAt: '2026-02-17T10:00:00Z',
        updatedAt: '2026-02-17T10:00:00Z',
      };
      expect(done.progress).toBe(100);
    });

    it('should accept nested pipeline response', () => {
      const job: TranscriptionJobResponse = {
        id: 'job-nested',
        jobType: TranscriptionJobType.STREAMING,
        pipelineId: 'pipe-1',
        status: TranscriptionJobStatus.PROCESSING,
        progress: 50,
        retryCount: 0,
        maxRetries: 3,
        tenantId: 'tenant-1',
        createdAt: '2026-02-17T10:00:00Z',
        updatedAt: '2026-02-17T10:00:00Z',
        pipeline: {
          id: 'pipe-1',
          name: 'Whisper Streaming',
          slug: 'whisper-streaming',
          configYaml: 'model: whisper',
          resourceStatus: ResourceStatus.ENABLED,
          tags: [],
          tenantId: 'tenant-1',
          createdAt: '2026-02-17T10:00:00Z',
          updatedAt: '2026-02-17T10:00:00Z',
        },
      };
      expect(job.pipeline).toBeDefined();
      expect(job.pipeline!.name).toBe('Whisper Streaming');
      expect(job.pipeline!.resourceStatus).toBe('ENABLED');
    });
  });

  describe('TranscriptionJobStatusCounts edge cases', () => {
    it('should handle all zeros', () => {
      const counts: TranscriptionJobStatusCounts = {
        queued: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        dead: 0,
      };
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      expect(total).toBe(0);
    });

    it('should handle large numbers', () => {
      const counts: TranscriptionJobStatusCounts = {
        queued: 0,
        processing: 3,
        completed: 999999,
        failed: 42,
        cancelled: 7,
        dead: 1,
      };
      expect(counts.completed).toBe(999999);
    });
  });

  describe('AsrPipelineResponse null edge cases', () => {
    it('should accept null description and creator fields', () => {
      const pipeline: AsrPipelineResponse = {
        id: 'pipe-nulls',
        name: 'Test Pipeline',
        slug: 'test-pipeline',
        description: null,
        configYaml: 'pipeline: {}',
        resourceStatus: ResourceStatus.ENABLED,
        tags: [],
        tenantId: 'tenant-1',
        createdAt: '2026-02-17T10:00:00Z',
        updatedAt: '2026-02-17T10:00:00Z',
        createdBy: null,
        updatedBy: null,
      };
      expect(pipeline.description).toBeNull();
      expect(pipeline.createdBy).toBeNull();
      expect(pipeline.updatedBy).toBeNull();
    });
  });

  describe('JSON deserialization (simulating real backend response)', () => {
    it('should deserialize a backend TranscriptionJobResponse JSON', () => {
      const backendJson = `{
        "id": "019503c0-d93f-7f41-b782-af9e1a3b5c0d",
        "jobType": "STREAMING",
        "pipelineId": "019503bf-a1e2-7d00-8000-000000000001",
        "consultationId": null,
        "contextItemId": null,
        "mediaId": null,
        "status": "COMPLETED",
        "progress": 100,
        "queuedAt": "2026-02-17T10:00:00.000Z",
        "startedAt": "2026-02-17T10:00:01.234Z",
        "completedAt": "2026-02-17T10:05:32.567Z",
        "resultText": "The patient presented with intermittent chest pain.",
        "resultMetadata": {"segments": 12, "language": "en"},
        "errorMessage": null,
        "errorCode": null,
        "retryCount": 0,
        "maxRetries": 3,
        "workerId": "worker-gpu-01",
        "tenantId": "tenant-acme",
        "createdAt": "2026-02-17T10:00:00.000Z",
        "updatedAt": "2026-02-17T10:05:32.567Z",
        "createdBy": "user-doctor-1"
      }`;

      const parsed = JSON.parse(backendJson) as TranscriptionJobResponse;

      expect(parsed.id).toBe('019503c0-d93f-7f41-b782-af9e1a3b5c0d');
      expect(parsed.jobType).toBe(TranscriptionJobType.STREAMING);
      expect(parsed.status).toBe(TranscriptionJobStatus.COMPLETED);
      expect(parsed.progress).toBe(100);
      expect(parsed.consultationId).toBeNull();
      expect(parsed.resultText).toBe('The patient presented with intermittent chest pain.');
      expect(parsed.resultMetadata).toEqual({ segments: 12, language: 'en' });
      expect(parsed.errorMessage).toBeNull();
    });

    it('should deserialize a backend WsTranscriptResult JSON', () => {
      const backendJson = `{
        "type": "transcript",
        "text": "chest pain for three days",
        "startTime": 2.34,
        "endTime": 5.67,
        "isFinal": false
      }`;

      const parsed = JSON.parse(backendJson) as WsServerMessage;

      expect(parsed.type).toBe('transcript');
      if (parsed.type === 'transcript') {
        expect(parsed.text).toBe('chest pain for three days');
        expect(parsed.startTime).toBe(2.34);
        expect(parsed.endTime).toBe(5.67);
        expect(parsed.isFinal).toBe(false);
      }
    });

    it('should deserialize a backend AiModelResponse JSON with null optionals', () => {
      const backendJson = `{
        "id": "019503bf-a1e2-7d00-8000-000000000002",
        "name": "Whisper Tiny",
        "slug": "whisper-tiny",
        "description": null,
        "category": "AUDIO",
        "taskType": "AUTOMATIC_SPEECH_RECOGNITION",
        "modelType": "BASE_MODEL",
        "source": "HUGGINGFACE",
        "sourceUri": "openai/whisper-tiny",
        "sourceRevision": null,
        "format": "ONNX",
        "memorySizeMb": 39,
        "computeType": null,
        "downloadStatus": "DOWNLOADED",
        "localPath": "/opt/models/whisper-tiny",
        "downloadedAt": "2026-02-10T08:00:00.000Z",
        "fileSizeMb": 37,
        "checksum": "sha256:abcdef1234567890",
        "resourceStatus": "ENABLED",
        "tags": ["stt", "tiny", "fast"],
        "tenantId": "tenant-acme",
        "createdAt": "2026-02-01T00:00:00.000Z",
        "updatedAt": "2026-02-10T08:00:00.000Z",
        "createdBy": "system",
        "updatedBy": null
      }`;

      const parsed = JSON.parse(backendJson) as AiModelResponse;

      expect(parsed.name).toBe('Whisper Tiny');
      expect(parsed.description).toBeNull();
      expect(parsed.downloadStatus).toBe(AiModelDownloadStatus.DOWNLOADED);
      expect(parsed.resourceStatus).toBe(ResourceStatus.ENABLED);
      expect(parsed.memorySizeMb).toBe(39);
      expect(parsed.computeType).toBeNull();
      expect(parsed.updatedBy).toBeNull();
      expect(parsed.tags).toEqual(['stt', 'tiny', 'fast']);
    });
  });

  describe('WsAudioFrame edge cases', () => {
    it('should handle seq number 0 (first frame)', () => {
      const frame: WsAudioFrame = {
        type: 'audio',
        seq: 0,
        data: 'AAAA',
      };
      expect(frame.seq).toBe(0);
    });

    it('should handle large seq numbers', () => {
      const frame: WsAudioFrame = {
        type: 'audio',
        seq: 999999,
        data: 'AAAA',
      };
      expect(frame.seq).toBe(999999);
    });

    it('should handle empty data string', () => {
      const frame: WsAudioFrame = {
        type: 'audio',
        seq: 1,
        data: '',
      };
      expect(frame.data).toBe('');
    });
  });

  describe('WsTranscriptResult edge cases', () => {
    it('should handle zero time values', () => {
      const result: WsTranscriptResult = {
        type: 'transcript',
        text: '',
        startTime: 0,
        endTime: 0,
        isFinal: false,
      };
      expect(result.startTime).toBe(0);
      expect(result.endTime).toBe(0);
    });

    it('should handle empty transcript text', () => {
      const result: WsTranscriptResult = {
        type: 'transcript',
        text: '',
        startTime: 0,
        endTime: 0.5,
        isFinal: false,
      };
      expect(result.text).toBe('');
    });

    it('should handle interim vs final transcripts', () => {
      const interim: WsTranscriptResult = {
        type: 'transcript',
        text: 'hel',
        startTime: 0,
        endTime: 0.3,
        isFinal: false,
      };
      const final: WsTranscriptResult = {
        type: 'transcript',
        text: 'hello world',
        startTime: 0,
        endTime: 1.2,
        isFinal: true,
      };
      expect(interim.isFinal).toBe(false);
      expect(final.isFinal).toBe(true);
    });
  });
});
