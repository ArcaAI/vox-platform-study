'use client';

/**
 * @arcaai/vox/compat - v1 SDK type surface
 *
 * These are the HOPE-v1 (`@arcaai/agentic-sdk`) type shapes reproduced verbatim
 * from the FROZEN canonical contracts in TASK-560 §5. They exist ONLY so a v1
 * application keeps compiling against familiar names while the compat hooks
 * adapt them onto the v2 (`@arcaai/vox`) public API.
 *
 * NOTE: the v1 hardcoded default `apiKey`/`encryptionKey` (TASK-560 §6 A1) is
 * deliberately NOT reproduced anywhere in this layer.
 */

// =============================================================================
// Config (TASK-560 §5.1)
// =============================================================================

/** v1 audio settings subset that the config adapter maps onto v2. */
export interface V1AudioSettings {
  sampleRate?: number;
  format?: string;
  channels?: number;
  noiseSuppression?: boolean;
  echoCancellation?: boolean;
  autoGainControl?: boolean;
}

/** v1 `SDK_CONFIG_OPTIONS` — the subset that matters for the migration. */
export interface V1SdkConfig {
  /** REST base, e.g. `https://api.arcaai.com`. */
  apiEndpoint: string;
  /** WebSocket base, e.g. `wss://api.arcaai.com`. */
  websocketUrl: string;
  /** API key — REQUIRED. There is NO baked-in default (TASK-560 §6 A1). */
  credentials?: { apiKey?: string };
  audioSettings?: V1AudioSettings;
  environment?: 'development' | 'staging' | 'production';
  /**
   * Backend ASR pipeline id for live streaming transcription. v1 had no such
   * field (its STT WS was api-key-flat); v2 requires a `pipelineId` to route
   * STT to the backend streaming provider. Optional — omit for local STT.
   */
  sttPipelineId?: string;
}

// =============================================================================
// Errors (TASK-560 §5.2)
// =============================================================================

export interface ErrorInfo {
  code: string;
  message: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  category: 'network' | 'audio' | 'processing' | 'authentication' | 'configuration';
  details?: Record<string, unknown>;
  stack?: string;
}

// =============================================================================
// Session (TASK-560 §5.2)
// =============================================================================

/** v1 session lifecycle status. */
export type SessionStatus = 'IDLE' | 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'TERMINATED' | 'SUSPENDED';

export interface PatientInfo {
  id?: string;
  mrn?: string;
  name?: string;
  age?: string;
  gender?: string;
  date_of_birth?: string;
  [key: string]: unknown;
}

export interface ProviderInfo {
  id: string;
  name: string;
  role?: 'physician' | 'nurse' | 'specialist' | 'technician';
  department?: string;
}

export interface SessionMetadata {
  title?: string;
  description?: string;
  tags: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  patientInfo?: PatientInfo;
  providerInfo?: ProviderInfo;
  sessionType: 'consultation' | 'follow-up' | 'emergency' | 'routine';
  customFields: Record<string, unknown>;
  /** Legacy v1 doctor id, carried in metadata (v2 derives the doctor from auth). */
  legacyDoctorId?: string;
  [key: string]: unknown;
}

/**
 * Synthesized v1 `MedicalSession` view (TASK-560 §5.2 — "synthesized view: id,
 * status, timestamps"). Built from the v2 `Consultation` + local status; the
 * heavyweight v1 audio/transcript/device sub-objects are intentionally omitted.
 */
export interface MedicalSession {
  id: string;
  patientId?: string;
  doctorId?: string;
  status: SessionStatus;
  startTime: Date;
  lastActivity: Date;
  endTime?: Date;
  department?: string;
  metadata: SessionMetadata;
}

// =============================================================================
// Audio (TASK-560 §5.3)
// =============================================================================

export interface AudioDeviceStatus {
  inputDevices: MediaDeviceInfo[];
  selectedDevice?: MediaDeviceInfo;
  permissionStatus: 'granted' | 'denied' | 'prompt';
  audioLevel: number;
}

// =============================================================================
// SMR summary (TASK-560 §5.4 / §5.5) — frozen v1 Enhanced/Simplified/SOAP shapes
// =============================================================================

export interface HistoryOfPresentIllness {
  onset?: string;
  location?: string;
  duration?: string;
  characteristics?: string;
  aggravating_factors: string[];
  relieving_factors: string[];
  timing?: string;
  severity?: string;
  associated_symptoms: string[];
}

export interface ReviewOfSystems {
  constitutional?: string;
  cardiovascular?: string;
  respiratory?: string;
  gastrointestinal?: string;
  genitourinary?: string;
  musculoskeletal?: string;
  neurological?: string;
  psychiatric?: string;
}

export interface EncounterSummary {
  chief_complaint: string;
  history_of_present_illness: HistoryOfPresentIllness;
  review_of_systems: ReviewOfSystems;
}

export interface VitalSigns {
  blood_pressure?: string;
  heart_rate?: string;
  respiratory_rate?: string;
  temperature?: string;
  oxygen_saturation?: string;
  pain_score?: string;
}

export interface PhysicalExamination {
  general?: string;
  cardiovascular?: string;
  respiratory?: string;
  abdominal?: string;
  neurological?: string;
  musculoskeletal?: string;
  skin?: string;
  other?: string;
}

export interface DiagnosticResults {
  laboratory: string[];
  imaging: string[];
  other_tests: string[];
}

