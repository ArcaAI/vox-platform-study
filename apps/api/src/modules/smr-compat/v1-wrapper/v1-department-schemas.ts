/**
 * v1's per-(department × visit-type) JSON response schemas —
 * `DEPT_VISIT_SCHEMAS` (`apps/smr/src/smr/models/prompts_json.py`), and the
 * generic fallback `JSON_RESPONSE_SPEC` returned by `get_department_schema`
 * for a department/visit-type pair with no dedicated schema (v1 NEVER
 * returns an empty/falsy schema — see the WITHOUT-SCHEMA branch note in
 * `v1-strict-json-response-format.ts`).
 *
 * 22 (department, visit_type) pairs, keyed on v1's internal
 * dept slug (matching `resolveDepartmentKey`/`normalizeVisitType` in
 * `../dept-templates.ts`) and v1's visit-type key
 * (`new_referral` | `followup`): 11 departments × 2 visit types.
 *
 * NOTE: this is a DIFFERENT — and larger — set than the 7-department × 2
 * body-template matrix ported into `../dept-templates.ts` (D-07's 14
 * audited templates). v1 has body-template CONTENT for only 7 departments,
 * but a JSON response-shape SCHEMA for 11 (the extra 4 — dietetics,
 * dermatology, nephrology, surgical_oncology — get a schema-shaped prompt
 * with no department-specific CONTENT preface). This module carries the
 * full 11/22 schema set as extracted; reconciling it with `dept-templates.ts`
 * is a wiring-phase decision, not this extraction's.
 *
 * Source: the RUNNING v1 SMR pod (Rancher cluster c-9lwv8, namespace apps,
 * pod apps-smr-84c9774997-zhp2l), NOT a local v1 checkout — the two have
 * diverged (see docs/implementation/TASK-634-Pre-Summary-Summary-Prompt-Fidelity/README.md
 * §2.2, §2.9). Extracted 2026-08-07 via a chunked base64 pipeline (never
 * retyped) with every chunk sha256-verified against the pod before
 * concatenation, then cross-checked two independent reconstruction methods
 * (direct Python execution vs. `ast`-based literal extraction) for
 * byte-for-byte agreement. See §2.14 D-12 and the TASK-634 README Phase 5.
 *
 * GENERATED, DO NOT HAND-EDIT — regenerate from the pod, never retype.
 * json_response_spec_fallback sha256 fd5c50d7aa259dc655263f7741c6e3c919384faff6130b7c3b659080b947e457  143 bytes
 * dept_visit_schemas (all 22, canonical JSON) sha256 5233b803a2848464fa839ac4656aedb6dd9823a17d1f493b8c9c4bf010ef363d  12294 bytes
 */

/** Byte-exact v1 generic JSON_RESPONSE_SPEC fallback schema, as a `json.dumps(indent=2)`-equivalent JSON string (parse before use). */
export const V1_JSON_RESPONSE_SPEC_FALLBACK_JSON: string =
  '{\n  "subjective": "string (markdown)",\n  "objective": "string (markdown)",\n  "assessment": "string (markdown)",\n  "plan": "string (markdown)"\n}';

/** JSON schema dict shape used throughout `V1_DEPT_VISIT_SCHEMAS` (field name → free-text type description). */
export type V1DeptVisitSchema = Record<string, string>;

/**
 * `department_slug → visit_type_key → JSON schema dict`, byte-exact from v1
 * `DEPT_VISIT_SCHEMAS`. Plain nested object (not a `Map` keyed by tuples —
 * array keys compare by reference, not value, so `.get(['a','b'])` would
 * never hit); look up with `V1_DEPT_VISIT_SCHEMAS[deptSlug]?.[visitKey]`.
 */
