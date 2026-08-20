/**
 * Contract Schemas
 *
 * Defines the expected request/response schemas for API Gateway <-> Python Services communication.
 * These schemas serve as the contract between services.
 */

import { z } from 'zod';

// ============================================================================
// STT Service Schemas
// ============================================================================

/**
 * STT Health Response Schema
 */
export const SttHealthResponseSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  timestamp: z.number().optional(),
  message: z.string().optional(),
  components: z
    .record(
      z.string(),
      z.object({
        status: z.string(),
        message: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * STT Start Session Request Schema
 */
export const SttStartSessionRequestSchema = z.object({
  session_id: z.string(),
  language: z.string().default('en-US'),
  provider: z.enum(['azure', 'whisper', 'sarvam']).default('azure'),
  audioSettings: z
    .object({
      sampleRate: z.number().optional(),
      channels: z.number().optional(),
      bitDepth: z.number().optional(),
    })
    .optional(),
  num_speakers: z.number().optional(),
});

/**
 * STT Start Session Response Schema
 */
export const SttStartSessionResponseSchema = z.object({
  message: z.string(),
  session_id: z.string(),
  status: z.string(),
  audio_config: z.object({}).passthrough().optional(),
  provider: z.string().optional(),
});

/**
 * STT Transcribe File Response Schema
 */
export const SttTranscribeFileResponseSchema = z.object({
  task_id: z.string(),
  session_id: z.string(),
  status: z.enum(['PENDING', 'RUNNING', 'SUCCESS', 'FAILURE', 'CHUNK_UPLOADED']),
  message: z.string(),
  provider: z.string().optional(),
  upload_id: z.string().optional(),
});

/**
 * STT Task Status Response Schema
 */
export const SttTaskStatusResponseSchema = z.object({
  task_id: z.string(),
  session_id: z.string(),
  status: z.string(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  language: z.string().optional(),
  provider: z.string().nullable().optional(),
  result: z.unknown().nullable().optional(),
  error: z.string().nullable().optional(),
  message: z.string().optional(),
});

// ============================================================================
// TEXT Service Schemas
// ============================================================================

/**
 * TEXT Health Response Schema
 */
export const TextHealthResponseSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  timestamp: z.number().optional(),
  message: z.string().optional(),
});

/**
 * TEXT Summary Request Schema (Sync)
 */
export const TextSyncSummaryRequestSchema = z.object({
  session_data: z.object({
    session_id: z.string(),
    conversation_segments: z.array(
      z.object({
        speaker: z.string(),
        text: z.string(),
        timestamp: z.string().optional(),
      }),
    ),
    patient_info: z.object({}).passthrough().optional(),
    test_results_text: z.string().optional(),
    previous_visits_text: z.string().optional(),
    pre_summary_text: z.string().optional(),
    session_metadata: z.object({}).passthrough().optional(),
    created_at: z.string().optional(),
  }),
  system_prompt: z.string().optional(),
  user_prompt_template: z.string().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  context: z.string().optional(),
  use_enhanced_format: z.boolean().optional(),
  specialty: z.string().optional(),
  encounter_type: z.string().optional(),
  department: z.string().optional(),
  visit_type: z.string().optional(),
});

/**
 * TEXT Summary Response Schema
 */
export const TextSummaryResponseSchema = z.object({
  session_id: z.string(),
  summary: z.any(), // Complex nested structure
  created_at: z.string(),
  processing_time_ms: z.number(),
  token_usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
  llm_provider: z.string().optional(),
  model_name: z.string().optional(),
  confidence_score: z.number().nullable().optional(),
  metadata: z.object({}).passthrough().optional(),
});

/**
 * TEXT Pre-Summary Request Schema
 */
export const TextPreSummaryRequestSchema = z.object({
  current_department: z.string().optional(),
  visit_type: z.string().optional(),
  age: z.string().optional(),
  dob: z.string().optional(),
  gender: z.string().optional(),
  formatted_vitals: z.string().optional(),
  formatted_test_results: z.string().optional(),
  formatted_previous_visits: z.string().optional(),
  language: z.string().optional(),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
});

/**
 * TEXT Pre-Summary Response Schema
 */
export const TextPreSummaryResponseSchema = z.object({
  pre_summary: z.string(),
  structured_data: z.object({
    title: z.string(),
    sections: z.array(z.unknown()),
  }),
  created_at: z.string(),
});

/**
 * TEXT Job Response Schema
 */
export const TextJobResponseSchema = z.object({
  job_id: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
  created_at: z.string().optional(),
  session_id: z.string().optional(),
});

/**
 * TEXT Feedback Request Schema
 */
export const TextFeedbackRequestSchema = z.object({
  summary_id: z.string(),
  provider_id: z.string().optional(),
  rating: z.number().min(1).max(5),
  labels: z.array(z.string()).optional(),
  comment: z.string().optional(),
  corrected_summary: z.string().optional(),
});

/**
 * TEXT Feedback Response Schema
 */
export const TextFeedbackResponseSchema = z.object({
  feedback_id: z.string(),
  summary_id: z.string(),
  provider_id: z.string().nullable().optional(),
  rating: z.number(),
  labels: z.array(z.string()).nullable().optional(),
  comment: z.string().nullable().optional(),
  corrected_summary: z.string().nullable().optional(),
  created_at: z.string(),
});

// ============================================================================
// TTS Service Schemas
// ============================================================================

export const TtsSynthesizeRequestSchema = z.object({
  input: z.string().min(1),
  voice: z.string(),
  response_format: z.enum(['pcm', 'wav', 'mp3']).default('pcm'),
  speed: z.number().min(0.25).max(4.0).default(1.0),
  stream_format: z.enum(['audio', 'sse']).optional(),
});

export const TtsVoiceSchema = z.object({
  id: z.string(),
  locale: z.string(),
  providers: z.array(z.string()),
});

export const TtsVoicesResponseSchema = z.object({
  voices: z.array(TtsVoiceSchema),
});

// ============================================================================
// Type Exports
// ============================================================================

export type SttHealthResponse = z.infer<typeof SttHealthResponseSchema>;
export type SttStartSessionRequest = z.infer<typeof SttStartSessionRequestSchema>;
export type SttStartSessionResponse = z.infer<typeof SttStartSessionResponseSchema>;
export type SttTranscribeFileResponse = z.infer<typeof SttTranscribeFileResponseSchema>;
export type SttTaskStatusResponse = z.infer<typeof SttTaskStatusResponseSchema>;

export type TextHealthResponse = z.infer<typeof TextHealthResponseSchema>;
export type TextSyncSummaryRequest = z.infer<typeof TextSyncSummaryRequestSchema>;
export type TextSummaryResponse = z.infer<typeof TextSummaryResponseSchema>;
export type TextPreSummaryRequest = z.infer<typeof TextPreSummaryRequestSchema>;
export type TextPreSummaryResponse = z.infer<typeof TextPreSummaryResponseSchema>;
export type TextJobResponse = z.infer<typeof TextJobResponseSchema>;
export type TextFeedbackRequest = z.infer<typeof TextFeedbackRequestSchema>;
export type TextFeedbackResponse = z.infer<typeof TextFeedbackResponseSchema>;

export type TtsSynthesizeRequest = z.infer<typeof TtsSynthesizeRequestSchema>;
export type TtsVoicesResponse = z.infer<typeof TtsVoicesResponseSchema>;