export interface ClinicalFindings {
  vital_signs: VitalSigns;
  physical_examination: PhysicalExamination;
  diagnostic_results: DiagnosticResults;
}

export interface PrimaryDiagnosis {
  diagnosis: string;
  icd10_code?: string;
  certainty: string;
}

export interface DifferentialDiagnosis {
  diagnosis: string;
  likelihood: string;
  reasoning?: string;
}

export interface ClinicalAssessment {
  primary_diagnosis: PrimaryDiagnosis;
  differential_diagnoses: DifferentialDiagnosis[];
  clinical_reasoning?: string;
  risk_stratification?: string;
}

export interface Medication {
  name: string;
  dose?: string;
  route?: string;
  frequency?: string;
  duration?: string;
  indication?: string;
}

export interface Referral {
  specialty: string;
  reason: string;
  urgency: string;
}

export interface TreatmentPlan {
  medications: Medication[];
  procedures: string[];
  lifestyle_modifications: string[];
  patient_education: string[];
  referrals: Referral[];
}

export interface FollowUp {
  timeline?: string;
  provider?: string;
  conditions?: string;
  warning_signs: string[];
}

export interface ClinicalSummarySection {
  summary: string;
  key_findings: string[];
  pending_items: string[];
  care_coordination?: string;
}

export interface QualityMetrics {
  completeness_score: number;
  confidence_level: string;
  missing_information: string[];
  documentation_flags: string[];
}

/** Enhanced medical summary (primary v1 interface). */
export interface EnhancedMedicalSummary {
  encounter_summary: EncounterSummary;
  clinical_findings: ClinicalFindings;
  clinical_assessment: ClinicalAssessment;
  treatment_plan: TreatmentPlan;
  follow_up: FollowUp;
  clinical_summary: ClinicalSummarySection;
  quality_metrics: QualityMetrics;
}

/** Simplified medical summary (v1 backward-compat). */
export interface SimplifiedMedicalSummary {
  chief_complaint: string;
  symptoms: string[];
  medical_history: string;
  examination: string;
  assessment: string;
  treatment_plan: string;
  follow_up: string;
  summary: string;
}

/** Catch-all SOAP summary (v1 default for unknown/general departments). */
export interface SoapMedicalSummary {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

export type MedicalSummary = EnhancedMedicalSummary | SimplifiedMedicalSummary | SoapMedicalSummary;

/** v1 `SummaryResponse` returned by `POST /api/smr/api/v1/summary/sync`. */
export interface SummaryResponse {
  session_id: string;
  summary: MedicalSummary;
  created_at: string;
  processing_time_ms?: number;
  token_usage?: Record<string, number>;
  confidence_score?: number;
  previous_visit_summary?: unknown;
  metadata?: Record<string, unknown>;
}

export interface SMRJobStatus {
  job_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  created_at: string;
  started_at?: string;
  completed_at?: string;
  progress_percent?: number;
  current_step?: string;
  result?: SummaryResponse;
  error?: string;
  retry_count?: number;
  max_retries?: number;
  metadata?: Record<string, unknown>;
}

export interface TestResult {
  test_name: string;
  test_type: string;
  result: string;
  date?: string;
  reference_range?: string;
  status?: string;
  ordering_provider?: string;
}

export interface PreviousVisitRecord {
  visit_date: string;
  visit_type: string;
  provider?: string;
  chief_complaint: string;
  diagnosis?: string;
  treatment?: string;
  follow_up_plan?: string;
  visit_summary?: string;
  medications_prescribed: string[];
  tests_ordered: string[];
}

/** A single per-turn conversation segment (F2 — real per-turn, never collapsed). */
export interface ConversationSegmentInput {
  speaker?: string;
  text: string;
  timestamp?: string;
  confidence?: number;
}

/** v1 `SMRRequest` (subset relevant to the workflow). */
export interface SMRRequest {
  /** Full transcript text. Split per-line into per-turn segments when `segments` is absent. */
  text: string;
  /**
   * Per-turn conversation segments. PREFERRED over `text` — passing this array
   * sends real per-turn segments to the backend (TASK-560 §6 F2), never one
   * collapsed `speaker:'user'` blob.
   */
  segments?: ConversationSegmentInput[];
  sessionId?: string;
  language?: string;
  template?: string;
  patientId?: string;
  patientName?: string;
  patientInfo?: PatientInfo;
  departmentId?: string;
  doctorId?: string;
  doctorName?: string;
  doctorRole?: string;
  visitType?: string;
  departmentContext?: Record<string, unknown>;
  testResults?: TestResult[];
  previousVisits?: PreviousVisitRecord[];
  testResultsText?: string;
  previousVisitsText?: string;
  preSummaryText?: string;
  includePreSummaryInContext?: boolean;
  useEnhancedFormat?: boolean;
}

// =============================================================================
// Pre-summary (TASK-560 §5.5)
// =============================================================================

export interface PreSummaryRequest {
  current_department?: string;
  visit_type?: string;
  age?: string;
  dob?: string;
  gender?: string;
  formatted_vitals?: string;
  formatted_test_results?: string;
  formatted_previous_visits?: string;
  language?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface PreSummarySectionItem {
  text: string;
}

export interface PreSummarySection {
  title: string;
  items: PreSummarySectionItem[];
}

export interface StructuredPreSummary {
  title: string;
  sections: PreSummarySection[];
}

export interface PreSummaryResponse {
  pre_summary: string;
  structured_data: StructuredPreSummary;
  created_at: string;
}