export const V1_DEPT_VISIT_SCHEMAS: Readonly<Record<string, Readonly<Record<string, V1DeptVisitSchema>>>> = {
  breast_endocrine: {
    followup: {
      patient_identifiers: 'string (markdown)',
      interval_since_last_visit: 'string (markdown)',
      review_of_previous_plan_and_adherence: 'string (markdown)',
      presenting_complaints_and_updates: 'string (markdown)',
      clinical_examination_updates: 'string (markdown)',
      investigations_compared: 'string (markdown)',
      treatment_history_and_response: 'string    (markdown)',
      new_findings_and_complications: 'string (markdown)',
      plan_of_care_current: 'string (markdown)',
      follow_up_and_monitoring_strategy: 'string (markdown)',
      patient_education_and_consent: 'string (markdown)',
      prepared_by_and_signatories: 'string (markdown)',
    },
    new_referral: {
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
  },
  dermatology: {
    followup: {
      response_to_treatment: 'string (markdown)',
      medication_adherence: 'string (markdown)',
      new_symptoms_or_lesions: 'string (markdown)',
      follow_up_investigations: 'string (markdown)',
      clinical_examination: 'string (markdown)',
      updated_diagnosis_or_assessment: 'string (markdown)',
      updated_treatment_plan: 'string (markdown)',
      next_follow_up_advice: 'string (markdown)',
    },
    new_referral: {
      presenting_complaints: 'string (markdown)',
      evolution_of_symptoms: 'string (markdown)',
      aggravating_and_relieving_factors: 'string (markdown)',
      past_history_of_similar_complaints: 'string (markdown)',
      preceding_illnesses_or_new_exposures: 'string (markdown)',
      history_of_atopy: 'string (markdown)',
      treatment_history: 'string (markdown)',
      occupation: 'string (markdown)',
      personal_history: 'string (markdown)',
      past_medical_history: 'string (markdown)',
      family_history: 'string (markdown)',
      clinical_examination: 'string (markdown)',
      impression: 'string (markdown)',
      investigations_ordered: 'string (markdown)',
      treatment_plan: 'string (markdown)',
      follow_up_advice: 'string (markdown)',
    },
  },
  dietetics: {
    followup: {
      anthropometric_measurements: 'string (markdown)',
      nutrition_screening: 'string (markdown)',
      nutritional_status: 'string (markdown)',
      plan_of_care: 'string (markdown)',
      summary: 'string (markdown)',
    },
    new_referral: {
      patient_history: 'string (markdown)',
      anthropometric_measurements: 'string (markdown)',
      diet_history: 'string (markdown)',
      nutrition_screening: 'string (markdown)',
      nutritional_status: 'string (markdown)',
      nutrition_diagnosis: 'string (markdown)',
      plan_of_care: 'string (markdown)',
    },
  },
  hematology: {
    followup: {
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
    new_referral: {
      presenting_complaints: 'string (markdown)',
      history_of_presenting_illness: 'string (markdown)',
      family_history: 'string (markdown)',
      treatment_history: 'string (markdown)',
      general_examination: 'string (markdown)',
      diagnosis: 'string (markdown)',
      plan_of_care: 'string (markdown)',
    },
  },
  medicine: {
    followup: {
      new_complaints: 'string (markdown)',
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
    new_referral: {
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
  },
  nephrology: {
    followup: {
      date_of_review: 'string (markdown)',
      symptom_review: 'string (markdown)',
      medication_review: 'string (markdown)',
      examination: 'string (markdown)',
      investigations_reviewed: 'string (markdown)',
      current_diagnosis: 'string (markdown)',
      updated_plan_of_care: 'string (markdown)',
      investigations_to_be_done_on_review: 'string (markdown)',
    },
    new_referral: {
      diagnosis: 'string (markdown)',
      history: 'string (markdown)',
      examination: 'string (markdown)',
      investigations: 'string (markdown)',
      medicine: 'string (markdown)',
      remarks: 'string (markdown)',
      vaccination: 'string (markdown)',
      plan_of_care: 'string (markdown)',
    },
  },
  neurology: {
    followup: {
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
    new_referral: {
      presenting_complaints: 'string (markdown)',
      history: 'string (markdown)',
      clinical_examination: 'string (markdown)',
      investigations: 'string (markdown)',
      diagnosis: 'string (markdown)',
      treatment_advice: 'string (markdown)',
      remarks: 'string (markdown)',
      plan_of_care: 'string (markdown)',
    },
  },
  orthopedics: {
    followup: {
      patient_details: 'string (markdown)',
      current_complaints: 'string (markdown)',
      clinical_findings: 'string (markdown)',
      investigations_reviewed: 'string (markdown)',
      current_plan: 'string (markdown)',
      next_review_date: 'string (markdown)',
    },
    new_referral: {
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
  },
  rheumatology: {
    followup: {
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
    new_referral: {
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
  },
  surgery: {
    followup: {
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
    new_referral: {
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
  },
  surgical_oncology: {
    followup: {
      patient_demographics: 'string (markdown)',
      procedure: 'string (markdown)',
      surgery_date: 'string (markdown)',
      complaints: 'string (markdown)',
      examination: 'string (markdown)',
      general_condition: 'string (markdown)',
      wound_or_drain: 'string (markdown)',
      medications: 'string (markdown)',
      histopathology_report: 'string (markdown)',
      plan: 'string (markdown)',
      mdt: 'string (markdown)',
      adjuvant_treatment_plan: 'string (markdown)',
      follow_up_plan: 'string (markdown)',
    },
    new_referral: {
      patient_demographics: 'string (markdown)',
      history: 'string (markdown)',
      comorbidities: 'string (markdown)',
      treatment_or_surgery_history: 'string (markdown)',
      family_history_of_cancer: 'string (markdown)',
      habits: 'string (markdown)',
      obstetric_history: 'string (markdown)',
      presenting_complaints: 'string (markdown)',
      investigations_done: 'string (markdown)',
      examination: 'string (markdown)',
      performance_status: 'string (markdown)',
      general_examination: 'string (markdown)',
      local_examination: 'string (markdown)',
      impression: 'string (markdown)',
      plan: 'string (markdown)',
      biopsy: 'string (markdown)',
      metastatic_workup: 'string (markdown)',
      neoadjuvant_treatment: 'string (markdown)',
      mdt_plan: 'string (markdown)',
      pac_workup: 'string (markdown)',
      mdt_date: 'string (markdown)',
      advice: 'string (markdown)',
      review_date: 'string (markdown)',
    },
  },
};
