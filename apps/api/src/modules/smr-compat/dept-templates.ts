/**
 * v1 department- and visit-type-specific prompt template engine.
 *
 * Faithful port of the v1 SMR selectors:
 *   - visit-type normalization        → `prompt_selector.py:_normalize_visit_type`
 *                                        (47-66) / `prompts_json.py:_normalize_visit_type` (249-261)
 *   - department synonym resolution    → `prompts_json.py:get_department_schema` (264-289)
 *                                        + `prompt_selector.py:select_prompt_template` (78-154)
 *   - the 7-department × 2-visit map   → `prompts_json.py:DEPT_VISIT_SCHEMAS` (31-223)
 *
 * v1 constrains the LLM with the department-specific field set, then normalizes
 * the dept-specific keys BACK to the generic Simplified/Enhanced response
 * (`summary_service.py:_normalize_schema_keys*`). In this stateless shim the wire
 * response stays Simplified/Enhanced (enforced at `response_format.json_schema`),
 * so the department schema is used to STEER THE PROMPT — the field set becomes
 * "capture these department-relevant clinical areas" guidance — while the client
 * still receives the generic summary object. General/Medicine keeps the standard
 * conversational prompt (v1 special-case, `summary_service.py:253-265`).
 *
 * **Re-verified against the LIVE v1 pod 2026-08-07** (Rancher
 * `c-9lwv8`/`apps`/`apps-smr-84c9774997-zhp2l` — never a local checkout, which
 * has diverged — see `docs/implementation/TASK-634-.../README.md`).
 * `resolveDepartmentKey` below is the UNION of v1's two alias tables, which
 * are themselves NOT identical to each other in production:
 *   - `rheum`/`neuro`/`heme` and the bare `breast&endocrine` (no spaces)
 *     spelling exist ONLY in `prompts_json.py:get_department_schema`'s table,
 *     not in `prompt_selector.py:select_prompt_template`'s.
 *   - `breast`/`endocrine`/`breast endocrine`/`breast/endocrine` exist ONLY
 *     in `prompt_selector.py`'s table, not in `prompts_json.py`'s.
 *   - `orthopedics`/`orthopaedics`/`ortho`, `surgery`/`general surgery`, and
 *     `medicine`/`general medicine`/`internal medicine` are identical in both.
 * v2 has no equivalent of v1's per-string python branching (v1 doesn't match
 * against a DB row at all — it dispatches straight to a python module), so
 * there is no single v1 table to port byte-for-byte; taking the union is the
 * closest analogue and only ever WIDENS recognition versus either v1 path.
 *
 * ⚠ One entry does NOT come from either v1 table: bare `general` → `medicine`.
 * Neither `select_prompt_template`'s `("medicine", "general medicine",
 * "internal medicine")` nor `get_department_schema`'s `("general medicine",
 * "internal medicine")` matches unqualified `"general"` — in the pod, that
 * value falls through to `None` (CATCHALL_SOAP), the SAME outcome as a
 * missing department. This entry was already present before this
 * verification pass and is preserved deliberately: v2 wants free-text
 * `"General"` to resolve to the tenant's Medicine department rather than the
 * generic fallback (see `matchTenantDepartment`'s asymmetry tests). Flagged
 * here for the owner — this is a v2 design choice, not a v1 port.
 */

/** The 7 canonical v1 departments that carry dept×visit templates. */
export type DepartmentKey = 'surgery' | 'medicine' | 'rheumatology' | 'neurology' | 'orthopedics' | 'hematology' | 'breast_endocrine';

/** v1 normalizes every visit type to exactly one of these two buckets. */
export type VisitTypeKey = 'new_referral' | 'followup';

function norm(text?: string | null): string {
  return (text ?? '').trim().toLowerCase();
}

/**
 * Port of v1 `_normalize_visit_type` (`prompt_selector.py:47-66`, byte-identical
 * to `prompts_json.py:249-261`). Any referral/new/initial/consult synonym
 * (and the empty/unknown default) → `new_referral`; any follow-up/review/revisit
 * synonym → `followup`. Re-verified against the live v1 pod 2026-08-07
 * term list and precedence order match exactly, including
 * the misspellings (`referal`, `refferal`, `refer`, `referr`, `refd`).
 */
