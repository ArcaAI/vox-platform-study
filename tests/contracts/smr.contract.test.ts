/**
 * SMR Service Contract Tests
 *
 * Tests the contract between API Gateway and SMR (Summary) Python Service.
 * These tests validate that both services agree on request/response schemas.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  SmrHealthResponseSchema,
  SmrSyncSummaryRequestSchema,
  SmrSummaryResponseSchema,
  SmrPreSummaryRequestSchema,
  SmrPreSummaryResponseSchema,
  SmrJobResponseSchema,
  SmrFeedbackRequestSchema,
  SmrFeedbackResponseSchema,
} from './schemas';

// Mock SMR service responses for contract validation
const mockSmrResponses = {
  health: {
    status: 'healthy',
    timestamp: Date.now() / 1000,
    message: 'SMR service is running',
  },
  summary: {
    session_id: 'session-123',
    summary: {
      clinical_summary: {
        summary: 'Patient presented with symptoms...',
        chief_complaint: 'Headache',
        history_of_present_illness: 'Patient reports...',
      },
      diagnoses: ['Tension headache'],
      medications: ['Ibuprofen 400mg'],
      follow_up: 'Return in 2 weeks',
    },
    created_at: '2024-01-01T00:00:00Z',
    processing_time_ms: 1500,
    token_usage: {
      prompt_tokens: 500,
      completion_tokens: 300,
      total_tokens: 800,
    },
    llm_provider: 'azure_openai',
    model_name: 'gpt-4',
    confidence_score: 0.95,
    metadata: {
      temperature: 0.3,
      max_tokens: 2000,
      specialty: 'General Medicine',
    },
  },
  preSummary: {
    pre_summary: 'Patient history summary...',
    structured_data: {
      title: 'Pre-Summary of Medical History',
      sections: [
        { name: 'Confirmed & Provisional Diagnoses', content: 'Hypertension' },
        { name: 'Plan of Care', content: 'Continue current medications' },
      ],
    },
    created_at: '2024-01-01T00:00:00Z',
  },
  job: {
    job_id: 'job-456',
    status: 'running' as const,
    created_at: '2024-01-01T00:00:00Z',
    session_id: 'session-123',
  },
  feedback: {
    feedback_id: 'feedback-789',
    summary_id: 'summary-123',
    provider_id: 'provider-456',
    rating: 4,
    labels: ['accurate', 'helpful'],
    comment: 'Good summary overall',
    corrected_summary: null,
    created_at: '2024-01-01T00:00:00Z',
  },
};

describe('SMR Service Contract', () => {
  describe('Health Endpoint Contract', () => {
    it('should validate healthy response schema', () => {
      const result = SmrHealthResponseSchema.safeParse(mockSmrResponses.health);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('healthy');
      }
    });

    it('should validate degraded response schema', () => {
      const degradedResponse = {
        status: 'degraded',
        message: 'LLM service experiencing high latency',
      };

      const result = SmrHealthResponseSchema.safeParse(degradedResponse);
      expect(result.success).toBe(true);
    });

    it('should validate unhealthy response schema', () => {
      const unhealthyResponse = {
        status: 'unhealthy',
        timestamp: Date.now() / 1000,
        message: 'Database connection failed',
      };

      const result = SmrHealthResponseSchema.safeParse(unhealthyResponse);
      expect(result.success).toBe(true);
    });
  });

  describe('Sync Summary Request Contract', () => {
    it('should validate full sync summary request schema', () => {
      const request = {
        session_data: {
          session_id: 'session-123',
          conversation_segments: [
            { speaker: 'Doctor', text: 'How are you feeling today?', timestamp: '00:00:05' },
            { speaker: 'Patient', text: 'I have a headache.', timestamp: '00:00:10' },
          ],
          patient_info: {
            name: 'John Doe',
            age: 45,
            gender: 'Male',
          },
          test_results_text: 'Blood pressure: 120/80',
          previous_visits_text: 'Last visit: 2023-12-01',
          pre_summary_text: 'Patient has history of hypertension',
          session_metadata: {
            language: 'en',
            department: 'General Medicine',
          },
          created_at: '2024-01-01T00:00:00Z',
        },
        system_prompt: 'You are a medical assistant...',
        user_prompt_template: 'Summarize the following...',
        temperature: 0.3,
        max_tokens: 2000,
        context: 'outpatient',
        use_enhanced_format: true,
        specialty: 'General Medicine',
        encounter_type: 'Follow-up',
        department: 'Internal Medicine',
        visit_type: 'Consultation',
      };

      const result = SmrSyncSummaryRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('should validate minimal sync summary request', () => {
      const minimalRequest = {
        session_data: {
          session_id: 'session-456',
          conversation_segments: [
            { speaker: 'Doctor', text: 'Hello' },
          ],
        },
      };

      const result = SmrSyncSummaryRequestSchema.safeParse(minimalRequest);
      expect(result.success).toBe(true);
    });

    it('should reject request without session_id', () => {
      const invalidRequest = {
        session_data: {
          conversation_segments: [],
        },
      };

      const result = SmrSyncSummaryRequestSchema.safeParse(invalidRequest);
      expect(result.success).toBe(false);
    });

    it('should validate conversation segments structure', () => {
      const request = {
        session_data: {
          session_id: 'session-789',
          conversation_segments: [
            { speaker: 'Doctor', text: 'What brings you in today?' },
            { speaker: 'Patient', text: 'I have been experiencing chest pain.' },
            { speaker: 'Doctor', text: 'How long has this been going on?', timestamp: '00:01:30' },
          ],
        },
      };

      const result = SmrSyncSummaryRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });
  });

  describe('Summary Response Contract', () => {
    it('should validate summary response schema', () => {
      const result = SmrSummaryResponseSchema.safeParse(mockSmrResponses.summary);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.session_id).toBe('session-123');
        expect(result.data.processing_time_ms).toBe(1500);
      }
    });

    it('should validate minimal summary response', () => {
      const minimalResponse = {
        session_id: 'session-456',
        summary: { text: 'Summary content' },
        created_at: '2024-01-01T00:00:00Z',
        processing_time_ms: 500,
      };

      const result = SmrSummaryResponseSchema.safeParse(minimalResponse);
      expect(result.success).toBe(true);
    });

    it('should validate response with token usage', () => {
      const responseWithTokens = {
        session_id: 'session-789',
        summary: {},
        created_at: '2024-01-01T00:00:00Z',
        processing_time_ms: 1000,
        token_usage: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          total_tokens: 1500,
        },
        llm_provider: 'langflow',
        model_name: 'langflow:flow-123',
      };

      const result = SmrSummaryResponseSchema.safeParse(responseWithTokens);
      expect(result.success).toBe(true);
    });
  });

  describe('Pre-Summary Request Contract', () => {
    it('should validate full pre-summary request schema', () => {
      const request = {
        current_department: 'Cardiology',
        visit_type: 'Follow-up',
        age: '45',
        dob: '1979-01-15',
        gender: 'Male',
        formatted_vitals: 'BP: 120/80, HR: 72',
        formatted_test_results: 'ECG: Normal sinus rhythm',
        formatted_previous_visits: 'Last visit: 2023-12-01 - Routine checkup',
        language: 'en',
        max_tokens: 800,
        temperature: 0.2,
      };

      const result = SmrPreSummaryRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('should validate minimal pre-summary request', () => {
      const minimalRequest = {};

      const result = SmrPreSummaryRequestSchema.safeParse(minimalRequest);
      expect(result.success).toBe(true);
    });

    it('should validate pre-summary request with Malayalam language', () => {
      const request = {
        current_department: 'General',
        language: 'ml',
      };

      const result = SmrPreSummaryRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });
  });

  describe('Pre-Summary Response Contract', () => {
    it('should validate pre-summary response schema', () => {
      const result = SmrPreSummaryResponseSchema.safeParse(mockSmrResponses.preSummary);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.structured_data.title).toBe('Pre-Summary of Medical History');
      }
    });

    it('should validate response with empty sections', () => {
      const responseWithEmptySections = {
        pre_summary: 'No previous medical history available.',
        structured_data: {
          title: 'Pre-Summary of Medical History',
          sections: [],
        },
        created_at: '2024-01-01T00:00:00Z',
      };

      const result = SmrPreSummaryResponseSchema.safeParse(responseWithEmptySections);
      expect(result.success).toBe(true);
    });
  });

  describe('Job Response Contract', () => {
    it('should validate job response schema', () => {
      const result = SmrJobResponseSchema.safeParse(mockSmrResponses.job);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.job_id).toBe('job-456');
        expect(result.data.status).toBe('running');
      }
    });

    it('should validate all job status values', () => {
      const statuses = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;

      for (const status of statuses) {
        const response = {
          job_id: 'job-1',
          status,
        };

        const result = SmrJobResponseSchema.safeParse(response);
        expect(result.success).toBe(true);
      }
    });

    it('should validate completed job response', () => {
      const completedJob = {
        job_id: 'job-completed',
        status: 'completed' as const,
        created_at: '2024-01-01T00:00:00Z',
        session_id: 'session-123',
      };

      const result = SmrJobResponseSchema.safeParse(completedJob);
      expect(result.success).toBe(true);
    });
  });

  describe('Feedback Contract', () => {
    it('should validate feedback request schema', () => {
      const request = {
        summary_id: 'summary-123',
        provider_id: 'provider-456',
        rating: 4,
        labels: ['accurate', 'helpful'],
        comment: 'Good summary',
        corrected_summary: 'Corrected version...',
      };

      const result = SmrFeedbackRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('should validate minimal feedback request', () => {
      const minimalRequest = {
        summary_id: 'summary-789',
        rating: 3,
      };

      const result = SmrFeedbackRequestSchema.safeParse(minimalRequest);
      expect(result.success).toBe(true);
    });

    it('should reject invalid rating values', () => {
      const invalidRating = {
        summary_id: 'summary-123',
        rating: 6, // Invalid: max is 5
      };

      const result = SmrFeedbackRequestSchema.safeParse(invalidRating);
      expect(result.success).toBe(false);
    });

    it('should reject rating below minimum', () => {
      const invalidRating = {
        summary_id: 'summary-123',
        rating: 0, // Invalid: min is 1
      };

      const result = SmrFeedbackRequestSchema.safeParse(invalidRating);
      expect(result.success).toBe(false);
    });

    it('should validate feedback response schema', () => {
      const result = SmrFeedbackResponseSchema.safeParse(mockSmrResponses.feedback);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.feedback_id).toBe('feedback-789');
        expect(result.data.rating).toBe(4);
      }
    });
  });

  describe('API Gateway Integration Contract', () => {
    it('should ensure API Gateway can construct valid summary request', () => {
      // Simulates what API Gateway sends to SMR service
      const apiGatewayRequest = {
        session_data: {
          session_id: `session-${Date.now()}`,
          conversation_segments: [
            { speaker: 'Doctor', text: 'Good morning, how can I help you?' },
            { speaker: 'Patient', text: 'I have been having headaches.' },
          ],
          patient_info: {
            age: 35,
            gender: 'Female',
          },
          session_metadata: {
            language: 'en',
          },
        },
        temperature: 0.3,
        max_tokens: 2000,
        specialty: 'Neurology',
        encounter_type: 'New Patient',
      };

      const result = SmrSyncSummaryRequestSchema.safeParse(apiGatewayRequest);
      expect(result.success).toBe(true);
    });

    it('should ensure API Gateway can parse SMR summary response', () => {
      // Simulates what SMR service returns
      const smrResponse = {
        session_id: 'session-gateway-test',
        summary: {
          clinical_summary: {
            summary: 'Patient presents with recurring headaches...',
            chief_complaint: 'Headaches',
          },
          diagnoses: ['Migraine'],
          medications: ['Sumatriptan'],
        },
        created_at: new Date().toISOString(),
        processing_time_ms: 2500,
        llm_provider: 'azure_openai',
        model_name: 'gpt-4',
      };

      const result = SmrSummaryResponseSchema.safeParse(smrResponse);
      expect(result.success).toBe(true);
    });

    it('should handle Langflow provider response', () => {
      const langflowResponse = {
        session_id: 'session-langflow',
        summary: {
          text: 'Summary generated by Langflow',
        },
        created_at: new Date().toISOString(),
        processing_time_ms: 1800,
        token_usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
        llm_provider: 'langflow',
        model_name: 'langflow:flow-summary-v1',
      };

      const result = SmrSummaryResponseSchema.safeParse(langflowResponse);
      expect(result.success).toBe(true);
    });
  });

  describe('Schema Evolution', () => {
    it('should handle additional fields (forward compatibility)', () => {
      const responseWithExtraFields = {
        ...mockSmrResponses.summary,
        new_field: 'some value',
        analytics: { word_count: 500 },
      };

      const result = SmrSummaryResponseSchema.safeParse(responseWithExtraFields);
      expect(result.success).toBe(true);
    });

    it('should validate required fields are present', () => {
      const missingRequiredField = {
        summary: {},
        created_at: '2024-01-01T00:00:00Z',
        processing_time_ms: 500,
        // missing session_id
      };

      const result = SmrSummaryResponseSchema.safeParse(missingRequiredField);
      expect(result.success).toBe(false);
    });
  });
});

/**
 * TASK-528 §3.3 / §5.3 — `GET /api/v1/providers` probe contract.
 *
 * The SMR-side additions are ADDITIVE and OPTIONAL: the gateway's transition
 * fallback mapper (`smr-proxy.controller.ts#getProviders`) spreads the payload
 * untouched, so a pre-TASK-528 SMR (no probe fields) must still validate.
 */
