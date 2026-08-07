/**
 * JSON Schemas passed to SMR `/api/v1/generate` as `response_format.json_schema`
 * to constrain the LLM's structured output.
 *
 * SMR forwards these verbatim to the provider, wrapping them as
 * `{ name: schema.title ?? 'output', schema: <this object>, strict }`
 * (see `apps/smr/src/smr/providers/azure_openai.py`). Each schema therefore
 * carries a `title` so the provider's schema name is stable.
 *
 * Shapes mirror the v1 `SimplifiedMedicalSummary` / `EnhancedMedicalSummary`
 * contracts (`SMR_Summary_Endpoints.md` §3.3, frozen in TASK-560 §5.4).
 *
 * STRICT-MODE COMPLIANCE (TASK-602 follow-up): Azure OpenAI (and OpenAI)
 * structured outputs in `strict` mode require, for EVERY object:
 *   1. `additionalProperties: false`, and
 *   2. every declared property listed in `required`.
 * Optionality is therefore expressed by making a field NULLABLE
 * (`type: ['string', 'null']`, or an enum whose list includes `null`) and
 * keeping it required — the model emits `null` when the field does not apply.
 * Arrays default to `[]`. Local engines (LM Studio/Ollama) accept the same
 * schema unchanged.
 */

/** `SimplifiedMedicalSummary` (`use_enhanced_format: false`). */
export const SIMPLIFIED_SUMMARY_SCHEMA: Record<string, unknown> = {
  title: 'SimplifiedMedicalSummary',
  type: 'object',
  properties: {
    chief_complaint: { type: 'string' },
    symptoms: { type: 'array', items: { type: 'string' } },
    medical_history: { type: ['string', 'null'] },
    examination: { type: ['string', 'null'] },
    assessment: { type: 'string' },
    treatment_plan: { type: ['string', 'null'] },
    follow_up: { type: ['string', 'null'] },
    summary: { type: 'string' },
  },
  required: ['chief_complaint', 'symptoms', 'medical_history', 'examination', 'assessment', 'treatment_plan', 'follow_up', 'summary'],
  additionalProperties: false,
};

const OLDCARTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    onset: { type: ['string', 'null'] },
    location: { type: ['string', 'null'] },
    duration: { type: ['string', 'null'] },
    characteristics: { type: ['string', 'null'] },
    aggravating_factors: { type: 'array', items: { type: 'string' } },
    relieving_factors: { type: 'array', items: { type: 'string' } },
    timing: { type: ['string', 'null'] },
    severity: { type: ['string', 'null'] },
    associated_symptoms: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'onset',
    'location',
    'duration',
    'characteristics',
    'aggravating_factors',
    'relieving_factors',
    'timing',
    'severity',
    'associated_symptoms',
  ],
  additionalProperties: false,
};

const REVIEW_OF_SYSTEMS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    constitutional: { type: ['string', 'null'] },
    cardiovascular: { type: ['string', 'null'] },
    respiratory: { type: ['string', 'null'] },
    gastrointestinal: { type: ['string', 'null'] },
    genitourinary: { type: ['string', 'null'] },
    musculoskeletal: { type: ['string', 'null'] },
    neurological: { type: ['string', 'null'] },
    psychiatric: { type: ['string', 'null'] },
  },
  required: [
    'constitutional',
    'cardiovascular',
    'respiratory',
    'gastrointestinal',
    'genitourinary',
    'musculoskeletal',
    'neurological',
    'psychiatric',
  ],
  additionalProperties: false,
};

