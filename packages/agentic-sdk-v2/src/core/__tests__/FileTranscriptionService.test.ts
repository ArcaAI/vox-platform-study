/**
 * FileTranscriptionService Unit Tests — ASR-R-10
 *
 * TDD tests for file upload transcription:
 * - Upload audio file via POST /api/v1/transcription-jobs/transcribe
 * - Connect to SSE stream for results
 * - Handle progress/completion/error events
 * - Abort/cancel support
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockErrorResponse, createMockLogger, createMockResponse, mockFetch } from '../../__tests__/setup';
import type { TranscriptionJobResponse } from '../../types/stt';
import { TranscriptionJobStatus, TranscriptionJobType } from '../../types/stt';
import { AgenticClient } from '../AgenticClient';
import { STT_ENDPOINTS } from '../constants';
import { FileTranscriptionService } from '../FileTranscriptionService';

// ===========================================================================
// Fixtures
// ===========================================================================

function createMockTranscribeResponse(): TranscriptionJobResponse {
  return {
    id: 'job-file-123',
    jobType: TranscriptionJobType.BATCH,
    pipelineId: 'whisper-default',
    status: TranscriptionJobStatus.QUEUED,
    progress: 0,
    retryCount: 0,
    maxRetries: 3,
    tenantId: 'tenant-001',
    createdAt: '2026-02-17T12:00:00.000Z',
    updatedAt: '2026-02-17T12:00:00.000Z',
  };
}

function createMockAudioFile(): File {
  const buffer = new ArrayBuffer(1000);
  return new File([buffer], 'test-audio.wav', { type: 'audio/wav' });
}

// ===========================================================================
// Tests
// ===========================================================================

describe('FileTranscriptionService', () => {
  let service: FileTranscriptionService;
  let apiClient: AgenticClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    apiClient = new AgenticClient(
      {
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
      },
      mockLogger,
    );
    service = new FileTranscriptionService(apiClient, mockLogger);
  });

  afterEach(() => {
    service.dispose();
    vi.clearAllMocks();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should create an instance with apiClient and logger', () => {
      expect(service).toBeDefined();
    });

    it('should create an instance without logger', () => {
      const svc = new FileTranscriptionService(apiClient);
      expect(svc).toBeDefined();
      svc.dispose();
    });
  });

  // =========================================================================
  // uploadAndTranscribe
  // =========================================================================

  describe('uploadAndTranscribe', () => {
    it('should upload a file and return the job response', async () => {
      const file = createMockAudioFile();
      const mockJob = createMockTranscribeResponse();
      mockFetch.mockResolvedValueOnce(createMockResponse(mockJob));

      const result = await service.uploadAndTranscribe(file, {
        pipelineId: 'whisper-default',
      });

      expect(result).toEqual(mockJob);
      expect(result.id).toBe('job-file-123');
    });

    it('should normalize batch transcribe response with id', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          id: 'job-batch-999',
          status: 'QUEUED',
          sseUrl: '/api/v1/audio/transcription-jobs/job-batch-999/stream',
          audioUri: 's3://hope-audio/demo.wav',
        }),
      );

      const result = await service.uploadAndTranscribe(file, {
        pipelineId: 'whisper-default',
      });

      expect(result.id).toBe('job-batch-999');
      expect(service.getActiveJobId()).toBe('job-batch-999');
    });

    it('should throw when transcribe response has no id', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(createMockResponse({ status: 'QUEUED' }));

      await expect(
        service.uploadAndTranscribe(file, {
          pipelineId: 'whisper-default',
        }),
      ).rejects.toThrow('missing job id');
    });

    it('should throw when batch transcribe response has unknown status', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          id: 'job-batch-123',
          status: 'UNKNOWN_STATUS',
        }),
      );

      await expect(
        service.uploadAndTranscribe(file, {
          pipelineId: 'whisper-default',
        }),
      ).rejects.toThrow('Invalid transcription response status');
    });

    it('should call the TRANSCRIBE endpoint', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockTranscribeResponse()));

      await service.uploadAndTranscribe(file, { pipelineId: 'default' });

      const callUrl = mockFetch.mock.calls[0][0] as string;
      expect(callUrl).toContain(STT_ENDPOINTS.TRANSCRIBE);
    });

    it('should send FormData with the audio file', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockTranscribeResponse()));

      await service.uploadAndTranscribe(file, { pipelineId: 'default' });

      const callBody = mockFetch.mock.calls[0][1]?.body;
      expect(callBody).toBeInstanceOf(FormData);
      expect((callBody as FormData).get('file')).toBe(file);
    });

    it('should include pipelineId in the form data', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockTranscribeResponse()));

      await service.uploadAndTranscribe(file, {
        pipelineId: 'whisper-large-v3',
      });

      const callBody = mockFetch.mock.calls[0][1]?.body as FormData;
      expect(callBody.get('pipelineId')).toBe('whisper-large-v3');
    });

    it('should include optional fields in the form data', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockTranscribeResponse()));

      await service.uploadAndTranscribe(file, {
        pipelineId: 'default',
        consultationId: 'consult-456',
        language: 'th',
        sampleRate: 44100,
        codeSwitching: true,
        diarization: true,
      });

      const callBody = mockFetch.mock.calls[0][1]?.body as FormData;
      expect(callBody.get('consultationId')).toBe('consult-456');
      expect(callBody.get('language')).toBe('th');
      expect(callBody.get('sampleRate')).toBe('44100');
      expect(callBody.get('codeSwitching')).toBe('true');
      expect(callBody.get('diarization')).toBe('true');
    });

    it('should include codeSwitching: false in form data (not omit falsy)', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockTranscribeResponse()));

      await service.uploadAndTranscribe(file, {
        pipelineId: 'default',
        codeSwitching: false,
        diarization: false,
      });

      const callBody = mockFetch.mock.calls[0][1]?.body as FormData;
      expect(callBody.get('codeSwitching')).toBe('false');
      expect(callBody.get('diarization')).toBe('false');
    });

    it('should throw on upload failure', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(413, 'File too large'));

      await expect(service.uploadAndTranscribe(file, { pipelineId: 'default' })).rejects.toThrow();
    });

    it('should use POST method', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockTranscribeResponse()));

      await service.uploadAndTranscribe(file, { pipelineId: 'default' });

      const callMethod = mockFetch.mock.calls[0][1]?.method;
      expect(callMethod).toBe('POST');
    });

    it('should include auth headers via apiClient (not bare fetch)', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockTranscribeResponse()));

      await service.uploadAndTranscribe(file, { pipelineId: 'default' });

      const callHeaders = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
      expect(callHeaders['X-API-Key']).toBe('test-key');
    });

    it('should NOT set Content-Type header (let browser set multipart boundary)', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockTranscribeResponse()));

      await service.uploadAndTranscribe(file, { pipelineId: 'default' });

      const callHeaders = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
      expect(callHeaders?.['Content-Type']).toBeUndefined();
    });

    it('should omit optional fields from FormData when not provided', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockTranscribeResponse()));

      await service.uploadAndTranscribe(file, { pipelineId: 'default' });

      const callBody = mockFetch.mock.calls[0][1]?.body as FormData;
      expect(callBody.get('consultationId')).toBeNull();
      expect(callBody.get('language')).toBeNull();
      expect(callBody.get('sampleRate')).toBeNull();
      expect(callBody.get('codeSwitching')).toBeNull();
      expect(callBody.get('diarization')).toBeNull();
    });

    it('should NOT update activeJobId on failed upload', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(500, 'Server Error'));

      try {
        await service.uploadAndTranscribe(file, { pipelineId: 'default' });
      } catch {
        // expected
      }

      expect(service.getActiveJobId()).toBeNull();
    });

    it('should throw on 401 unauthorized', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(createMockErrorResponse(401, 'Unauthorized'));

      await expect(service.uploadAndTranscribe(file, { pipelineId: 'default' })).rejects.toThrow();
    });

    it('should throw on network error', async () => {
      const file = createMockAudioFile();
      mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));

      await expect(service.uploadAndTranscribe(file, { pipelineId: 'default' })).rejects.toThrow();
    });
  });

  // =========================================================================
  // buildJobStreamUrl
  // =========================================================================

  describe('buildJobStreamUrl', () => {
    it('should build the SSE stream URL for a job', () => {
      const url = service.buildJobStreamUrl('job-sse-test');

      expect(url).toBe('https://api.example.com/audio/transcription-jobs/job-sse-test/stream');
    });

    it('should use STT_ENDPOINTS.JOB_STREAM', () => {
      const url = service.buildJobStreamUrl('my-job');

      expect(url).toContain(STT_ENDPOINTS.JOB_STREAM('my-job'));
    });
  });

  // =========================================================================
  // getActiveJobId
  // =========================================================================

  describe('getActiveJobId', () => {
    it('should return null when no upload has been performed', () => {
      expect(service.getActiveJobId()).toBeNull();
    });

    it('should return the job ID after a successful upload', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockTranscribeResponse()));

      await service.uploadAndTranscribe(file, { pipelineId: 'default' });

      expect(service.getActiveJobId()).toBe('job-file-123');
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('should clean up and reset state', async () => {
      const file = createMockAudioFile();
      mockFetch.mockResolvedValueOnce(createMockResponse(createMockTranscribeResponse()));

      await service.uploadAndTranscribe(file, { pipelineId: 'default' });
      expect(service.getActiveJobId()).toBe('job-file-123');

      service.dispose();

      expect(service.getActiveJobId()).toBeNull();
    });

    it('should be idempotent (safe to call multiple times)', () => {
      service.dispose();
      expect(() => service.dispose()).not.toThrow();
      expect(service.getActiveJobId()).toBeNull();
    });
  });
});
