# Prompt System — Implementation Guide

Developer-facing guide for using and extending the prompt template system. Covers the full prompt assembly pipeline, context injection, per-request overrides, the two-stage summarization flow, output format specification, and how to add new department templates.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [How the Final Prompt is Assembled](#how-the-final-prompt-is-assembled)
- [Context Variables Injected into Prompts](#context-variables-injected-into-prompts)
- [Per-Request Prompt Overrides](#per-request-prompt-overrides)
- [Two-Stage Pipeline](#two-stage-pipeline)
- [Output Format Specification](#output-format-specification)
- [Adding a New Department Template](#adding-a-new-department-template)
- [Important Notices](#important-notices)

---

## Architecture Overview

The prompt system is organized into three layers, each adding specificity on top of the previous one.

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 3: JSON Enforcement (prompts_json.py)                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  - Schema validation per department/visit-type            │  │
│  │  - Strict JSON-only output constraints                    │  │
│  │  - Markdown formatting rules                              │  │
│  │  - Monolingual policy enforcement                         │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Layer 2: Department Templates (prompts_*.py)                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  - 22 department/visit-type specific modules              │  │
│  │  - Hardcoded clinical note structures                     │  │
│  │  - Section headings, ordering, and content guidance       │  │
│  │  - Each exposes get_prompt_template() → PromptTemplate    │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Layer 1: Core Prompts (prompts.py)                             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  - SYSTEM_PROMPT_BASE: persona, safety, language rules    │  │
│  │  - USER_PROMPT_TEMPLATE: session info + SOAP structure    │  │
│  │  - SIMPLE_PROMPT_TEMPLATE: lightweight alternative        │  │
│  │  - SPECIALTY_PROMPTS: emergency, pediatrics, etc.         │  │
│  │  - ConversationalPrompts builder class                    │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Layer 1: Core Prompts (`prompts.py`)

The foundation. Defines the LLM's persona, safety constraints, language rules, and the base SOAP-format user prompt template. The `ConversationalPrompts` class provides builder methods that compose system and user prompts from these templates.

Key components:
- `SYSTEM_PROMPT_BASE` — establishes the medical AI assistant role, clinical extraction responsibilities, language requirements, and JSON formatting rules.
- `USER_PROMPT_TEMPLATE` — the detailed user prompt with placeholders for session info, patient info, conversation transcript, and SOAP output structure.
- `SIMPLE_PROMPT_TEMPLATE` — a lighter-weight alternative for basic use cases.
- `SPECIALTY_PROMPTS` — optional enhancements for emergency, pediatrics, cardiology, and psychiatry.

### Layer 2: Department Templates (`prompts_*.py`)

22 modules, one per department/visit-type combination. Each module contains:
- `NOTE` — instructions for the LLM on how to structure the clinical note.
- `CONTENT` — the actual section headings and content guidance.
- `TEMPLATE` — the combined template string.
- `get_prompt_template()` — returns a `PromptTemplate` dataclass.

These templates define the exact sections that appear in the output JSON (e.g., `presenting_complaints`, `history_of_present_illness`, `plan_of_care`).

### Layer 3: JSON Enforcement (`prompts_json.py`)

The final layer that wraps everything in strict JSON output constraints. Provides:
- `DEPT_VISIT_SCHEMAS` — a mapping of `(department, visit_type)` tuples to JSON schema dicts defining the exact fields for each combination (24 entries including catch-all).
- `JSON_ENFORCEMENT_NOTE` — critical output constraints appended to the system prompt.
- `JsonPromptFactory` — factory class that assembles the final `{"system": ..., "user": ...}` dict.

---

## How the Final Prompt is Assembled

This is the step-by-step process from incoming request to LLM-ready prompt payload.

```
  Request arrives
       │
       ▼
  ┌─────────────────────────────────────────┐
  │ 1. Extract department + visit_type      │
  │    from request fields or nested payload│
  └──────────────┬──────────────────────────┘
                 │
                 ▼
  ┌─────────────────────────────────────────┐
  │ 2. select_prompt_template(dept, visit)  │
  │    → PromptTemplate or None             │
  └──────────────┬──────────────────────────┘
                 │
        ┌────────┴────────┐
        │                 │
   Found (dept template)  Not found
        │                 │
        ▼                 ▼
  ┌──────────────┐  ┌──────────────────┐
  │ Dept template│  │ Catch-all SOAP   │
  │ content used │  │ template used    │
  └──────┬───────┘  └────────┬─────────┘
         │                   │
         └─────────┬─────────┘
                   │
                   ▼
  ┌─────────────────────────────────────────┐
  │ 3. JsonPromptFactory                    │
  │    .build_template_by_department()      │
  │                                         │
  │  a. system = ConversationalPrompts      │
  │       .build_system_prompt()            │
  │                                         │
  │  b. user = base user prompt             │
  │       (session info, patient info,      │
  │        conversation text)               │
  │                                         │
  │  c. IF pre_summary_text provided:       │
  │     append "PRIOR MEDICAL CONTEXT       │
  │     (authoritative, use to fill         │
  │     missing details)"                   │
  │                                         │
  │  d. Append JSON enforcement rules       │
  │     with dept-specific schema           │
  └──────────────┬──────────────────────────┘
                 │
                 ▼
  ┌─────────────────────────────────────────┐
  │ 4. Result:                              │
  │    {"system": "...", "user": "..."}     │
  │    Ready for LLM API call               │
  └─────────────────────────────────────────┘
```

### Detailed walkthrough

**Step 1 — Extract department and visit type**

The department and visit type can come from explicit request fields (`BaseSummaryRequest.department`, `.visit_type`) or be extracted from nested payloads via `resolve_department_context()` or `extract_department_and_visit_type()`.

**Step 2 — Resolve the department template**

`prompt_selector.select_prompt_template()` normalizes both inputs and matches against the known department synonym sets. Returns a `PromptTemplate` or `None`.

**Step 3 — Build the final prompt via `JsonPromptFactory.build_template_by_department()`**

This is where all layers converge:

```python
from prompts_json import JsonPromptFactory

result = JsonPromptFactory.build_template_by_department(
    department="Surgery",
    visit_type="New Referral",
    session_id="session-abc-123",
    patient_info="Patient: John Doe, 45M",
    conversation_text="Doctor: What brings you in today?\nPatient: ...",
    conversation_language="English",
    session_date="2025-06-15",
    pre_summary_text="Previous diagnosis: Type 2 DM. On Metformin 500mg BD.",
)

# result = {"system": "...", "user": "..."}
```

The method performs these operations internally:

**(a) System prompt construction:**

```python
system = ConversationalPrompts.build_system_prompt()
# Returns SYSTEM_PROMPT_BASE (+ optional specialty enhancements)
```

**(b) Base user prompt construction:**

```python
base_user = ConversationalPrompts.build_user_prompt(
    session_id=session_id,
    patient_info=patient_info,
    conversation_text=conversation_text,
    session_date=session_date,
    encounter_type=None,
    specialty=None,
    use_simple_format=False,
    conversation_language=conversation_language,
)
```

**(c) Prior context injection** (conditional):

```python
if pre_summary_text:
    prior_context = (
        "\n\nPRIOR MEDICAL CONTEXT (authoritative, use to fill missing details):\n"
        + pre_summary_text.strip()
    )
```

**(d) JSON enforcement rules with department-specific schema:**

```python
schema = get_department_schema(department, visit_type)
# Returns the DEPT_VISIT_SCHEMAS entry or falls back to JSON_RESPONSE_SPEC

json_rules = (
    "\n\nSTRICT JSON RESPONSE FORMAT (CRITICAL):\n"
    "- Return ONLY valid JSON. No code fences or extra text.\n"
    f"- Use the {conversation_language} for all values. Keep JSON keys in English.\n"
    "- MARKDOWN FORMATTING REQUIRED: ...\n"
    f"- Conform EXACTLY to this JSON schema:\n{schema_example}\n"
)

user = base_user + prior_context + "\n\n" + json_rules
```

**Step 4 — Result**

The returned dict `{"system": "...", "user": "..."}` is passed directly to the LLM API.

---

## Context Variables Injected into Prompts

The following context is combined with templates at prompt assembly time. Some variables are always present; others are conditionally injected.

### Always present (from `build_user_prompt`)

| Variable | Source | Description |
|---|---|---|
| `session_id` | `SessionData.session_id` | Unique session identifier |
| `session_date` | Derived from `SessionData.created_at` | Date of the encounter |
| `patient_info` | `SessionData.patient_info` (formatted) | Patient demographics and basic info |
| `conversation_text` | `SessionData.conversation_segments` (joined) | The doctor-patient conversation transcript |
| `conversation_language` | Request or session metadata | Language of the conversation (default: `"English"`) |
| `encounter_type` | `BaseSummaryRequest.encounter_type` | Type of encounter (initial, follow-up, emergency, etc.) |
| `specialty` | `BaseSummaryRequest.specialty` | Medical specialty for specialty-specific enhancements |

### Conditionally injected

| Variable | Condition | Description |
|---|---|---|
| `pre_summary_text` | `include_pre_summary_in_context=True` and value provided | Pre-generated summary from previous visits. Injected as `"PRIOR MEDICAL CONTEXT (authoritative, use to fill missing details)"` |
| `PREVIOUS CASE NOTES SUMMARY` | Referenced by department templates | Synthesized pre-summary of up to 8 filtered case notes from the past 12 months |
| `Recent Vitals` | Referenced by department templates | Vital signs from the two most recent encounters |
| `same_day_prequel_summary` | Referenced by department templates | Summary from an earlier same-day visit (for continuation visits) |
| `style_DNA_doctor_department_*` | Referenced by department templates | Doctor's writing style preferences from the DNA system |

### How conditional context flows in

```python
# Pre-summary injection in JsonPromptFactory.build_template_by_department()
if pre_summary_text:
    prior_context = (
        "\n\nPRIOR MEDICAL CONTEXT (authoritative, use to fill missing details):\n"
        + pre_summary_text.strip()
    )
    user_prompt = base_user + prior_context + json_rules
```

The department templates themselves reference `PREVIOUS CASE NOTES SUMMARY`, `Recent Vitals`, and `same_day_prequel_summary` as named sections that the caller is expected to populate in the conversation text or patient info before passing to the prompt builder.

---

## Per-Request Prompt Overrides

The `BaseSummaryRequest` model (in `requests.py`) exposes several fields that allow callers to override default prompt behavior on a per-request basis.

| Field | Type | Default | Description |
|---|---|---|---|
| `system_prompt` | `Optional[str]` | `None` | Replaces the entire system prompt. Bypasses `ConversationalPrompts.build_system_prompt()`. |
| `user_prompt_template` | `Optional[str]` | `None` | Replaces the entire user prompt template. Bypasses `ConversationalPrompts.build_user_prompt()`. |
| `department` | `Optional[str]` | `None` | Explicit department for department-specific prompt selection. |
| `visit_type` | `Optional[str]` | `None` | Explicit visit type for visit-type-specific prompt selection. |
| `specialty` | `Optional[str]` | `None` | Medical specialty for specialty-specific system prompt enhancements (e.g., `"emergency"`, `"pediatrics"`). |
| `encounter_type` | `Optional[str]` | `None` | Encounter type for context-specific prompts (e.g., `"initial_consultation"`, `"follow_up"`). |
| `use_enhanced_format` | `bool` | `False` | Toggle between simplified (`SIMPLE_PROMPT_TEMPLATE`) and enhanced (`USER_PROMPT_TEMPLATE`) formats. |
| `include_pre_summary_in_context` | `bool` | `False` | When `True`, includes `pre_summary_text` from session data as prior medical context. |
| `temperature` | `Optional[float]` | `None` | Override LLM temperature (0.0–2.0). |
| `max_tokens` | `Optional[int]` | `None` | Override max tokens (1–32000). |

### Override priority

```
Per-request system_prompt override
  └─ takes precedence over ─►  ConversationalPrompts.build_system_prompt()

Per-request user_prompt_template override
  └─ takes precedence over ─►  Department template + JSON enforcement

Per-request department/visit_type
  └─ takes precedence over ─►  Values extracted from session_metadata
```

### Example: full prompt override

```python
from requests import SyncSummaryRequest

request = SyncSummaryRequest(
    session_data=session_data,
    system_prompt="You are a dermatology specialist. Respond in JSON.",
    user_prompt_template="Analyze: {conversation_text}\nRespond as JSON.",
)
# Both system and user prompts are fully replaced
```

### Example: department-specific with pre-summary

```python
request = SyncSummaryRequest(
    session_data=session_data,
    department="Rheumatology",
    visit_type="Follow-up",
    include_pre_summary_in_context=True,
)
# Uses rheumatology follow-up template + injects pre_summary_text as prior context
```

---

## Two-Stage Pipeline

The summarization system supports a two-stage pipeline for richer clinical context.

```
┌─────────────────────────────────────────────────────────┐
│  Stage 1: Pre-Summary                                   │
│                                                         │
│  Input:  PreSummaryRequest                              │
│          - previous visits (up to 8, past 12 months)    │
│          - vitals, test results                         │
│          - department, visit_type, patient demographics  │
│                                                         │
│  Output: pre_summary_text                               │
│          (structured summary of historical context)     │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  Stage 2: Final Summary                                 │
│                                                         │
│  Input:  BaseSummaryRequest                             │
│          - conversation transcript                      │
│          - pre_summary_text (from Stage 1)              │
│          - department, visit_type                        │
│                                                         │
│  Output: Structured clinical note (JSON)                │
│          with department-specific sections               │
└─────────────────────────────────────────────────────────┘
```

### Stage 1: Pre-Summary Generation

Uses `PreSummaryRequest` to generate a `pre_summary_text` from historical patient data.

```python
from requests import PreSummaryRequest

pre_summary_request = PreSummaryRequest(
    current_department="Surgery",
    visit_type="New Referral",
    age="45",
    gender="Male",
    formatted_vitals="BP: 130/85, HR: 78, Temp: 37.0°C",
    formatted_test_results="HbA1c: 7.2%, FBS: 145 mg/dL",
    formatted_previous_visits="2025-01-10: Routine checkup - Type 2 DM stable...",
    language="en",
    temperature=0.2,
    max_tokens=800,
)
# → Returns pre_summary_text
```

### Stage 2: Final Summary

The main summarization request uses the pre-summary as authoritative prior context.

```python
from requests import SyncSummaryRequest

request = SyncSummaryRequest(
    session_data=session_data,  # includes pre_summary_text
    department="Surgery",
    visit_type="New Referral",
    include_pre_summary_in_context=True,
)
# pre_summary_text is injected as "PRIOR MEDICAL CONTEXT" in the user prompt
```

The pre-summary is treated as **authoritative** — the LLM uses it to fill in missing details from the current conversation without contradicting what was explicitly discussed.

---

## Output Format Specification

All LLM responses conform to these rules, enforced by Layer 3 (`prompts_json.py`).

### Structure

- Every response is a **single JSON object**. No preface, no explanation, no trailing text.
- All field values are **strings containing markdown-formatted text**.
- No nested objects or arrays as field values.

### Language

- **JSON keys** are always in English (e.g., `"presenting_complaints"`, `"plan_of_care"`).
- **Content values** are in the conversation language (e.g., English, Malayalam, Hindi).
- All headings, labels, and descriptive content inside values follow the monolingual policy — they must be in the conversation language.

### Markdown formatting

Content within JSON string values uses markdown syntax:

| Element | Syntax | Usage |
|---|---|---|
| Section headers | `## Header` | Major sections within a field |
| Bold | `**text**` | Key terms, emphasis |
| Bullet lists | `- item` or `* item` | Non-sequential items |
| Numbered lists | `1. item` | Sequential items, steps |
| Line breaks | Newlines between sections | Separation |

### Missing information handling

- For the `summary` field: always provide a concise, best-effort summary. Never use placeholders.
- For other fields: write a brief statement in the conversation language indicating absence (e.g., "No relevant history was discussed during this consultation"). Avoid literal `"Not documented"`.

### Schema per department

Each `(department, visit_type)` pair has a specific set of JSON keys defined in `DEPT_VISIT_SCHEMAS`. Example for Surgery New Referral:

```json
{
  "patient_demographics": "string (markdown)",
  "risk_factors_and_exposures": "string (markdown)",
  "personal_and_reproductive_history": "string (markdown)",
  "family_history": "string (markdown)",
  "presenting_complaints": "string (markdown)",
  "history_of_present_illness": "string (markdown)",
  "past_medical_and_surgical_history": "string (markdown)",
  "treatment_history": "string (markdown)",
  "medications_and_allergies": "string (markdown)",
  "physical_examination": "string (markdown)",
  "investigations": "string (markdown)",
  "diagnosis": "string (markdown)",
  "plan_of_care": "string (markdown)",
  "patient_education_and_consent": "string (markdown)"
}
```

When no department-specific schema exists, the general SOAP schema is used:

```json
{
  "subjective": "string (markdown)",
  "objective": "string (markdown)",
  "assessment": "string (markdown)",
  "plan": "string (markdown)"
}
```

---

## Adding a New Department Template

Follow these four steps to add support for a new department.

### Step 1: Create the template module

Create a file named `prompts_<department>_<visit_type>.py` in the project root. Follow the established pattern:

```python
"""Prompt template for <Department> — <Visit Type>."""
from __future__ import annotations
from .prompts import PromptTemplate

NOTE = """
Instructions for the LLM on how to structure this department's clinical note.
Include SAIL guidelines compliance, third-person past-tense writing style,
and any department-specific instructions.
"""

CONTENT = """
## Section Heading 1
Guidance on what to include in this section.

## Section Heading 2
Guidance on what to include in this section.

## Plan of Care
Treatment plan, investigations, referrals, follow-up.
"""

TEMPLATE = NOTE + "\n\n" + CONTENT


def get_prompt_template() -> PromptTemplate:
    return PromptTemplate(
        content=TEMPLATE,
        description="<Department> <visit type> clinical note template",
        variables=["conversation_text", "patient_info"],
    )
```

### Step 2: Add the JSON schema to `prompts_json.py`

Add an entry to `DEPT_VISIT_SCHEMAS` with the exact field names that the template's sections map to:

```python
DEPT_VISIT_SCHEMAS = {
    # ... existing entries ...

    # New Department — New/Referral
    ("new_department", "new_referral"): {
        "section_heading_1": "string (markdown)",
        "section_heading_2": "string (markdown)",
        "plan_of_care": "string (markdown)",
    },
}
```

### Step 3: Add department matching in `prompt_selector.py`

Add a new `if` block in `select_prompt_template()` with all accepted synonyms:

```python
# New Department
if dept in ("new department", "new dept", "nd"):
    if vt == "new_referral":
        return _get_template(prompts_new_department_new_referral)
    if vt == "followup":
        return _get_template(prompts_new_department_followup)
```

Also add synonym mapping in `get_department_schema()` within `prompts_json.py`:

```python
elif dept in ("new department", "new dept", "nd"):
    dept = "new_department"
```

### Step 4: Add the import in `prompt_selector.py`

Add the module to the import block at the top of `prompt_selector.py`:

```python
try:
    from . import (
        # ... existing imports ...
        prompts_new_department_new_referral,
        prompts_new_department_followup,
    )
except Exception:
    # ... existing fallbacks ...
    prompts_new_department_new_referral = None
    prompts_new_department_followup = None
```

### Verification checklist

After adding a new department:

- [ ] Template module exists and `get_prompt_template()` returns a valid `PromptTemplate`
- [ ] Schema entry added to `DEPT_VISIT_SCHEMAS` with correct `(department, visit_type)` key
- [ ] Department synonyms added to both `select_prompt_template()` and `get_department_schema()`
- [ ] Import added to `prompt_selector.py` with fallback in the `except` block
- [ ] Test: `select_prompt_template("<department>", "New Referral")` returns a template
- [ ] Test: `select_prompt_template("<department>", "Follow-up")` returns a template
- [ ] Test: `get_department_schema("<department>", "new_referral")` returns the correct schema

---

## Important Notices

### SAIL Guidelines Compliance

All department templates must comply with SAIL (Standardized AI-generated Letters) guidelines. This includes structured formatting, clinical accuracy, and appropriate language use.

### Writing Style

- **Third person, past tense** — "The patient presented with..." not "You presented with..."
- Clinical and professional tone throughout.

### No AI-Generated Recommendations

The output must not contain AI-generated clinical recommendations, diagnoses, or treatment suggestions beyond what was explicitly discussed in the conversation. The system summarizes; it does not advise.

### Language Rules

- **Headings** (JSON keys and markdown headers within values) are in **English**.
- **Content** (the actual clinical text) is in the **conversation language**.
- Do not mix languages within a single field value.

### Negative History Documentation

Negative history (e.g., "no family history of diabetes") should only be documented if **explicitly mentioned** in the conversation. Do not infer or assume negative findings.

### Request Independence

Each request is treated independently. There is no cross-patient data sharing, no session persistence between requests, and no carry-over of context beyond what is explicitly provided in the request payload (including `pre_summary_text`).

### Complete Example: End-to-End Prompt Assembly

```python
from prompt_selector import select_prompt_template
from prompts_json import JsonPromptFactory, get_department_schema
from prompts_catchall_soap import get_prompt_template as get_catchall

department = "Breast & Endocrine"
visit_type = "New Referral"
session_id = "sess-2025-06-15-001"
patient_info = "Patient: Jane Smith, 52F, MRN: 12345"
conversation_text = "Doctor: Good morning...\nPatient: ..."
pre_summary = "Known case of fibrocystic breast disease. Last mammogram: Jan 2025."

# 1. Check if department template exists
template = select_prompt_template(department, visit_type)
if template:
    print(f"Using template: {template.description}")
else:
    print("No department template found, using catch-all")

# 2. Get the JSON schema for this department
schema = get_department_schema(department, visit_type)
print(f"Schema fields: {list(schema.keys())}")

# 3. Build the final prompt
result = JsonPromptFactory.build_template_by_department(
    department=department,
    visit_type=visit_type,
    session_id=session_id,
    patient_info=patient_info,
    conversation_text=conversation_text,
    conversation_language="English",
    session_date="2025-06-15",
    pre_summary_text=pre_summary,
)

# 4. Send to LLM
system_prompt = result["system"]
user_prompt = result["user"]
# llm_client.complete(system=system_prompt, user=user_prompt)
```
