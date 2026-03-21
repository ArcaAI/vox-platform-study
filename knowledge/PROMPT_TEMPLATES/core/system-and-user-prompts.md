# Core Prompt Engine — System & User Prompts

Reference documentation for the medical conversation summarization prompt system implemented in `prompts.py`.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [System Prompt](#system-prompt)
  - [Base System Prompt](#base-system-prompt)
  - [Specialty Enhancements](#specialty-enhancements)
- [User Prompt Templates](#user-prompt-templates)
  - [Detailed Template](#detailed-template)
  - [Simple Template](#simple-template)
- [Builder Methods](#builder-methods)
  - [build_system_prompt](#build_system_prompt)
  - [build_user_prompt](#build_user_prompt)
  - [build_extraction_prompt](#build_extraction_prompt)
- [Quick Templates](#quick-templates)
- [Configuration Defaults](#configuration-defaults)
- [Enums Reference](#enums-reference)
  - [MedicalSpecialty](#medicalspecialty)
  - [EncounterType](#encountertype)
- [Data Structures](#data-structures)
  - [PromptTemplate](#prompttemplate)
- [Legacy Compatibility](#legacy-compatibility)
- [Usage Examples](#usage-examples)

---

## Overview

The core prompt engine drives the LLM-powered summarization pipeline. It is responsible for constructing the system and user prompts sent to the language model, ensuring that medical conversations are transformed into structured, clinically accurate SOAP-format summaries.

The engine is implemented as the `ConversationalPrompts` class and provides:

- A **base system prompt** that establishes the LLM's medical-assistant persona, safety constraints, language requirements, and output formatting rules.
- **Specialty-specific prompt extensions** that inject domain knowledge for emergency medicine, pediatrics, cardiology, and psychiatry.
- **Two user prompt templates** (detailed and simple) that frame the conversation transcript and instruct the model to produce a SOAP JSON response.
- **Builder methods** that compose the final prompt payloads programmatically.
- **Quick templates** for common encounter scenarios.
- **Configuration defaults** for model inference parameters.

All summaries are returned as JSON objects whose values contain markdown-formatted clinical text, enabling both machine parsing and human-readable rendering.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    ConversationalPrompts                     │
│                                                             │
│  ┌───────────────────┐   ┌────────────────────────────────┐ │
│  │  SYSTEM_PROMPT_BASE│   │  SPECIALTY_PROMPTS (dict)      │ │
│  │  (persona, rules,  │   │  EMERGENCY | PEDIATRICS        │ │
│  │   language, format) │   │  CARDIOLOGY | PSYCHIATRY       │ │
│  └────────┬──────────┘   └──────────┬─────────────────────┘ │
│           │                         │                        │
│           └────────┬────────────────┘                        │
│                    ▼                                         │
│           build_system_prompt(specialty, encounter_type)     │
│                    │                                         │
│  ┌─────────────────┼──────────────────────┐                  │
│  │                 │                      │                  │
│  ▼                 ▼                      ▼                  │
│  USER_PROMPT    SIMPLE_PROMPT    build_extraction_prompt     │
│  _TEMPLATE      _TEMPLATE        (focus_area)               │
│  (detailed)     (lightweight)                                │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Quick Templates: emergency | routine | pediatric    │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## System Prompt

### Base System Prompt

`SYSTEM_PROMPT_BASE` is sent as the system message in every LLM call. It defines the model's role, clinical responsibilities, language policy, and output format.

```text
You are an expert medical AI assistant specialized in analyzing medical conversations
between healthcare providers and patients. Your role is to create clear, accurate, and
clinically relevant summaries in structured JSON format with markdown-formatted content.

Key responsibilities:
- Extract all clinically significant information accurately
- Identify symptoms with details about onset, duration, severity
- Document relevant medical history, medications, and allergies
- Note examination findings and vital signs
- Capture diagnostic reasoning and treatment plans
- Include follow-up recommendations and warning signs
- Maintain medical accuracy and use standard terminology
- Flag any safety concerns or urgent findings

LANGUAGE REQUIREMENTS:
- CRITICAL: Always respond in CONVERSATION LANGUAGE
- Maintain consistent language throughout all JSON fields and content
- Use appropriate medical terminology in the target language
- Do not mix languages within the response

FORMATTING REQUIREMENTS:
- Always respond with valid JSON format as specified in the user prompt
- Format ALL text content within JSON fields using markdown syntax
- Use headers (##), bold (**text**), lists (- item), and emphasis for structure
- Do not include any text outside the JSON structure
- Use "**Not documented**" (or equivalent in target language) for any information
  not available in the conversation

Always prioritize patient safety and clinical accuracy in your summaries.
```

#### Section Breakdown

| Section | Purpose |
|---|---|
| **Role definition** | Establishes the model as a medical AI assistant producing structured JSON with markdown content. |
| **Key responsibilities** | Eight directives covering symptom extraction, history, exam findings, diagnostics, treatment, follow-up, terminology, and safety. |
| **Language requirements** | Forces the model to respond in the same language as the conversation. Prevents language mixing. |
| **Formatting requirements** | Constrains output to valid JSON with markdown-formatted values. Specifies the sentinel value `**Not documented**` for missing information. |
| **Safety directive** | Final instruction prioritizing patient safety and clinical accuracy. |

### Specialty Enhancements

When a medical specialty is specified, the corresponding specialty prompt is **appended** to `SYSTEM_PROMPT_BASE` before the system message is sent. Each specialty injects domain-specific extraction priorities.

#### EMERGENCY

```text
Additional focus for Emergency Medicine:
- Triage acuity level and critical decision pathways
- Trauma assessment findings and mechanism of injury
- Toxicology screening and substance exposure details
- Emergency-specific vital signs and hemodynamic stability
- Time-critical interventions and disposition planning
```

**Key extraction targets:** triage acuity, critical pathways, trauma mechanism, toxicology, emergency vitals, time-critical interventions, disposition.

#### PEDIATRICS

```text
Additional focus for Pediatrics:
- Age-appropriate vital sign interpretation
- Growth parameters and developmental milestones
- Immunization status and schedule compliance
- Pediatric-specific dosing and formulations
- Parent/guardian concerns and social assessment
```

**Key extraction targets:** age-adjusted vitals, growth percentiles, developmental milestones, immunization compliance, pediatric dosing, caregiver concerns.

#### CARDIOLOGY

```text
Additional focus for Cardiology:
- Cardiovascular risk factor assessment
- ECG findings and rhythm analysis
- Hemodynamic parameters and cardiac output
- Cardiac imaging results interpretation
- Exercise tolerance and functional capacity
```

**Key extraction targets:** CV risk factors, ECG/rhythm, hemodynamics, cardiac imaging, exercise tolerance, functional capacity.

#### PSYCHIATRY

```text
Additional focus for Psychiatry:
- Mental status examination components
- Suicide and violence risk assessment
- Psychosocial stressors and support systems
- Substance use history and patterns
- Cognitive function and capacity assessment
```

**Key extraction targets:** mental status exam, suicide/violence risk, psychosocial stressors, substance use, cognitive status, capacity.

---

## User Prompt Templates

Both templates instruct the model to produce a SOAP-format JSON object. The **detailed template** is used for full clinical encounters; the **simple template** is a lightweight alternative for quick summaries.

### SOAP JSON Schema

Both templates request the same output structure:

```json
{
    "subjective": "## Subjective\n\nPatient-reported symptoms, chief complaint, history of present illness, review of systems, relevant past medical/surgical/family/social history...",
    "objective": "## Objective\n\nClinician-reported findings, vital signs, physical examination, lab results, imaging...",
    "assessment": "## Assessment\n\nWorking diagnosis, differential diagnoses, clinical reasoning...",
    "plan": "## Plan\n\nTreatment plan, medications, referrals, follow-up, patient education, warning signs..."
}
```

Each value is a markdown-formatted string. The `##` header at the start of each value enables direct rendering in a clinical UI.

### Detailed Template

**Template constant:** `USER_PROMPT_TEMPLATE`

**Variables:**

| Variable | Type | Description |
|---|---|---|
| `{session_id}` | `str` | Unique identifier for the clinical session |
| `{session_date}` | `str` | Date/time of the encounter |
| `{encounter_type}` | `str` | Type of encounter (see `EncounterType` enum) |
| `{specialty}` | `str` | Medical specialty context |
| `{conversation_language}` | `str` | Language of the conversation (e.g., `"English"`, `"Spanish"`) |
| `{patient_info}` | `str` | Pre-formatted patient demographics and context |
| `{conversation_text}` | `str` | Full transcript of the medical conversation |

**Template structure:**

```text
SESSION INFORMATION:
- Session ID: {session_id}
- Date: {session_date}
- Encounter Type: {encounter_type}
- Specialty: {specialty}

CONVERSATION LANGUAGE: {conversation_language}

PATIENT INFORMATION:
{patient_info}

CONVERSATION TRANSCRIPT:
{conversation_text}

INSTRUCTIONS:
Analyze the above medical conversation and provide a comprehensive clinical summary
in SOAP format. Respond ONLY with a valid JSON object using the following structure:

{
    "subjective": "## Subjective\n\nPatient-reported symptoms...",
    "objective": "## Objective\n\nClinician-reported findings...",
    "assessment": "## Assessment\n\nWorking diagnosis/differentials...",
    "plan": "## Plan\n\nTreatment/medications..."
}
```

The detailed template provides the model with full session metadata, enabling richer contextual reasoning (e.g., adjusting summary depth for an initial consultation vs. a follow-up).

### Simple Template

**Template constant:** `SIMPLE_PROMPT_TEMPLATE`

**Variables:**

| Variable | Type | Description |
|---|---|---|
| `{conversation_language}` | `str` | Language of the conversation |
| `{patient_info}` | `str` | Pre-formatted patient demographics and context |
| `{conversation_text}` | `str` | Full transcript of the medical conversation |

```text
CONVERSATION LANGUAGE: {conversation_language}

PATIENT INFORMATION:
{patient_info}

CONVERSATION TRANSCRIPT:
{conversation_text}

Provide a SOAP-format clinical summary as a JSON object:

{
    "subjective": "## Subjective\n\nPatient-reported symptoms...",
    "objective": "## Objective\n\nClinician-reported findings...",
    "assessment": "## Assessment\n\nWorking diagnosis/differentials...",
    "plan": "## Plan\n\nTreatment/medications..."
}
```

The simple template omits session metadata and reduces instruction verbosity. Use it when latency or token budget is a concern and full session context is unnecessary.

---

## Builder Methods

All builder methods are instance methods on `ConversationalPrompts`.

### build_system_prompt

```python
def build_system_prompt(
    self,
    specialty: str | None = None,
    encounter_type: str | None = None,
) -> str
```

Constructs the final system prompt by concatenating `SYSTEM_PROMPT_BASE` with the relevant specialty extension.

**Logic:**

1. Start with `SYSTEM_PROMPT_BASE`.
2. If `specialty` is provided and exists in `SPECIALTY_PROMPTS`, append the specialty text separated by a double newline.
3. Return the composed string.

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `specialty` | `str \| None` | `None` | Key into `SPECIALTY_PROMPTS`. Case-sensitive. Use `MedicalSpecialty` enum values. |
| `encounter_type` | `str \| None` | `None` | Encounter context (reserved for future per-encounter system prompt adjustments). |

**Returns:** `str` — the complete system prompt.

### build_user_prompt

```python
def build_user_prompt(
    self,
    session_id: str,
    patient_info: str,
    conversation_text: str,
    session_date: str | None = None,
    encounter_type: str | None = None,
    specialty: str | None = None,
    use_simple_format: bool = False,
    conversation_language: str = "English",
) -> str
```

Formats a user prompt template with the provided clinical data.

**Logic:**

1. If `use_simple_format` is `True`, use `SIMPLE_PROMPT_TEMPLATE`; otherwise use `USER_PROMPT_TEMPLATE`.
2. Substitute all `{variable}` placeholders with the corresponding arguments.
3. Return the formatted string.

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `session_id` | `str` | — | Unique session identifier |
| `patient_info` | `str` | — | Formatted patient demographics |
| `conversation_text` | `str` | — | Full conversation transcript |
| `session_date` | `str \| None` | `None` | Encounter date/time |
| `encounter_type` | `str \| None` | `None` | Encounter type label |
| `specialty` | `str \| None` | `None` | Medical specialty label |
| `use_simple_format` | `bool` | `False` | Select simple template when `True` |
| `conversation_language` | `str` | `"English"` | Target response language |

**Returns:** `str` — the complete user prompt ready for the LLM.

### build_extraction_prompt

```python
def build_extraction_prompt(
    self,
    conversation_text: str,
    focus_area: str,
) -> str
```

Builds a focused extraction prompt targeting a specific clinical domain within the conversation.

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `conversation_text` | `str` | — | Full conversation transcript |
| `focus_area` | `str` | — | Clinical domain to extract (e.g., `"medications"`, `"allergies"`, `"vital signs"`) |

**Returns:** `str` — a prompt instructing the model to extract only the specified focus area from the transcript.

---

## Quick Templates

Pre-built template configurations for common encounter scenarios. Each quick template bundles a specialty, encounter type, and any scenario-specific prompt adjustments.

| Template Key | Specialty | Encounter Type | Use Case |
|---|---|---|---|
| `"emergency"` | `EMERGENCY` | `EMERGENCY` | Emergency department encounters requiring triage-oriented summaries |
| `"routine"` | `GENERAL` | `ROUTINE_CHECKUP` | Standard outpatient visits and wellness checks |
| `"pediatric"` | `PEDIATRICS` | `INITIAL_CONSULTATION` | Pediatric encounters with developmental and growth focus |

Quick templates simplify caller code by pre-selecting the specialty and encounter type:

```python
prompts = ConversationalPrompts()
template = prompts.quick_templates["emergency"]
```

---

## Configuration Defaults

`ENHANCED_CONFIG_DEFAULTS` provides recommended inference parameters for the LLM when using this prompt system.

```python
ENHANCED_CONFIG_DEFAULTS = {
    "temperature": 0.1,
    "max_tokens": 6000,
    "top_p": 0.95,
    "chunk_size": 10000,
    "chunk_overlap": 500,
}
```

| Parameter | Value | Purpose |
|---|---|---|
| `temperature` | `0.1` | Low temperature for deterministic, clinically accurate output. Minimizes hallucination risk. |
| `max_tokens` | `6000` | Upper bound on response length. Sufficient for comprehensive SOAP summaries. |
| `top_p` | `0.95` | Nucleus sampling threshold. Slightly below 1.0 to prune low-probability tokens while preserving fluency. |
| `chunk_size` | `10000` | Maximum character count per transcript chunk when splitting long conversations. |
| `chunk_overlap` | `500` | Overlap between adjacent chunks to preserve context at boundaries. |

**Rationale for low temperature:** Medical summarization demands factual accuracy. A temperature of `0.1` strongly biases the model toward high-confidence tokens, reducing the risk of fabricated clinical details.

---

## Enums Reference

### MedicalSpecialty

Defines the supported medical specialties. Values are used as keys into `SPECIALTY_PROMPTS` and as labels in prompt templates.

| Member | Value | Has Specialty Prompt |
|---|---|---|
| `GENERAL` | `"general"` | No |
| `EMERGENCY` | `"emergency"` | Yes |
| `PEDIATRICS` | `"pediatrics"` | Yes |
| `SURGERY` | `"surgery"` | No |
| `PSYCHIATRY` | `"psychiatry"` | Yes |
| `CARDIOLOGY` | `"cardiology"` | Yes |
| `NEUROLOGY` | `"neurology"` | No |
| `ONCOLOGY` | `"oncology"` | No |

Specialties without a dedicated prompt extension use only `SYSTEM_PROMPT_BASE`. They are included in the enum for metadata and routing purposes.

### EncounterType

Defines the supported clinical encounter types. Used in session metadata within the detailed user prompt template.

| Member | Value | Description |
|---|---|---|
| `INITIAL_CONSULTATION` | `"initial_consultation"` | First visit for a new clinical concern |
| `FOLLOW_UP` | `"follow_up"` | Subsequent visit for an existing concern |
| `EMERGENCY` | `"emergency"` | Emergency department encounter |
| `ROUTINE_CHECKUP` | `"routine_checkup"` | Scheduled wellness or preventive visit |
| `PROCEDURE` | `"procedure"` | Procedural encounter (e.g., biopsy, minor surgery) |
| `TELEMEDICINE` | `"telemedicine"` | Remote consultation via video or phone |

---

## Data Structures

### PromptTemplate

A dataclass representing a reusable prompt template.

```python
@dataclass
class PromptTemplate:
    content: str
    description: str
    variables: List[str]
```

| Field | Type | Description |
|---|---|---|
| `content` | `str` | The template string containing `{variable}` placeholders |
| `description` | `str` | Human-readable description of the template's purpose |
| `variables` | `List[str]` | Ordered list of placeholder names expected in `content` |

---

## Legacy Compatibility

Two aliases exist for backward compatibility with older code that references previous class names:

```python
MedicalPrompts = ConversationalPrompts  # wrapper class
EnhancedPromptTemplates = ConversationalPrompts  # direct alias
```

| Legacy Name | Relationship | Notes |
|---|---|---|
| `MedicalPrompts` | Wraps `ConversationalPrompts` | Provides the same interface. Existing code using `MedicalPrompts` continues to work without changes. |
| `EnhancedPromptTemplates` | Direct alias | `EnhancedPromptTemplates is ConversationalPrompts` evaluates to `True`. |

**Migration guidance:** New code should import and use `ConversationalPrompts` directly. The legacy names are retained to avoid breaking existing integrations but may be deprecated in a future release.

---

## Usage Examples

### Basic SOAP Summary

```python
from prompts import ConversationalPrompts

prompts = ConversationalPrompts()

system_prompt = prompts.build_system_prompt()
user_prompt = prompts.build_user_prompt(
    session_id="sess_20260223_001",
    patient_info="Age: 45, Sex: Male, Known hypertension",
    conversation_text="<transcript text here>",
    session_date="2026-02-23T10:30:00Z",
    encounter_type="routine_checkup",
    conversation_language="English",
)

# Send to LLM
response = llm.chat(
    system=system_prompt,
    user=user_prompt,
    temperature=0.1,
    max_tokens=6000,
)
```

### Emergency Encounter with Specialty Prompt

```python
prompts = ConversationalPrompts()

system_prompt = prompts.build_system_prompt(
    specialty="emergency",
    encounter_type="emergency",
)
user_prompt = prompts.build_user_prompt(
    session_id="sess_20260223_042",
    patient_info="Age: 62, Sex: Female, Chest pain, diaphoresis",
    conversation_text="<transcript text here>",
    session_date="2026-02-23T14:05:00Z",
    encounter_type="emergency",
    specialty="emergency",
    conversation_language="English",
)
```

### Pediatric Encounter (Simple Format)

```python
prompts = ConversationalPrompts()

system_prompt = prompts.build_system_prompt(specialty="pediatrics")
user_prompt = prompts.build_user_prompt(
    session_id="sess_20260223_007",
    patient_info="Age: 3, Sex: Female, Well-child visit",
    conversation_text="<transcript text here>",
    use_simple_format=True,
    conversation_language="Spanish",
)
```

### Focused Extraction

```python
prompts = ConversationalPrompts()

extraction_prompt = prompts.build_extraction_prompt(
    conversation_text="<transcript text here>",
    focus_area="medications",
)
```

### Using Quick Templates

```python
prompts = ConversationalPrompts()

# Access a pre-built template configuration
emergency_template = prompts.quick_templates["emergency"]
routine_template = prompts.quick_templates["routine"]
pediatric_template = prompts.quick_templates["pediatric"]
```

### Using Configuration Defaults

```python
from prompts import ENHANCED_CONFIG_DEFAULTS

response = llm.chat(
    system=system_prompt,
    user=user_prompt,
    temperature=ENHANCED_CONFIG_DEFAULTS["temperature"],
    max_tokens=ENHANCED_CONFIG_DEFAULTS["max_tokens"],
    top_p=ENHANCED_CONFIG_DEFAULTS["top_p"],
)
```

### Multilingual Support

```python
prompts = ConversationalPrompts()

system_prompt = prompts.build_system_prompt()
user_prompt = prompts.build_user_prompt(
    session_id="sess_20260223_015",
    patient_info="Edad: 55, Sexo: Masculino, Diabetes tipo 2",
    conversation_text="<transcripción en español>",
    conversation_language="Spanish",
)
# The model will respond entirely in Spanish, including SOAP headers
# and the "**No documentado**" sentinel for missing information.
```

### Legacy Code Migration

```python
# Old code (still works)
from prompts import MedicalPrompts
prompts = MedicalPrompts()

# New code (preferred)
from prompts import ConversationalPrompts
prompts = ConversationalPrompts()
```
