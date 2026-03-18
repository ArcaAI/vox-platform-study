/**
 * TTS Service Contract Tests
 *
 * Tests the contract between API Gateway and TTS Python Service.
 * These tests validate that both services agree on request/response schemas.
 */

import { describe, it, expect } from 'vitest';
import {
  TtsHealthResponseSchema,
  TtsSynthesisRequestSchema,
  TtsSynthesisResponseSchema,
  TtsVoicesResponseSchema,
  TtsBatchStatusResponseSchema,
} from './schemas';

// Mock TTS service responses for contract validation
const mockTtsResponses = {
  health: {
    status: 'healthy',
    timestamp: Date.now() / 1000,
    message: 'TTS service is running',
  },
  synthesis: {
    synthesis_id: 'synth-123',
    message: 'Speech synthesis completed successfully',
    download_url: '/api/tts/download/synth-123',
    format: 'mp3',
    file_size: '45678 bytes',
    text_length: 100,
    character_count: 100,
    voice_used: 'en-US-JennyNeural',
    stored_in_minio: true,
    synthesis_duration: '1.25s',
  },
  voices: {
    voices: [
      {
        Name: 'en-US-JennyNeural',
        DisplayName: 'Jenny',
        LocalName: 'Jenny',
        ShortName: 'en-US-JennyNeural',
        Gender: 'Female',
        Locale: 'en-US',
        LocaleName: 'English (United States)',
        SampleRateHertz: '24000',
        VoiceType: 'Neural',
        Status: 'GA',
        WordsPerMinute: '150',
      },
    ],
    total_count: 1,
    default_voices: {
      en: 'en-US-JennyNeural',
      vi: 'vi-VN-HoaiMyNeural',
    },
    supported_languages: ['en', 'vi', 'ml'],
    message: 'Retrieved 1 supported voices',
  },
  batchStatus: {
    job_id: 'batch-456',
    status: 'running' as const,
    created_at: '2024-01-01T00:00:00Z',
    text_length: 500,
    voice: 'en-US-JennyNeural',
    format: 'mp3',
  },
};

