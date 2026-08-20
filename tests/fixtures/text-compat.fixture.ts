/**
 * Golden fixtures for the v1-compatible TEXT summary shims.
 *
 * Frozen sample payloads for the compat endpoints. They
 * are the regression anchor for `tests/contracts/text-compat.contract.test.ts`
 * (schema lock) and the live-response assertions in the e2e spec. If a
 * future change reshapes a v1 contract, validating these fixtures fails.
 *
 * Do NOT restate schemas here divergently — these are concrete
 * INSTANCES of those shapes, not the schema.
 */

import type { EnhancedMedicalSummary, SimplifiedMedicalSummary } from '@arcaai/vox/compat';

/**
 * Golden `SessionData` — the request body a v1 app sends to
 * `POST /api/smr/api/v1/summary/sync` (TEXT_Summary_Endpoints.md §3.1.1). Real
 * per-turn `conversation_segments` (never one collapsed blob).
 */
export const GOLDEN_SESSION_DATA = {
  session_id: 'golden-sess-001',
  patient_id: 'pat-42',
  provider_id: 'dr-1',
  created_at: '2026-07-28T00:00:00.000Z',
  conversation_segments: [
    { speaker: 'provider', text: 'What brings you in today?', timestamp: '2026-07-28T00:00:01.000Z' },
    { speaker: 'patient', text: 'Chest tightness for three days.', timestamp: '2026-07-28T00:00:05.000Z', confidence: 0.94 },
    { speaker: 'provider', text: 'Any shortness of breath?', timestamp: '2026-07-28T00:00:09.000Z' },
    { speaker: 'patient', text: 'A little, when I climb stairs.', timestamp: '2026-07-28T00:00:12.000Z', confidence: 0.9 },
  ],
  patient_info: { name: 'A. Kumar', age: '58', gender: 'male' },
  session_metadata: { language: 'en', department_id: 'cardiology', visit_type: 'New Referral' },
  test_results: [],
  previous_visits: [],
  test_results_text: 'Troponin: normal. ECG: sinus rhythm.',
  previous_visits_text: null,
  pre_summary_text: null,
} as const;

/** Golden full sync-summary request (Simplified format). */
export const GOLDEN_SYNC_SUMMARY_REQUEST = {
  session_data: GOLDEN_SESSION_DATA,
  use_enhanced_format: false,
  department: 'Cardiology',
  visit_type: 'New Referral',
  temperature: 0.2,
  max_tokens: 800,
  include_pre_summary_in_context: false,
} as const;

/** Golden `SimplifiedMedicalSummary` (`use_enhanced_format: false`). */
export const GOLDEN_SIMPLIFIED_SUMMARY: SimplifiedMedicalSummary = {
  chief_complaint: 'Chest tightness for three days',
  symptoms: ['chest tightness', 'exertional dyspnea'],
  medical_history: 'No prior cardiac history reported.',
  examination: 'Not documented in this encounter.',
  assessment: 'Likely stable angina; rule out ACS.',
  treatment_plan: 'Aspirin 75mg daily; cardiology follow-up.',
  follow_up: 'Return in 2 weeks or sooner if symptoms worsen.',
  summary: 'A 58-year-old male with three days of exertional chest tightness, likely stable angina.',
};

/** Golden `EnhancedMedicalSummary` (`use_enhanced_format: true`). */
export const GOLDEN_ENHANCED_SUMMARY: EnhancedMedicalSummary = {
  encounter_summary: {
    chief_complaint: 'Chest tightness for three days',
    history_of_present_illness: {
      onset: '3 days ago',
      location: 'central chest',
      duration: 'intermittent',
      characteristics: 'tightness',
      aggravating_factors: ['exertion', 'climbing stairs'],
      relieving_factors: ['rest'],
      timing: 'exertional',
      severity: 'moderate',
      associated_symptoms: ['dyspnea'],
    },
    review_of_systems: { cardiovascular: 'chest tightness', respiratory: 'mild exertional dyspnea' },
  },
  clinical_findings: {
    vital_signs: { blood_pressure: '142/88', heart_rate: '78', oxygen_saturation: '98%' },
    physical_examination: { general: 'well-appearing', cardiovascular: 'regular rate and rhythm' },
    diagnostic_results: { laboratory: ['Troponin: normal'], imaging: [], other_tests: ['ECG: sinus rhythm'] },
  },
  clinical_assessment: {
    primary_diagnosis: { diagnosis: 'Stable angina', icd10_code: 'I20.9', certainty: 'Suspected' },
    differential_diagnoses: [{ diagnosis: 'Acute coronary syndrome', likelihood: 'Low', reasoning: 'Normal troponin, sinus rhythm' }],
    clinical_reasoning: 'Exertional pattern relieved by rest suggests stable angina.',
    risk_stratification: 'Intermediate',
  },
  treatment_plan: {
    medications: [{ name: 'Aspirin', dose: '75mg', route: 'oral', frequency: 'daily', indication: 'antiplatelet' }],
    procedures: [],
    lifestyle_modifications: ['smoking cessation counseling'],
    patient_education: ['recognize warning signs of MI'],
    referrals: [{ specialty: 'Cardiology', reason: 'stress testing', urgency: 'Routine' }],
  },
  follow_up: { timeline: '2 weeks', provider: 'Cardiology', conditions: 'sooner if worsening', warning_signs: ['rest pain', 'syncope'] },
  clinical_summary: {
    summary: 'A 58-year-old male with exertional chest tightness, likely stable angina; cardiology referral placed.',
    key_findings: ['exertional chest tightness', 'normal troponin'],
    pending_items: ['stress test'],
    care_coordination: 'Cardiology referral',
  },
  quality_metrics: { completeness_score: 0.82, confidence_level: 'Medium', missing_information: ['physical exam detail'], documentation_flags: [] },
};

/** Golden `SummaryResponse` envelope — the shim's 200 body, Simplified. */
export const GOLDEN_SUMMARY_RESPONSE = {
  session_id: 'golden-sess-001',
  summary: GOLDEN_SIMPLIFIED_SUMMARY,
  created_at: '2026-07-28T00:00:00.000Z',
  processing_time_ms: 1234,
  token_usage: { prompt_tokens: 320, completion_tokens: 210, total_tokens: 530 },
  confidence_score: null,
  metadata: {
    finish_reason: 'stop',
    temperature: 0.2,
    max_tokens: 800,
    use_enhanced_format: false,
    language: 'en',
    specialty: null,
    encounter_type: null,
  },
} as const;

/** Golden `PreSummaryResponse` — `sections: []`, `pre_summary` is source of truth. */
export const GOLDEN_PRE_SUMMARY_RESPONSE = {
  pre_summary:
    '# Pre-Summary of Medical History\n\n**Confirmed & Provisional Diagnoses**\n- Hypertension on lisinopril\n\n**Plan of Care**\n- Continue current medications',
  structured_data: {
    title: 'Pre-Summary of Medical History',
    sections: [
      { title: 'Confirmed & Provisional Diagnoses', items: [{ text: 'Hypertension on lisinopril' }] },
      { title: 'Plan of Care', items: [{ text: 'Continue current medications' }] },
    ],
  },
  created_at: '2026-07-28T00:00:00.000Z',
} as const;

/** Golden pre-summary request. */
export const GOLDEN_PRE_SUMMARY_REQUEST = {
  current_department: 'Cardiology',
  visit_type: 'Follow-up',
  age: '58',
  gender: 'male',
  formatted_vitals: 'BP 142/88, HR 78, SpO2 98%',
  formatted_test_results: 'Troponin normal; LDL 150 mg/dL',
  language: 'en',
} as const;
