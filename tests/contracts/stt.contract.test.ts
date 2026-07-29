/**
 * STT Service Contract Tests
 *
 * Tests the contract between API Gateway and STT Python Service.
 * These tests validate that both services agree on request/response schemas.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import {
  SttHealthResponseSchema,
  SttStartSessionRequestSchema,
  SttStartSessionResponseSchema,
  SttTranscribeFileResponseSchema,
  SttTaskStatusResponseSchema,
} from './schemas';

// Mock STT service responses for contract validation
const mockSttResponses = {
  health: {
    status: 'healthy',
    timestamp: Date.now() / 1000,
    message: 'STT service is running',
    components: {
      azure: { status: 'healthy' },
      whisper: { status: 'healthy' },
      redis: { status: 'healthy' },
      minio: { status: 'healthy' },
    },
  },
  startSession: {
    message: 'Session started',
    session_id: 'test-session-123',
    status: 'active',
    audio_config: {
      sampleRate: 16000,
      channels: 1,
      bitDepth: 16,
    },
    provider: 'azure',
  },
  transcribeFile: {
    task_id: 'task-456',
    session_id: 'session-123',
    status: 'PENDING' as const,
    message: 'Transcription task started',
    provider: 'whisper',
  },
  taskStatus: {
    task_id: 'task-456',
    session_id: 'session-123',
    status: 'SUCCESS',
    started_at: '2024-01-01T00:00:00Z',
    completed_at: '2024-01-01T00:01:00Z',
    language: 'en-US',
    provider: 'whisper',
    result: {
      text: 'Hello world',
      segments: [],
    },
    error: null,
    message: 'Transcription completed',
  },
};

describe('STT Service Contract', () => {
  describe('Health Endpoint Contract', () => {
    it('should validate healthy response schema', () => {
      const result = SttHealthResponseSchema.safeParse(mockSttResponses.health);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('healthy');
      }
    });

    it('should validate degraded response schema', () => {
      const degradedResponse = {
        status: 'degraded',
        timestamp: Date.now() / 1000,
        message: 'Some components unhealthy',
      };

      const result = SttHealthResponseSchema.safeParse(degradedResponse);
      expect(result.success).toBe(true);
    });

    it('should validate unhealthy response schema', () => {
      const unhealthyResponse = {
        status: 'unhealthy',
        message: 'Service unavailable',
      };

      const result = SttHealthResponseSchema.safeParse(unhealthyResponse);
      expect(result.success).toBe(true);
    });

    it('should reject invalid status values', () => {
      const invalidResponse = {
        status: 'unknown',
      };

      const result = SttHealthResponseSchema.safeParse(invalidResponse);
      expect(result.success).toBe(false);
    });
  });

  describe('Start Session Contract', () => {
    it('should validate start session request schema', () => {
      const request = {
        session_id: 'test-session-123',
        language: 'en-US',
        provider: 'azure' as const,
        audioSettings: {
          sampleRate: 16000,
          channels: 1,
          bitDepth: 16,
        },
      };

      const result = SttStartSessionRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('should validate minimal start session request', () => {
      const minimalRequest = {
        session_id: 'test-session',
      };

      const result = SttStartSessionRequestSchema.safeParse(minimalRequest);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.language).toBe('en-US');
        expect(result.data.provider).toBe('azure');
      }
    });

    it('should validate start session response schema', () => {
      const result = SttStartSessionResponseSchema.safeParse(mockSttResponses.startSession);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.session_id).toBe('test-session-123');
        expect(result.data.status).toBe('active');
      }
    });

    it('should reject request without session_id', () => {
      const invalidRequest = {
        language: 'en-US',
      };

      const result = SttStartSessionRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('should validate whisper provider', () => {
      const request = {
        session_id: 'test-session',
        provider: 'whisper' as const,
        num_speakers: 2,
      };

      const result = SttStartSessionRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });
    it('should validate sarvam provider', () => {
      const request = {
        session_id: 'test-session',
        provider: 'sarvam' as const,
      };

      const result = SttStartSessionRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });
  });

  describe('Transcribe File Contract', () => {
    it('should validate transcribe file response schema', () => {
      const result = SttTranscribeFileResponseSchema.safeParse(mockSttResponses.transcribeFile);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.task_id).toBe('task-456');
        expect(result.data.status).toBe('PENDING');
      }
    });

    it('should validate chunked upload response', () => {
      const chunkResponse = {
        task_id: '',
        session_id: 'session-123',
        status: 'CHUNK_UPLOADED' as const,
        message: 'Chunk uploaded',
        upload_id: 'upload-789',
      };

      const result = SttTranscribeFileResponseSchema.safeParse(chunkResponse);
      expect(result.success).toBe(true);
    });

    it('should validate all status values', () => {
      const statuses = ['PENDING', 'RUNNING', 'SUCCESS', 'FAILURE', 'CHUNK_UPLOADED'] as const;

      for (const status of statuses) {
        const response = {
          task_id: 'task-1',
          session_id: 'session-1',
          status,
          message: 'Test message',
        };

        const result = SttTranscribeFileResponseSchema.safeParse(response);
        expect(result.success).toBe(true);
      }
    });
  });

  describe('Task Status Contract', () => {
    it('should validate task status response schema', () => {
      const result = SttTaskStatusResponseSchema.safeParse(mockSttResponses.taskStatus);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.task_id).toBe('task-456');
        expect(result.data.status).toBe('SUCCESS');
      }
    });

    it('should validate pending task status', () => {
      const pendingStatus = {
        task_id: 'task-123',
        session_id: 'session-456',
        status: 'PENDING',
        started_at: null,
        completed_at: null,
        language: 'en-US',
        provider: null,
        result: null,
        error: null,
        message: 'Task is pending',
      };

      const result = SttTaskStatusResponseSchema.safeParse(pendingStatus);
      expect(result.success).toBe(true);
    });

    it('should validate failed task status', () => {
      const failedStatus = {
        task_id: 'task-123',
        session_id: 'session-456',
        status: 'FAILURE',
        started_at: '2024-01-01T00:00:00Z',
        completed_at: '2024-01-01T00:00:30Z',
        language: 'en-US',
        provider: 'azure',
        result: null,
        error: 'Transcription failed: Audio file corrupted',
        message: 'Task failed',
      };

      const result = SttTaskStatusResponseSchema.safeParse(failedStatus);
      expect(result.success).toBe(true);
    });
  });

  describe('API Gateway Integration Contract', () => {
    it('should ensure API Gateway can construct valid start session request', () => {
      // Simulates what API Gateway sends to STT service
      const apiGatewayRequest = {
        session_id: `session-${Date.now()}`,
        language: 'en-US',
        provider: 'azure' as const,
        audioSettings: {
          sampleRate: 16000,
          channels: 1,
          bitDepth: 16,
        },
      };

      const result = SttStartSessionRequestSchema.safeParse(apiGatewayRequest);
      expect(result.success).toBe(true);
    });

    it('should ensure API Gateway can parse STT health response', () => {
      // Simulates what STT service returns
      const sttResponse = {
        status: 'healthy',
        timestamp: 1704067200,
        components: {
          azure: { status: 'healthy' },
          whisper: { status: 'degraded', message: 'High load' },
        },
      };

      const result = SttHealthResponseSchema.safeParse(sttResponse);
      expect(result.success).toBe(true);
    });

    it('should handle optional fields gracefully', () => {
      // Minimal response from STT service
      const minimalResponse = {
        task_id: 'task-1',
        session_id: 'session-1',
        status: 'PENDING' as const,
        message: 'Started',
      };

      const result = SttTranscribeFileResponseSchema.safeParse(minimalResponse);
      expect(result.success).toBe(true);
    });
  });

  describe('Schema Evolution', () => {
    it('should handle additional fields (forward compatibility)', () => {
      // STT service might add new fields in the future
      const responseWithExtraFields = {
        ...mockSttResponses.health,
        new_field: 'some value',
        another_field: { nested: true },
      };

      // Zod strips unknown fields by default, but parsing should succeed
      const result = SttHealthResponseSchema.safeParse(responseWithExtraFields);
      expect(result.success).toBe(true);
    });

    it('should validate required fields are present', () => {
      const missingRequiredField = {
        session_id: 'session-1',
        status: 'PENDING',
        // missing task_id and message
      };

      const result = SttTranscribeFileResponseSchema.safeParse(missingRequiredField);
      expect(result.success).toBe(false);
    });
  });
});
