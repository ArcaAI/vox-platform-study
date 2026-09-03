/**
 * JSON-schema lock for the v1-compatible TEXT summary shim contracts.
 *
 * Zod schemas mirroring the FROZEN v1 shapes
 * (TEXT_Summary_Endpoints.md They are the drift guard for the
 * gateway compat endpoints:
 *   - `tests/contracts/text-compat.contract.test.ts` validates the golden
 *     fixtures against them (hermetic);
 *   - the e2e spec validates a LIVE 200 response against them when TEXT
 *     is up.
 *
 * Contract intent: the v1-REQUIRED keys are enforced; UNKNOWN keys are tolerated
 * (zod strips them, parse still succeeds) so the LLM may emit extra fields
 * without breaking a migrated app — mirrors the forward-compat posture of the
 * existing TEXT contract tests. Do not restate these shapes divergently; these encode them.
 */

import { z } from 'zod';

// ============================================================================
// SimplifiedMedicalSummary (use_enhanced_format: false)
// Required set matches the as-built SIMPLIFIED_SUMMARY_SCHEMA: chief_complaint + summary.
// ============================================================================
export const SimplifiedMedicalSummarySchema = z.object({
  chief_complaint: z.string(),
  symptoms: z.array(z.string()).optional(),
  medical_history: z.string().optional(),
  examination: z.string().optional(),
  assessment: z.string().optional(),
  treatment_plan: z.string().optional(),
  follow_up: z.string().optional(),
  summary: z.string(),
});

// ============================================================================
// EnhancedMedicalSummary (use_enhanced_format: true)
// Required set matches the as-built ENHANCED_SUMMARY_SCHEMA:
// encounter_summary, clinical_assessment, clinical_summary.
// ============================================================================
export const EnhancedMedicalSummarySchema = z.object({
  encounter_summary: z.object({
    chief_complaint: z.string(),
    history_of_present_illness: z.record(z.string(), z.unknown()).optional(),
    review_of_systems: z.record(z.string(), z.unknown()).optional(),
  }),
  clinical_findings: z.record(z.string(), z.unknown()).optional(),
  clinical_assessment: z.object({
    primary_diagnosis: z.object({
      diagnosis: z.string(),
      icd10_code: z.string().nullable().optional(),
      certainty: z.string().optional(),
    }),
    differential_diagnoses: z.array(z.record(z.string(), z.unknown())).optional(),
    clinical_reasoning: z.string().nullable().optional(),
    risk_stratification: z.string().nullable().optional(),
  }),
  treatment_plan: z.record(z.string(), z.unknown()).optional(),
  follow_up: z.record(z.string(), z.unknown()).optional(),
  clinical_summary: z.object({
    summary: z.string(),
    key_findings: z.array(z.string()).optional(),
    pending_items: z.array(z.string()).optional(),
    care_coordination: z.string().nullable().optional(),
  }),
  quality_metrics: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// SummaryResponse envelope (the /summary/sync 200 body)
// ============================================================================
export const SummaryResponseMetadataSchema = z.object({
  use_enhanced_format: z.boolean(),
  finish_reason: z.string().optional(),
  temperature: z.number().nullable().optional(),
  max_tokens: z.number().nullable().optional(),
  language: z.string().optional(),
  specialty: z.string().nullable().optional(),
  encounter_type: z.string().nullable().optional(),
  pre_summary_text: z.string().optional(),
  // v1-parity display labels, echoed by `mapGenerateToV1Summary`. Declared here
  // so the lock documents them; they were added to the DTO/mapper/SDK without
  // reaching this file.
  llm_provider: z.string().nullable().optional(),
  model_name: z.string().nullable().optional(),
  parsing_method: z.string().nullable().optional(),
  raw_llm_content: z.string().nullable().optional(),
});

export const SummaryResponseSchema = z.object({
  session_id: z.string(),
  // `summary` is the parsed LLM object — Enhanced OR Simplified. Kept as an
  // object here; the granular schemas above assert the two concrete shapes.
  summary: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  processing_time_ms: z.number().nullable().optional(),
  token_usage: z.record(z.string(), z.number().nullable()).nullable().optional(),
  confidence_score: z.number().nullable().optional(),
  metadata: SummaryResponseMetadataSchema,
});

// ============================================================================
// PreSummaryResponse (the /presummary 200 body)
// ============================================================================
export const PreSummarySectionSchema = z.object({
  title: z.string(),
  items: z.array(z.object({ text: z.string() })),
});

export const StructuredPreSummarySchema = z.object({
  title: z.string(),
  sections: z.array(PreSummarySectionSchema),
});

export const PreSummaryResponseSchema = z.object({
  pre_summary: z.string(),
  structured_data: StructuredPreSummarySchema,
  created_at: z.string(),
});

// ============================================================================
// Request-side schema (golden SessionData lock) — request body.
// ============================================================================
export const ConversationSegmentSchema = z.object({
  speaker: z.string(),
  text: z.string(),
  timestamp: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const SessionDataSchema = z.object({
  session_id: z.string(),
  created_at: z.string(),
  patient_id: z.string().nullable().optional(),
  provider_id: z.string().nullable().optional(),
  conversation_segments: z.array(ConversationSegmentSchema).optional(),
  patient_info: z.record(z.string(), z.unknown()).nullable().optional(),
  session_metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  test_results: z.array(z.record(z.string(), z.unknown())).optional(),
  previous_visits: z.array(z.record(z.string(), z.unknown())).optional(),
  test_results_text: z.string().nullable().optional(),
  previous_visits_text: z.string().nullable().optional(),
  pre_summary_text: z.string().nullable().optional(),
});