/** `EnhancedMedicalSummary` (`use_enhanced_format: true`). */
export const ENHANCED_SUMMARY_SCHEMA: Record<string, unknown> = {
  title: 'EnhancedMedicalSummary',
  type: 'object',
  properties: {
    encounter_summary: {
      type: 'object',
      properties: {
        chief_complaint: { type: 'string' },
        history_of_present_illness: OLDCARTS_SCHEMA,
        review_of_systems: REVIEW_OF_SYSTEMS_SCHEMA,
      },
      required: ['chief_complaint', 'history_of_present_illness', 'review_of_systems'],
      additionalProperties: false,
    },
    clinical_findings: {
      type: 'object',
      properties: {
        vital_signs: {
          type: 'object',
          properties: {
            blood_pressure: { type: ['string', 'null'] },
            heart_rate: { type: ['string', 'null'] },
            respiratory_rate: { type: ['string', 'null'] },
            temperature: { type: ['string', 'null'] },
            oxygen_saturation: { type: ['string', 'null'] },
            pain_score: { type: ['string', 'null'] },
          },
          required: ['blood_pressure', 'heart_rate', 'respiratory_rate', 'temperature', 'oxygen_saturation', 'pain_score'],
          additionalProperties: false,
        },
        physical_examination: {
          type: 'object',
          properties: {
            general: { type: ['string', 'null'] },
            heent: { type: ['string', 'null'] },
            cardiovascular: { type: ['string', 'null'] },
            respiratory: { type: ['string', 'null'] },
            abdomen: { type: ['string', 'null'] },
            extremities: { type: ['string', 'null'] },
            neurological: { type: ['string', 'null'] },
            skin: { type: ['string', 'null'] },
          },
          required: ['general', 'heent', 'cardiovascular', 'respiratory', 'abdomen', 'extremities', 'neurological', 'skin'],
          additionalProperties: false,
        },
        diagnostic_results: {
          type: 'object',
          properties: {
            laboratory: { type: 'array', items: { type: 'string' } },
            imaging: { type: 'array', items: { type: 'string' } },
            other_tests: { type: 'array', items: { type: 'string' } },
          },
          required: ['laboratory', 'imaging', 'other_tests'],
          additionalProperties: false,
        },
      },
      required: ['vital_signs', 'physical_examination', 'diagnostic_results'],
      additionalProperties: false,
    },
    clinical_assessment: {
      type: 'object',
      properties: {
        primary_diagnosis: {
          type: 'object',
          properties: {
            diagnosis: { type: 'string' },
            icd10_code: { type: ['string', 'null'] },
            certainty: { type: ['string', 'null'], enum: ['Confirmed', 'Suspected', 'Rule out', null] },
          },
          required: ['diagnosis', 'icd10_code', 'certainty'],
          additionalProperties: false,
        },
        differential_diagnoses: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              diagnosis: { type: 'string' },
              likelihood: { type: 'string', enum: ['High', 'Medium', 'Low'] },
              reasoning: { type: ['string', 'null'] },
            },
            required: ['diagnosis', 'likelihood', 'reasoning'],
            additionalProperties: false,
          },
        },
        clinical_reasoning: { type: ['string', 'null'] },
        risk_stratification: { type: ['string', 'null'] },
      },
      required: ['primary_diagnosis', 'differential_diagnoses', 'clinical_reasoning', 'risk_stratification'],
      additionalProperties: false,
    },
    treatment_plan: {
      type: 'object',
      properties: {
        medications: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              dose: { type: ['string', 'null'] },
              route: { type: ['string', 'null'] },
              frequency: { type: ['string', 'null'] },
              duration: { type: ['string', 'null'] },
              indication: { type: ['string', 'null'] },
            },
            required: ['name', 'dose', 'route', 'frequency', 'duration', 'indication'],
            additionalProperties: false,
          },
        },
        procedures: { type: 'array', items: { type: 'string' } },
        lifestyle_modifications: { type: 'array', items: { type: 'string' } },
        patient_education: { type: 'array', items: { type: 'string' } },
        referrals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              specialty: { type: 'string' },
              reason: { type: 'string' },
              urgency: { type: ['string', 'null'], enum: ['Routine', 'Urgent', 'Emergent', null] },
            },
            required: ['specialty', 'reason', 'urgency'],
            additionalProperties: false,
          },
        },
      },
      required: ['medications', 'procedures', 'lifestyle_modifications', 'patient_education', 'referrals'],
      additionalProperties: false,
    },
    follow_up: {
      type: 'object',
      properties: {
        timeline: { type: ['string', 'null'] },
        provider: { type: ['string', 'null'] },
        conditions: { type: ['string', 'null'] },
        warning_signs: { type: 'array', items: { type: 'string' } },
      },
      required: ['timeline', 'provider', 'conditions', 'warning_signs'],
      additionalProperties: false,
    },
    clinical_summary: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        key_findings: { type: 'array', items: { type: 'string' } },
        pending_items: { type: 'array', items: { type: 'string' } },
        care_coordination: { type: ['string', 'null'] },
      },
      required: ['summary', 'key_findings', 'pending_items', 'care_coordination'],
      additionalProperties: false,
    },
    quality_metrics: {
      type: 'object',
      properties: {
        completeness_score: { type: 'number' },
        confidence_level: { type: ['string', 'null'], enum: ['High', 'Medium', 'Low', null] },
        missing_information: { type: 'array', items: { type: 'string' } },
        documentation_flags: { type: 'array', items: { type: 'string' } },
      },
      required: ['completeness_score', 'confidence_level', 'missing_information', 'documentation_flags'],
      additionalProperties: false,
    },
  },
  required: ['encounter_summary', 'clinical_findings', 'clinical_assessment', 'treatment_plan', 'follow_up', 'clinical_summary', 'quality_metrics'],
  additionalProperties: false,
};