describe('TTS Service Contract', () => {
  describe('Health Endpoint Contract', () => {
    it('should validate healthy response schema', () => {
      const result = TtsHealthResponseSchema.safeParse(mockTtsResponses.health);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('healthy');
      }
    });

    it('should validate degraded response schema', () => {
      const degradedResponse = {
        status: 'degraded',
        message: 'Azure TTS experiencing high latency',
      };

      const result = TtsHealthResponseSchema.safeParse(degradedResponse);
      expect(result.success).toBe(true);
    });

    it('should validate unhealthy response schema', () => {
      const unhealthyResponse = {
        status: 'unhealthy',
        timestamp: Date.now() / 1000,
        message: 'Azure TTS connection failed',
      };

      const result = TtsHealthResponseSchema.safeParse(unhealthyResponse);
      expect(result.success).toBe(true);
    });

    it('should reject invalid status values', () => {
      const invalidResponse = {
        status: 'unknown',
      };

      const result = TtsHealthResponseSchema.safeParse(invalidResponse);
      expect(result.success).toBe(false);
    });
  });

  describe('Synthesis Request Contract', () => {
    it('should validate full synthesis request schema', () => {
      const request = {
        text: 'Hello, this is a test.',
        voice: 'en-US-JennyNeural',
        style: 'cheerful',
        styleDegree: 1.5,
        rate: '+10%',
        pitch: '+5Hz',
        format: 'mp3',
        useBatch: false,
      };

      const result = TtsSynthesisRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('should validate minimal synthesis request', () => {
      const minimalRequest = {
        text: 'Hello world',
      };

      const result = TtsSynthesisRequestSchema.safeParse(minimalRequest);
      expect(result.success).toBe(true);
    });

    it('should reject empty text', () => {
      const invalidRequest = {
        text: '',
      };

      const result = TtsSynthesisRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('should reject missing text', () => {
      const invalidRequest = {
        voice: 'en-US-JennyNeural',
      };

      const result = TtsSynthesisRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('should validate batch synthesis request', () => {
      const batchRequest = {
        text: 'This is a longer text that should be processed in batch mode.',
        voice: 'en-US-GuyNeural',
        useBatch: true,
        format: 'wav',
      };

      const result = TtsSynthesisRequestSchema.safeParse(batchRequest);
      expect(result.success).toBe(true);
    });
  });

  describe('Synthesis Response Contract', () => {
    it('should validate synthesis response schema', () => {
      const result = TtsSynthesisResponseSchema.safeParse(mockTtsResponses.synthesis);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.synthesis_id).toBe('synth-123');
        expect(result.data.download_url).toContain('/api/tts/download/');
      }
    });

    it('should validate minimal synthesis response', () => {
      const minimalResponse = {
        synthesis_id: 'synth-456',
        message: 'Completed',
        download_url: '/api/tts/download/synth-456',
      };

      const result = TtsSynthesisResponseSchema.safeParse(minimalResponse);
      expect(result.success).toBe(true);
    });

    it('should validate response with minio storage info', () => {
      const responseWithMinio = {
        synthesis_id: 'synth-789',
        message: 'Speech synthesis completed',
        download_url: '/api/tts/download/synth-789',
        stored_in_minio: true,
        synthesis_duration: '2.5s',
      };

      const result = TtsSynthesisResponseSchema.safeParse(responseWithMinio);
      expect(result.success).toBe(true);
    });
  });

  describe('Voices Endpoint Contract', () => {
    it('should validate voices response schema', () => {
      const result = TtsVoicesResponseSchema.safeParse(mockTtsResponses.voices);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.total_count).toBe(1);
        expect(result.data.voices).toHaveLength(1);
      }
    });

    it('should validate empty voices list', () => {
      const emptyVoicesResponse = {
        voices: [],
        total_count: 0,
        message: 'No voices available',
      };

      const result = TtsVoicesResponseSchema.safeParse(emptyVoicesResponse);
      expect(result.success).toBe(true);
    });

    it('should validate voices with default voices map', () => {
      const responseWithDefaults = {
        voices: [],
        total_count: 0,
        default_voices: {
          en: 'en-US-JennyNeural',
          vi: 'vi-VN-HoaiMyNeural',
          ml: 'ml-IN-SobhanaNeural',
        },
        supported_languages: ['en', 'vi', 'ml'],
      };

      const result = TtsVoicesResponseSchema.safeParse(responseWithDefaults);
      expect(result.success).toBe(true);
    });
  });

  describe('Batch Status Contract', () => {
    it('should validate batch status response schema', () => {
      const result = TtsBatchStatusResponseSchema.safeParse(mockTtsResponses.batchStatus);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.job_id).toBe('batch-456');
        expect(result.data.status).toBe('running');
      }
    });

    it('should validate all batch status values', () => {
      const statuses = ['pending', 'running', 'completed', 'failed'] as const;

      for (const status of statuses) {
        const response = {
          job_id: 'batch-1',
          status,
        };

        const result = TtsBatchStatusResponseSchema.safeParse(response);
        expect(result.success).toBe(true);
      }
    });

    it('should validate completed batch status', () => {
      const completedStatus = {
        job_id: 'batch-completed',
        status: 'completed' as const,
        created_at: '2024-01-01T00:00:00Z',
        text_length: 1000,
        voice: 'en-US-GuyNeural',
        format: 'wav',
      };

      const result = TtsBatchStatusResponseSchema.safeParse(completedStatus);
      expect(result.success).toBe(true);
    });
  });

  describe('API Gateway Integration Contract', () => {
    it('should ensure API Gateway can construct valid synthesis request', () => {
      // Simulates what API Gateway sends to TTS service
      const apiGatewayRequest = {
        text: 'Patient consultation summary for Dr. Smith.',
        voice: 'en-US-JennyNeural',
        format: 'mp3',
        rate: '+0%',
        pitch: '+0Hz',
      };

      const result = TtsSynthesisRequestSchema.safeParse(apiGatewayRequest);
      expect(result.success).toBe(true);
    });

    it('should ensure API Gateway can parse TTS synthesis response', () => {
      // Simulates what TTS service returns
      const ttsResponse = {
        synthesis_id: 'synth-gateway-test',
        message: 'Speech synthesis completed successfully',
        download_url: '/api/tts/download/synth-gateway-test',
        format: 'mp3',
        file_size: '12345 bytes',
        voice_used: 'en-US-JennyNeural',
        stored_in_minio: true,
      };

      const result = TtsSynthesisResponseSchema.safeParse(ttsResponse);
      expect(result.success).toBe(true);
    });

    it('should handle voice selection from supported list', () => {
      const voicesResponse = {
        voices: [
          { Name: 'en-US-JennyNeural', Locale: 'en-US' },
          { Name: 'vi-VN-HoaiMyNeural', Locale: 'vi-VN' },
        ],
        total_count: 2,
        supported_languages: ['en', 'vi'],
      };

      const result = TtsVoicesResponseSchema.safeParse(voicesResponse);
      expect(result.success).toBe(true);
    });
  });

  describe('Audio Format Contract', () => {
    it('should support mp3 format', () => {
      const request = { text: 'Test', format: 'mp3' };
      const result = TtsSynthesisRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('should support wav format', () => {
      const request = { text: 'Test', format: 'wav' };
      const result = TtsSynthesisRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('should support ogg format', () => {
      const request = { text: 'Test', format: 'ogg' };
      const result = TtsSynthesisRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('should support Azure TTS format strings', () => {
      const request = { text: 'Test', format: 'audio-24khz-48kbitrate-mono-mp3' };
      const result = TtsSynthesisRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });
  });

  describe('Schema Evolution', () => {
    it('should handle additional fields (forward compatibility)', () => {
      const responseWithExtraFields = {
        ...mockTtsResponses.synthesis,
        new_metric: 'some value',
        performance_data: { latency_ms: 150 },
      };

      const result = TtsSynthesisResponseSchema.safeParse(responseWithExtraFields);
      expect(result.success).toBe(true);
    });

    it('should validate required fields are present', () => {
      const missingRequiredField = {
        message: 'Completed',
        download_url: '/api/tts/download/test',
        // missing synthesis_id
      };

      const result = TtsSynthesisResponseSchema.safeParse(missingRequiredField);
      expect(result.success).toBe(false);
    });
  });
});