export function normalizeVisitType(visitType?: string | null): VisitTypeKey {
  let vt = norm(visitType);
  vt = vt.replace(/-/g, ' ').replace(/_/g, ' ');

  const referralTerms = [
    'new',
    'first',
    'initial',
    'exam',
    'examination',
    'referral',
    'referal',
    'refferal', // common variants/misspellings, per v1
    'refer',
    'referr',
    'refd',
    'consult',
    'consultation',
  ];
  if (referralTerms.some((term) => vt.includes(term))) return 'new_referral';

  const followupTerms = ['follow', 'follow up', 'followup', 'follow-up', 'fu', 'review', 'revisit', 'rv'];
  if (followupTerms.some((term) => vt.includes(term))) return 'followup';

  // v1 default: unspecified/empty or otherwise-unknown → new_referral.
  return 'new_referral';
}

/**
 * Port of the department synonym maps in v1 `get_department_schema`
 * (`prompts_json.py:269-283`) unioned with `select_prompt_template`'s extra
 * spellings (`prompt_selector.py:113-152`). Returns the canonical
 * `DepartmentKey`, or `null` when the department is not one of the 7 v1
 * departments (→ the generic conversational path).
 *
 * Re-verified against the live v1 pod 2026-08-07 — see the
 * module header for exactly which alias came from which of the two
 * (non-identical) v1 tables, and the one entry (`general` bare) that comes
 * from neither and is a deliberate v2 addition.
 */
export function resolveDepartmentKey(department?: string | null): DepartmentKey | null {
  const dept = norm(department);
  if (!dept) return null;

  // NOTE: bare "general" is NOT a v1 alias (verified — see module header);
  // "general medicine"/"internal medicine"/"medicine" are. Preserved
  // deliberately as a v2 design choice so free-text "General" resolves to
  // the tenant's Medicine department instead of the generic fallback.
  if (['general', 'general medicine', 'internal medicine', 'medicine'].includes(dept)) return 'medicine';
  if (
    ['breast & endocrine', 'breast and endocrine', 'breast&endocrine', 'breast endocrine', 'breast/endocrine', 'breast', 'endocrine'].includes(dept)
  ) {
    return 'breast_endocrine';
  }
  if (['orthopedics', 'orthopaedics', 'ortho'].includes(dept)) return 'orthopedics';
  if (['surgery', 'general surgery'].includes(dept)) return 'surgery';
  if (['rheumatology', 'rheum'].includes(dept)) return 'rheumatology';
  if (['neurology', 'neuro'].includes(dept)) return 'neurology';
  if (['hematology', 'haematology', 'heme'].includes(dept)) return 'hematology';

  return null;
}

/**
 * v1 `DEPT_VISIT_SCHEMAS` (`prompts_json.py:31-223`), ported verbatim (field
 * order preserved). Values mirror v1's `"string (markdown)"` descriptor; only
 * the ORDERED KEY SET is load-bearing here (it drives prompt guidance — see the
 * module header). Keyed `${DepartmentKey}:${VisitTypeKey}`.
 */
