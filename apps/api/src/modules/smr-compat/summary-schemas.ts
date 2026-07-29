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
 */

/** `SimplifiedMedicalSummary` (`use_enhanced_format: false`). */
export const SIMPLIFIED_SUMMARY_SCHEMA: Record<string, unknown> = {
  title: 'SimplifiedMedicalSummary',
  type: 'object',
  properties: {
    chief_complaint: { type: 'string' },
    symptoms: { type: 'array', items: { type: 'string' } },
    medical_history: { type: 'string' },
    examination: { type: 'string' },
    assessment: { type: 'string' },
    treatment_plan: { type: 'string' },
    follow_up: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['chief_complaint', 'summary'],
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
        },
        diagnostic_results: {
          type: 'object',
          properties: {
            laboratory: { type: 'array', items: { type: 'string' } },
            imaging: { type: 'array', items: { type: 'string' } },
            other_tests: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    clinical_assessment: {
      type: 'object',
      properties: {
        primary_diagnosis: {
          type: 'object',
          properties: {
            diagnosis: { type: 'string' },
            icd10_code: { type: ['string', 'null'] },
            certainty: { type: 'string', enum: ['Confirmed', 'Suspected', 'Rule out'] },
          },
          required: ['diagnosis'],
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
            required: ['diagnosis', 'likelihood'],
          },
        },
        clinical_reasoning: { type: ['string', 'null'] },
        risk_stratification: { type: ['string', 'null'] },
      },
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
            required: ['name'],
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
              urgency: { type: 'string', enum: ['Routine', 'Urgent', 'Emergent'] },
            },
            required: ['specialty', 'reason'],
          },
        },
      },
    },
    follow_up: {
      type: 'object',
      properties: {
        timeline: { type: ['string', 'null'] },
        provider: { type: ['string', 'null'] },
        conditions: { type: ['string', 'null'] },
        warning_signs: { type: 'array', items: { type: 'string' } },
      },
    },
    clinical_summary: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        key_findings: { type: 'array', items: { type: 'string' } },
        pending_items: { type: 'array', items: { type: 'string' } },
        care_coordination: { type: ['string', 'null'] },
      },
      required: ['summary'],
    },
    quality_metrics: {
      type: 'object',
      properties: {
        completeness_score: { type: 'number' },
        confidence_level: { type: 'string', enum: ['High', 'Medium', 'Low'] },
        missing_information: { type: 'array', items: { type: 'string' } },
        documentation_flags: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  required: ['encounter_summary', 'clinical_assessment', 'clinical_summary'],
};