describe('SMR Providers Listing Contract (TASK-528)', () => {
  const ModelInfoSchema = z.object({
    name: z.string(),
    supports_streaming: z.boolean().optional(),
    context_window: z.number().nullable().optional(),
    // Additive (TASK-528): engine-reported load state + engine-native extras.
    state: z.enum(['loaded', 'not-loaded']).nullable().optional(),
    engine_native: z.record(z.string(), z.unknown()).nullable().optional(),
  });

  const ProviderInfoSchema = z.object({
    name: z.string(),
    display_name: z.string(),
    status: z.string(),
    default_model: z.string(),
    models: z.array(ModelInfoSchema),
    supports_streaming: z.boolean().optional(),
    // Additive (TASK-528): per-provider probe outcome.
    probe_status: z.enum(['ok', 'timeout', 'error', 'skipped']).nullable().optional(),
    probe_latency_ms: z.number().nullable().optional(),
    probe_error: z.string().nullable().optional(),
  });

  it('accepts a legacy payload with no probe fields (backward compatible)', () => {
    const legacy = {
      name: 'ollama',
      display_name: 'Ollama (Self-Hosted)',
      status: 'available',
      default_model: 'llama3.1:8b',
      models: [{ name: 'llama3.1:8b', supports_streaming: true }],
      supports_streaming: true,
    };
    expect(ProviderInfoSchema.safeParse(legacy).success).toBe(true);
  });

  it('accepts the enriched payload the discovery merge consumes', () => {
    const enriched = {
      name: 'lm-studio',
      display_name: 'OpenAI Compatible',
      status: 'available',
      default_model: '',
      models: [
        {
          name: 'qwen3-8b',
          supports_streaming: true,
          state: 'loaded',
          engine_native: { quantization: 'Q4_K_M', max_context_length: 32768 },
        },
      ],
      supports_streaming: true,
      probe_status: 'ok',
      probe_latency_ms: 42,
      probe_error: null,
    };
    expect(ProviderInfoSchema.safeParse(enriched).success).toBe(true);
  });

  it('accepts a timed-out provider entry (partial failure, never a 500)', () => {
    const timedOut = {
      name: 'vllm',
      display_name: 'vllm',
      status: 'unavailable',
      default_model: '',
      models: [],
      probe_status: 'timeout',
      probe_latency_ms: 5001,
      probe_error: 'probe exceeded 5.0s',
    };
    expect(ProviderInfoSchema.safeParse(timedOut).success).toBe(true);
  });

  it('rejects an unknown probe status (typo guard)', () => {
    const bad = {
      name: 'ollama',
      display_name: 'Ollama',
      status: 'available',
      default_model: '',
      models: [],
      probe_status: 'okay',
    };
    expect(ProviderInfoSchema.safeParse(bad).success).toBe(false);
  });
});