export const DEPT_VISIT_SCHEMAS: Record<string, Record<string, string>> = {
  'breast_endocrine:new_referral': {
    patient_demographics: 'string (markdown)',
    risk_factors_and_exposures: 'string (markdown)',
    personal_and_reproductive_history: 'string (markdown)',
    family_history: 'string (markdown)',
    presenting_complaints: 'string (markdown)',
    history_of_present_illness: 'string (markdown)',
    past_medical_and_surgical_history: 'string (markdown)',
    treatment_history: 'string (markdown)',
    medications_and_allergies: 'string (markdown)',
    physical_examination: 'string (markdown)',
    investigations: 'string (markdown)',
    diagnosis: 'string (markdown)',
    plan_of_care: 'string (markdown)',
    patient_education_and_consent: 'string (markdown)',
  },
  'breast_endocrine:followup': {
    patient_identifiers: 'string (markdown)',
    interval_since_last_visit: 'string (markdown)',
    review_of_previous_plan_and_adherence: 'string (markdown)',
    presenting_complaints_and_updates: 'string (markdown)',
    clinical_examination_updates: 'string (markdown)',
    investigations_compared: 'string (markdown)',
    treatment_history_and_response: 'string (markdown)',
    new_findings_and_complications: 'string (markdown)',
    plan_of_care_current: 'string (markdown)',
    follow_up_and_monitoring_strategy: 'string (markdown)',
    patient_education_and_consent: 'string (markdown)',
    prepared_by_and_signatories: 'string (markdown)',
  },
  'medicine:new_referral': {
    presenting_complaints: 'string (markdown)',
    past_history: 'string (markdown)',
    family_history: 'string (markdown)',
    drug_history: 'string (markdown)',
    hospital_admissions: 'string (markdown)',
    general_examination_and_vitals: 'string (markdown)',
    previous_diagnosis: 'string (markdown)',
    reports: 'string (markdown)',
    current_diagnosis: 'string (markdown)',
    plan_of_care: 'string (markdown)',
  },
  'medicine:followup': {
    last_visit_complaints: 'string (markdown)',
    previous_diagnosis: 'string (markdown)',
    current_medications: 'string (markdown)',
    investigations_previous_vs_current: 'string (markdown)',
    general_examination_and_vitals: 'string (markdown)',
    current_diagnosis: 'string (markdown)',
    treatment_plan: 'string (markdown)',
    follow_up_plan: 'string (markdown)',
    additional_data: 'string (markdown)',
    doctors_instructions_and_orders: 'string (markdown)',
  },
  'hematology:new_referral': {
    presenting_complaints: 'string (markdown)',
    referral_source: 'string (markdown)',
    history_of_presenting_illness: 'string (markdown)',
    family_history: 'string (markdown)',
    treatment_history: 'string (markdown)',
    investigations: 'string (markdown)',
    general_examination: 'string (markdown)',
    diagnosis: 'string (markdown)',
    treatment_advice: 'string (markdown)',
    remarks: 'string (markdown)',
    plan_of_care: 'string (markdown)',
  },
  'hematology:followup': {
    patient_details: 'string (markdown)',
    primary_diagnoses_and_comorbidities: 'string (markdown)',
    presenting_complaints: 'string (markdown)',
    treatment_history: 'string (markdown)',
    history_of_presenting_illness: 'string (markdown)',
    past_medical_and_surgical_history: 'string (markdown)',
    family_history: 'string (markdown)',
    investigations: 'string (markdown)',
    clinical_summary_of_findings: 'string (markdown)',
    discussion: 'string (markdown)',
    treatment_options_considered: 'string (markdown)',
    plan_of_care: 'string (markdown)',
    follow_up_and_monitoring: 'string (markdown)',
    prepared_by_and_signatories: 'string (markdown)',
  },
  'rheumatology:new_referral': {
    symptoms: 'string (markdown)',
    current_issues: 'string (markdown)',
    past_history: 'string (markdown)',
    treatment_history: 'string (markdown)',
    personal_history: 'string (markdown)',
    family_history: 'string (markdown)',
    general_examination: 'string (markdown)',
    local_examination: 'string (markdown)',
    impression: 'string (markdown)',
    plan: 'string (markdown)',
    patient_global_health: 'string (markdown)',
    remarks: 'string (markdown)',
  },
  'rheumatology:followup': {
    diagnosis: 'string (markdown)',
    disease_activity: 'string (markdown)',
    current_issues: 'string (markdown)',
    medication_review_rx: 'string (markdown)',
    review_on: 'string (markdown)',
    tests_to_do: 'string (markdown)',
    advice: 'string (markdown)',
    plan: 'string (markdown)',
    consultation_notes: 'string (markdown)',
    lab_reports: 'string (markdown)',
  },
  'neurology:new_referral': {
    presenting_complaints: 'string (markdown)',
    history: 'string (markdown)',
    clinical_examination: 'string (markdown)',
    investigations: 'string (markdown)',
    diagnosis: 'string (markdown)',
    treatment_advice: 'string (markdown)',
    remarks: 'string (markdown)',
    plan_of_care: 'string (markdown)',
  },
  'neurology:followup': {
    diagnosis_and_visit_context: 'string (markdown)',
    interval_since_last_visit: 'string (markdown)',
    previous_recommendations: 'string (markdown)',
    adherence_assessment: 'string (markdown)',
    current_symptom_assessment: 'string (markdown)',
    comparative_clinical_findings: 'string (markdown)',
    medication_effectiveness_and_tolerance: 'string (markdown)',
    new_patient_concerns: 'string (markdown)',
    new_clinical_findings: 'string (markdown)',
    laboratory_and_imaging_updates: 'string (markdown)',
    comorbidity_control_status: 'string (markdown)',
    vital_signs: 'string (markdown)',
    additional_discussion_points: 'string (markdown)',
    doctors_current_instructions: 'string (markdown)',
  },
  'surgery:new_referral': {
    biodata: 'string (markdown)',
    presenting_complaints: 'string (markdown)',
    comorbidities: 'string (markdown)',
    past_surgical_history: 'string (markdown)',
    family_history: 'string (markdown)',
    general_examination: 'string (markdown)',
    systemic_examination: 'string (markdown)',
    investigations: 'string (markdown)',
    current_diagnosis: 'string (markdown)',
    plan_of_care: 'string (markdown)',
    fitness_for_surgery: 'string (markdown)',
  },
  'surgery:followup': {
    biodata: 'string (markdown)',
    last_visit_details: 'string (markdown)',
    any_new_complaints_after_treatment_surgery: 'string (markdown)',
    general_examination: 'string (markdown)',
    systemic_examination: 'string (markdown)',
    investigations: 'string (markdown)',
    treatment_plan_follow_up: 'string (markdown)',
  },
  'orthopedics:new_referral': {
    patient_details: 'string (markdown)',
    chief_complaints: 'string (markdown)',
    history_of_illness: 'string (markdown)',
    past_history: 'string (markdown)',
    personal_history: 'string (markdown)',
    examination: 'string (markdown)',
    provisional_diagnosis: 'string (markdown)',
    investigations_ordered: 'string (markdown)',
    treatment_plan: 'string (markdown)',
    review_date: 'string (markdown)',
  },
  'orthopedics:followup': {
    patient_details: 'string (markdown)',
    current_complaints: 'string (markdown)',
    clinical_findings: 'string (markdown)',
    investigations_reviewed: 'string (markdown)',
    current_plan: 'string (markdown)',
    next_review_date: 'string (markdown)',
  },
};

