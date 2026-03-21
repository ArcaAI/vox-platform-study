# JSON Enforcement Layer

> Source: `prompts_json.py`

The JSON Enforcement Layer wraps the base conversational prompts (from `prompts.py`) with strict constraints that force the LLM to return a single, schema-conformant JSON object. It provides department-specific schemas for 11 medical specialties (22 schemas total covering new-referral and follow-up visit types), a default SOAP fallback, and all the normalization logic needed to route free-form department names to the correct schema.

---

## Table of Contents

1. [Default SOAP Schema](#1-default-soap-schema)
2. [Department-Specific Schemas](#2-department-specific-schemas)
3. [JSON Enforcement Rules](#3-json-enforcement-rules)
4. [Department Name Normalization](#4-department-name-normalization)
5. [Visit-Type Normalization](#5-visit-type-normalization)
6. [API Reference](#6-api-reference)
7. [Usage Examples](#7-usage-examples)
8. [Output Response Format](#8-output-response-format)

---

## 1. Default SOAP Schema

`JSON_RESPONSE_SPEC` is the fallback schema used when no department-specific schema matches. It follows the standard SOAP note structure.

```python
JSON_RESPONSE_SPEC = {
    "subjective":  "string (markdown)",
    "objective":   "string (markdown)",
    "assessment":  "string (markdown)",
    "plan":        "string (markdown)",
}
```

| Field | Description |
|---|---|
| `subjective` | Patient-reported symptoms, history, and concerns |
| `objective` | Clinician observations, examination findings, vitals |
| `assessment` | Diagnoses, clinical reasoning, differential diagnoses |
| `plan` | Treatment plan, follow-up, referrals, prescriptions |

---

## 2. Department-Specific Schemas

`DEPT_VISIT_SCHEMAS` maps `(department, visit_type)` tuples to JSON schemas. There are **22 schemas** across **11 departments**, each with a new-referral and a follow-up variant. Every field value is `"string (markdown)"`.

### 2.1 Breast & Endocrine

#### New Referral — `("breast_endocrine", "new_referral")` — 14 fields

| # | Field Key |
|---|---|
| 1 | `patient_demographics` |
| 2 | `risk_factors_and_exposures` |
| 3 | `personal_and_reproductive_history` |
| 4 | `family_history` |
| 5 | `presenting_complaints` |
| 6 | `history_of_present_illness` |
| 7 | `past_medical_and_surgical_history` |
| 8 | `treatment_history` |
| 9 | `medications_and_allergies` |
| 10 | `physical_examination` |
| 11 | `investigations` |
| 12 | `diagnosis` |
| 13 | `plan_of_care` |
| 14 | `patient_education_and_consent` |

#### Follow-up — `("breast_endocrine", "followup")` — 12 fields

| # | Field Key |
|---|---|
| 1 | `patient_identifiers` |
| 2 | `interval_since_last_visit` |
| 3 | `review_of_previous_plan_and_adherence` |
| 4 | `presenting_complaints_and_updates` |
| 5 | `clinical_examination_updates` |
| 6 | `investigations_compared` |
| 7 | `treatment_history_and_response` |
| 8 | `new_findings_and_complications` |
| 9 | `plan_of_care_current` |
| 10 | `follow_up_and_monitoring_strategy` |
| 11 | `patient_education_and_consent` |
| 12 | `prepared_by_and_signatories` |

---

### 2.2 Medicine

#### New Referral — `("medicine", "new_referral")` — 10 fields

| # | Field Key |
|---|---|
| 1 | `presenting_complaints` |
| 2 | `past_history` |
| 3 | `family_history` |
| 4 | `drug_history` |
| 5 | `hospital_admissions` |
| 6 | `general_examination_and_vitals` |
| 7 | `previous_diagnosis` |
| 8 | `reports` |
| 9 | `current_diagnosis` |
| 10 | `plan_of_care` |

#### Follow-up — `("medicine", "followup")` — 10 fields

| # | Field Key |
|---|---|
| 1 | `last_visit_complaints` |
| 2 | `previous_diagnosis` |
| 3 | `current_medications` |
| 4 | `investigations_previous_vs_current` |
| 5 | `general_examination_and_vitals` |
| 6 | `current_diagnosis` |
| 7 | `treatment_plan` |
| 8 | `follow_up_plan` |
| 9 | `additional_data` |
| 10 | `doctors_instructions_and_orders` |

---

### 2.3 Hematology

#### New Referral — `("hematology", "new_referral")` — 7 fields

| # | Field Key |
|---|---|
| 1 | `presenting_complaints` |
| 2 | `history_of_presenting_illness` |
| 3 | `family_history` |
| 4 | `treatment_history` |
| 5 | `general_examination` |
| 6 | `diagnosis` |
| 7 | `plan_of_care` |

#### Follow-up — `("hematology", "followup")` — 14 fields

| # | Field Key |
|---|---|
| 1 | `patient_details` |
| 2 | `primary_diagnoses_and_comorbidities` |
| 3 | `presenting_complaints` |
| 4 | `treatment_history` |
| 5 | `history_of_presenting_illness` |
| 6 | `past_medical_and_surgical_history` |
| 7 | `family_history` |
| 8 | `investigations` |
| 9 | `clinical_summary_of_findings` |
| 10 | `discussion` |
| 11 | `treatment_options_considered` |
| 12 | `plan_of_care` |
| 13 | `follow_up_and_monitoring` |
| 14 | `prepared_by_and_signatories` |

---

### 2.4 Rheumatology

#### New Referral — `("rheumatology", "new_referral")` — 12 fields

| # | Field Key |
|---|---|
| 1 | `symptoms` |
| 2 | `current_issues` |
| 3 | `past_history` |
| 4 | `treatment_history` |
| 5 | `personal_history` |
| 6 | `family_history` |
| 7 | `general_examination` |
| 8 | `local_examination` |
| 9 | `impression` |
| 10 | `plan` |
| 11 | `patient_global_health` |
| 12 | `remarks` |

#### Follow-up — `("rheumatology", "followup")` — 10 fields

| # | Field Key |
|---|---|
| 1 | `diagnosis` |
| 2 | `disease_activity` |
| 3 | `current_issues` |
| 4 | `medication_review_rx` |
| 5 | `review_on` |
| 6 | `tests_to_do` |
| 7 | `advice` |
| 8 | `plan` |
| 9 | `consultation_notes` |
| 10 | `lab_reports` |

---

### 2.5 Neurology

#### New Referral — `("neurology", "new_referral")` — 8 fields

| # | Field Key |
|---|---|
| 1 | `presenting_complaints` |
| 2 | `history` |
| 3 | `clinical_examination` |
| 4 | `investigations` |
| 5 | `diagnosis` |
| 6 | `treatment_advice` |
| 7 | `remarks` |
| 8 | `plan_of_care` |

#### Follow-up — `("neurology", "followup")` — 14 fields

| # | Field Key |
|---|---|
| 1 | `diagnosis_and_visit_context` |
| 2 | `interval_since_last_visit` |
| 3 | `previous_recommendations` |
| 4 | `adherence_assessment` |
| 5 | `current_symptom_assessment` |
| 6 | `comparative_clinical_findings` |
| 7 | `medication_effectiveness_and_tolerance` |
| 8 | `new_patient_concerns` |
| 9 | `new_clinical_findings` |
| 10 | `laboratory_and_imaging_updates` |
| 11 | `comorbidity_control_status` |
| 12 | `vital_signs` |
| 13 | `additional_discussion_points` |
| 14 | `doctors_current_instructions` |

---

### 2.6 Surgery

#### New Referral — `("surgery", "new_referral")` — 14 fields

| # | Field Key |
|---|---|
| 1 | `patient_demographics` |
| 2 | `risk_factors_and_exposures` |
| 3 | `personal_and_reproductive_history` |
| 4 | `family_history` |
| 5 | `presenting_complaints` |
| 6 | `history_of_present_illness` |
| 7 | `past_medical_and_surgical_history` |
| 8 | `treatment_history` |
| 9 | `medications_and_allergies` |
| 10 | `physical_examination` |
| 11 | `investigations` |
| 12 | `diagnosis` |
| 13 | `plan_of_care` |
| 14 | `patient_education_and_consent` |

#### Follow-up — `("surgery", "followup")` — 12 fields

| # | Field Key |
|---|---|
| 1 | `patient_identifiers` |
| 2 | `interval_since_last_visit` |
| 3 | `review_of_previous_plan_and_adherence` |
| 4 | `presenting_complaints_and_updates` |
| 5 | `clinical_examination_updates` |
| 6 | `investigations_compared` |
| 7 | `treatment_history_and_response` |
| 8 | `new_findings_and_complications` |
| 9 | `plan_of_care_current` |
| 10 | `follow_up_and_monitoring_strategy` |
| 11 | `patient_education_and_consent` |
| 12 | `prepared_by_and_signatories` |

---

### 2.7 Orthopedics

#### New Referral — `("orthopedics", "new_referral")` — 10 fields

| # | Field Key |
|---|---|
| 1 | `patient_details` |
| 2 | `chief_complaints` |
| 3 | `history_of_illness` |
| 4 | `past_history` |
| 5 | `personal_history` |
| 6 | `examination` |
| 7 | `provisional_diagnosis` |
| 8 | `investigations_ordered` |
| 9 | `treatment_plan` |
| 10 | `review_date` |

#### Follow-up — `("orthopedics", "followup")` — 6 fields

| # | Field Key |
|---|---|
| 1 | `patient_details` |
| 2 | `current_complaints` |
| 3 | `clinical_findings` |
| 4 | `investigations_reviewed` |
| 5 | `current_plan` |
| 6 | `next_review_date` |

---

### 2.8 Dietetics

#### New Referral — `("dietetics", "new_referral")` — 7 fields

| # | Field Key |
|---|---|
| 1 | `patient_history` |
| 2 | `anthropometric_measurements` |
| 3 | `diet_history` |
| 4 | `nutrition_screening` |
| 5 | `nutritional_status` |
| 6 | `nutrition_diagnosis` |
| 7 | `plan_of_care` |

#### Follow-up — `("dietetics", "followup")` — 5 fields

| # | Field Key |
|---|---|
| 1 | `anthropometric_measurements` |
| 2 | `nutrition_screening` |
| 3 | `nutritional_status` |
| 4 | `plan_of_care` |
| 5 | `summary` |

---

### 2.9 Dermatology

#### New Referral — `("dermatology", "new_referral")` — 16 fields

| # | Field Key |
|---|---|
| 1 | `presenting_complaints` |
| 2 | `evolution_of_symptoms` |
| 3 | `aggravating_and_relieving_factors` |
| 4 | `past_history_of_similar_complaints` |
| 5 | `preceding_illnesses_or_new_exposures` |
| 6 | `history_of_atopy` |
| 7 | `treatment_history` |
| 8 | `occupation` |
| 9 | `personal_history` |
| 10 | `past_medical_history` |
| 11 | `family_history` |
| 12 | `clinical_examination` |
| 13 | `impression` |
| 14 | `investigations_ordered` |
| 15 | `treatment_plan` |
| 16 | `follow_up_advice` |

#### Follow-up — `("dermatology", "followup")` — 8 fields

| # | Field Key |
|---|---|
| 1 | `response_to_treatment` |
| 2 | `medication_adherence` |
| 3 | `new_symptoms_or_lesions` |
| 4 | `follow_up_investigations` |
| 5 | `clinical_examination` |
| 6 | `updated_diagnosis_or_assessment` |
| 7 | `updated_treatment_plan` |
| 8 | `next_follow_up_advice` |

---

### 2.10 Nephrology

#### New Referral — `("nephrology", "new_referral")` — 8 fields

| # | Field Key |
|---|---|
| 1 | `diagnosis` |
| 2 | `history` |
| 3 | `examination` |
| 4 | `investigations` |
| 5 | `medicine` |
| 6 | `remarks` |
| 7 | `vaccination` |
| 8 | `plan_of_care` |

#### Follow-up — `("nephrology", "followup")` — 8 fields

| # | Field Key |
|---|---|
| 1 | `date_of_review` |
| 2 | `symptom_review` |
| 3 | `medication_review` |
| 4 | `examination` |
| 5 | `investigations_reviewed` |
| 6 | `current_diagnosis` |
| 7 | `updated_plan_of_care` |
| 8 | `investigations_to_be_done_on_review` |

---

### 2.11 Surgical Oncology

#### New Referral — `("surgical_oncology", "new_referral")` — 22 fields

| # | Field Key |
|---|---|
| 1 | `patient_demographics` |
| 2 | `history` |
| 3 | `comorbidities` |
| 4 | `treatment_or_surgery_history` |
| 5 | `family_history_of_cancer` |
| 6 | `habits` |
| 7 | `obstetric_history` |
| 8 | `presenting_complaints` |
| 9 | `investigations_done` |
| 10 | `examination` |
| 11 | `performance_status` |
| 12 | `general_examination` |
| 13 | `local_examination` |
| 14 | `impression` |
| 15 | `plan` |
| 16 | `biopsy` |
| 17 | `metastatic_workup` |
| 18 | `neoadjuvant_treatment` |
| 19 | `mdt_plan` |
| 20 | `pac_workup` |
| 21 | `mdt_date` |
| 22 | `advice` |
| 23 | `review_date` |

#### Follow-up — `("surgical_oncology", "followup")` — 13 fields

| # | Field Key |
|---|---|
| 1 | `patient_demographics` |
| 2 | `procedure` |
| 3 | `surgery_date` |
| 4 | `complaints` |
| 5 | `examination` |
| 6 | `general_condition` |
| 7 | `wound_or_drain` |
| 8 | `medications` |
| 9 | `histopathology_report` |
| 10 | `plan` |
| 11 | `mdt` |
| 12 | `adjuvant_treatment_plan` |
| 13 | `follow_up_plan` |

---

### Schema Field Count Summary

| Department | New Referral | Follow-up |
|---|:---:|:---:|
| Breast & Endocrine | 14 | 12 |
| Medicine | 10 | 10 |
| Hematology | 7 | 14 |
| Rheumatology | 12 | 10 |
| Neurology | 8 | 14 |
| Surgery | 14 | 12 |
| Orthopedics | 10 | 6 |
| Dietetics | 7 | 5 |
| Dermatology | 16 | 8 |
| Nephrology | 8 | 8 |
| Surgical Oncology | 22 | 13 |

---

## 3. JSON Enforcement Rules

The `JSON_ENFORCEMENT_NOTE` constant is appended to system prompts. It contains the following constraints verbatim:

```
CRITICAL OUTPUT CONSTRAINTS:
- Return ONLY a single JSON object. No preface, no explanation, no trailing text.
- Follow the schema defined by the active prompt/template (department/visit-specific where applicable).
- Do NOT invent fields that are not specified by the prompt/template schema.
- ALL field values MUST be strings (markdown formatted text). Do NOT return nested objects or arrays as field values.
- All text content (including section headings/labels inside values) MUST be in the conversation language and formatted using markdown.
- Do NOT use placeholders like 'Not documented' / 'Summary not available' (or their equivalents in the conversation language) for the 'summary' field. Always provide a concise, best‑effort summary from available information.
- If truly no data exists for a non-summary field, write a succinct statement in the conversation language (avoid literal 'Not documented').
- Ensure valid JSON (double-quoted keys/strings, no trailing commas).
```

### Additional Rules Injected by `build_template_by_department`

When a department schema is resolved, the user prompt also receives these formatting directives:

- Return ONLY valid JSON. No code fences or extra text.
- Use the conversation language for all values. Keep JSON keys in English.
- **Monolingual policy**: all headings/labels and descriptive content inside values must be in the conversation language.
- **Markdown formatting required**:
  - Numbered lists (`1. 2. 3.`) for sequential items
  - Bullet points (`-` or `*`) for non-sequential lists
  - `**bold**` for emphasis on key terms
  - `##` for section headers within content
  - Proper line breaks between list items and sections
- If information is missing from the conversation, consult PRIOR MEDICAL CONTEXT to populate fields.
- Never use placeholders for the `summary` field.
- For other fields, if neither the conversation nor PRIOR MEDICAL CONTEXT provides information, write a brief sentence indicating absence in the conversation language.
- Conform EXACTLY to the provided JSON schema.

---

## 4. Department Name Normalization

The `get_department_schema` function normalizes free-form department names to canonical keys before looking up `DEPT_VISIT_SCHEMAS`. Matching is case-insensitive.

| Input Synonyms | Canonical Key |
|---|---|
| `general medicine`, `internal medicine` | `medicine` |
| `breast & endocrine`, `breast and endocrine`, `breast&endocrine` | `breast_endocrine` |
| `orthopedics`, `orthopaedics`, `ortho` | `orthopedics` |
| `surgery`, `general surgery` | `surgery` |
| `rheumatology`, `rheum` | `rheumatology` |
| `neurology`, `neuro` | `neurology` |
| `hematology`, `haematology`, `heme` | `hematology` |
| `dietetics`, `dietitian`, `nutrition`, `clinical nutrition` | `dietetics` |
| `dermatology`, `derm` | `dermatology` |
| `nephrology`, `nephro` | `nephrology` |
| `surgical oncology`, `surgical_oncology`, `surg oncology`, `oncosurgery`, `oncology surgery` | `surgical_oncology` |

If no synonym matches, the raw (lowercased, stripped) department name is used as-is for the schema lookup. If no schema is found, the default SOAP schema (`JSON_RESPONSE_SPEC`) is returned.

---

## 5. Visit-Type Normalization

The internal `_normalize_visit_type` function classifies free-form visit-type strings into one of two canonical values.

| Canonical Value | Trigger Terms |
|---|---|
| `new_referral` | `new`, `first`, `initial`, `exam`, `examination`, `referral`, `referal`, `refferal`, `refer`, `referr`, `refd`, `consult`, `consultation` |
| `followup` | `follow`, `follow up`, `followup`, `follow-up`, `fu`, `review`, `revisit`, `rv` |

Hyphens and underscores in the input are replaced with spaces before matching. If no term matches, the default is `new_referral`.

---

## 6. API Reference

### Module-Level Functions

#### `get_department_schema(department, visit_type)`

```python
def get_department_schema(
    department: Optional[str],
    visit_type: Optional[str],
) -> Dict[str, Any]
```

Returns the JSON schema dictionary for a given department and visit type. Applies synonym normalization to both inputs. Falls back to `JSON_RESPONSE_SPEC` (SOAP) if no match is found.

**Parameters**

| Parameter | Type | Description |
|---|---|---|
| `department` | `Optional[str]` | Department name (free-form; normalized internally) |
| `visit_type` | `Optional[str]` | Visit type (free-form; normalized to `new_referral` or `followup`) |

**Returns**: `Dict[str, Any]` — a schema dictionary where keys are field names and values are `"string (markdown)"`.

---

#### `build_json_enforced_system_prompt(specialty, encounter_type)`

```python
def build_json_enforced_system_prompt(
    specialty: Optional[MedicalSpecialty] = None,
    encounter_type: Optional[EncounterType] = None,
) -> str
```

Builds a system prompt by combining the base prompt from `ConversationalPrompts.build_system_prompt` with `JSON_ENFORCEMENT_NOTE`.

**Parameters**

| Parameter | Type | Description |
|---|---|---|
| `specialty` | `Optional[MedicalSpecialty]` | Medical specialty enum for base prompt specialization |
| `encounter_type` | `Optional[EncounterType]` | Encounter type enum for base prompt specialization |

**Returns**: `str` — the complete system prompt string.

---

#### `build_json_enforced_user_prompt(...)`

```python
def build_json_enforced_user_prompt(
    *,
    session_id: str,
    patient_info: str,
    conversation_text: str,
    conversation_language: str = "English",
    session_date: str = "Not specified",
    encounter_type: Optional[EncounterType] = None,
    specialty: Optional[MedicalSpecialty] = None,
) -> str
```

Builds a user prompt by wrapping `ConversationalPrompts.build_user_prompt` and appending strict JSON formatting constraints with an illustrative empty JSON example.

**Parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `session_id` | `str` | — | Unique session identifier |
| `patient_info` | `str` | — | Patient demographic/context string |
| `conversation_text` | `str` | — | The doctor-patient conversation transcript |
| `conversation_language` | `str` | `"English"` | Language for all output values |
| `session_date` | `str` | `"Not specified"` | Date of the clinical session |
| `encounter_type` | `Optional[EncounterType]` | `None` | Encounter type enum |
| `specialty` | `Optional[MedicalSpecialty]` | `None` | Medical specialty enum |

**Returns**: `str` — the complete user prompt string.

---

### `JsonPromptFactory` Class

A static factory that produces ready-to-use `{"system": ..., "user": ...}` prompt dictionaries.

#### `build_template(...)`

```python
@staticmethod
def build_template(
    *,
    specialty: Optional[MedicalSpecialty],
    encounter_type: Optional[EncounterType],
    session_id: str,
    patient_info: str,
    conversation_text: str,
    conversation_language: str = "English",
    session_date: str = "Not specified",
) -> Dict[str, str]
```

Builds a prompt pair using the generic specialty/encounter-type pathway. Uses `build_json_enforced_system_prompt` and `build_json_enforced_user_prompt` internally.

**Parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `specialty` | `Optional[MedicalSpecialty]` | — | Specialty enum |
| `encounter_type` | `Optional[EncounterType]` | — | Encounter type enum |
| `session_id` | `str` | — | Session identifier |
| `patient_info` | `str` | — | Patient context |
| `conversation_text` | `str` | — | Conversation transcript |
| `conversation_language` | `str` | `"English"` | Output language |
| `session_date` | `str` | `"Not specified"` | Session date |

**Returns**: `Dict[str, str]` with keys `"system"` and `"user"`.

---

#### `build_template_by_department(...)`

```python
@staticmethod
def build_template_by_department(
    *,
    department: Optional[str],
    visit_type: Optional[str],
    session_id: str,
    patient_info: str,
    conversation_text: str,
    conversation_language: str = "English",
    session_date: str = "Not specified",
    pre_summary_text: Optional[str] = None,
) -> Dict[str, str]
```

The primary method for department-specific prompt generation. Performs the following steps:

1. Builds the base system prompt via `ConversationalPrompts.build_system_prompt()` (no specialty/encounter args).
2. Resolves the department-specific JSON schema via `get_department_schema(department, visit_type)`.
3. Serializes the schema as a JSON example string using `json.dumps(schema, indent=2)`.
4. Builds the base user prompt via `ConversationalPrompts.build_user_prompt(...)`.
5. If `pre_summary_text` is provided, injects it as a `PRIOR MEDICAL CONTEXT` block (labeled as authoritative for filling missing details).
6. Appends strict JSON response rules including the serialized schema, markdown formatting directives, and monolingual policy.

**Parameters**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `department` | `Optional[str]` | — | Department name (free-form) |
| `visit_type` | `Optional[str]` | — | Visit type (free-form) |
| `session_id` | `str` | — | Session identifier |
| `patient_info` | `str` | — | Patient context |
| `conversation_text` | `str` | — | Conversation transcript |
| `conversation_language` | `str` | `"English"` | Output language |
| `session_date` | `str` | `"Not specified"` | Session date |
| `pre_summary_text` | `Optional[str]` | `None` | Prior summary to inject as authoritative context |

**Returns**: `Dict[str, str]` with keys `"system"` and `"user"`.

---

## 7. Usage Examples

### Generic Specialty Prompt

```python
from prompts_json import JsonPromptFactory, MedicalSpecialty, EncounterType

prompts = JsonPromptFactory.build_template(
    specialty=MedicalSpecialty.GENERAL,
    encounter_type=EncounterType.FOLLOW_UP,
    session_id="sess-001",
    patient_info="Male, 45 years, Hypertension",
    conversation_text="Doctor: How are you feeling?\nPatient: ...",
    conversation_language="English",
    session_date="2025-06-15",
)

system_prompt = prompts["system"]
user_prompt = prompts["user"]
```

### Department-Specific Prompt

```python
from prompts_json import JsonPromptFactory

prompts = JsonPromptFactory.build_template_by_department(
    department="Breast & Endocrine",
    visit_type="New Referral",
    session_id="sess-002",
    patient_info="Female, 52 years",
    conversation_text="Doctor: What brings you in today?\nPatient: ...",
    conversation_language="Hindi",
    session_date="2025-06-15",
)
```

### With Prior Summary Context

```python
from prompts_json import JsonPromptFactory

prompts = JsonPromptFactory.build_template_by_department(
    department="Hematology",
    visit_type="Follow-up",
    session_id="sess-003",
    patient_info="Male, 30 years, CML",
    conversation_text="Doctor: ...\nPatient: ...",
    conversation_language="English",
    session_date="2025-06-15",
    pre_summary_text="Previous visit: Diagnosed with CML. Started on Imatinib 400mg.",
)
```

The `pre_summary_text` is injected into the user prompt as:

```
PRIOR MEDICAL CONTEXT (authoritative, use to fill missing details):
Previous visit: Diagnosed with CML. Started on Imatinib 400mg.
```

### Direct Schema Lookup

```python
from prompts_json import get_department_schema

schema = get_department_schema("orthopaedics", "follow up")
# Returns the ("orthopedics", "followup") schema after normalization

schema = get_department_schema("unknown_dept", "new")
# Returns JSON_RESPONSE_SPEC (SOAP fallback)
```

---

## 8. Output Response Format

The LLM is expected to return a raw JSON object (no code fences, no surrounding text) conforming to the resolved schema. Every value is a markdown-formatted string in the conversation language. JSON keys remain in English.

### Example: Medicine New Referral (English)

```json
{
  "presenting_complaints": "- **Persistent cough** for 3 weeks\n- Low-grade fever",
  "past_history": "- Known **Type 2 Diabetes Mellitus** since 2018\n- No prior surgeries",
  "family_history": "- Father: Hypertension\n- Mother: No significant history",
  "drug_history": "1. Metformin 500mg BD\n2. Atorvastatin 10mg HS",
  "hospital_admissions": "No prior hospital admissions reported.",
  "general_examination_and_vitals": "- **BP**: 130/80 mmHg\n- **HR**: 78 bpm\n- **SpO2**: 97%",
  "previous_diagnosis": "Type 2 Diabetes Mellitus",
  "reports": "- HbA1c: 7.2% (3 months ago)\n- Chest X-ray: pending",
  "current_diagnosis": "## Working Diagnosis\n- Acute bronchitis\n- Type 2 DM (controlled)",
  "plan_of_care": "1. Chest X-ray PA view\n2. CBC, ESR, CRP\n3. Azithromycin 500mg OD x 5 days\n4. Follow-up in 1 week"
}
```

### Example: SOAP Fallback (Default)

```json
{
  "subjective": "Patient reports persistent headache for 5 days...",
  "objective": "**Vitals**: BP 120/80, HR 72...",
  "assessment": "Tension-type headache, rule out migraine...",
  "plan": "1. Paracetamol 500mg SOS\n2. MRI brain if no improvement in 1 week..."
}
```

### Validation Checklist

| Constraint | Requirement |
|---|---|
| Wrapper | Raw JSON only — no code fences, no prose before/after |
| Keys | English, double-quoted, matching the schema exactly |
| Values | Strings only — no nested objects, no arrays |
| Content language | Conversation language (monolingual within each value) |
| Formatting | Markdown syntax inside string values |
| Missing data | Brief statement in conversation language (never literal "Not documented") |
| `summary` field | Always a best-effort concise summary (never a placeholder) |
| JSON validity | Double-quoted keys/strings, no trailing commas |