/** Resolved dept×visit template guidance. */
export interface DeptTemplate {
  deptKey: DepartmentKey;
  visitType: VisitTypeKey;
  /** Ordered department-relevant section field names (v1 schema keys). */
  fields: string[];
}

/**
 * Select the department×visit template for prompt steering, mirroring v1
 * `select_prompt_template` + `get_department_schema`. Returns `null` when:
 *   - the department is not one of the 7 v1 departments, OR
 *   - the department resolves to General/Medicine — v1 special-cases General
 *     Medicine to the standard conversational prompt (`summary_service.py:253-265`),
 * in both cases falling back to the existing generic Simplified/Enhanced path.
 */
export function selectDeptTemplate(department?: string | null, visitType?: string | null): DeptTemplate | null {
  const deptKey = resolveDepartmentKey(department);
  if (!deptKey || deptKey === 'medicine') return null;

  const visit = normalizeVisitType(visitType);
  const schema = DEPT_VISIT_SCHEMAS[`${deptKey}:${visit}`];
  if (!schema) return null;

  return { deptKey, visitType: visit, fields: Object.keys(schema) };
}

/** `presenting_complaints` → `Presenting Complaints` (readable prompt guidance). */
export function humanizeField(field: string): string {
  return field
    .split('_')
    .map((word) => (word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join(' ');
}
