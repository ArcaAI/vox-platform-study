# Prompt Routing & Selection System

Reference documentation for the prompt routing and selection logic implemented in `prompt_selector.py`.

---

## Table of Contents

- [Overview](#overview)
- [Routing Flow](#routing-flow)
- [Visit Type Normalization](#visit-type-normalization)
- [Department Matching](#department-matching)
- [Context Resolution](#context-resolution)
  - [resolve\_department\_context](#resolve_department_context)
  - [extract\_department\_and\_visit\_type](#extract_department_and_visit_type)
- [Fallback Behavior](#fallback-behavior)
- [API Reference](#api-reference)
  - [select\_prompt\_template](#select_prompt_template)
  - [resolve\_department\_context](#resolve_department_context-1)
  - [extract\_department\_and\_visit\_type](#extract_department_and_visit_type-1)
- [Internal Helpers](#internal-helpers)
- [Usage Examples](#usage-examples)

---

## Overview

The prompt selector routes incoming summarization requests to the correct department-specific prompt template based on two axes: **department name** and **visit type**. It acts as the entry point for the department-aware prompt system, sitting between the API request layer and the 22 department/visit-type template modules.

The selector handles three real-world challenges:

1. **Fuzzy visit-type matching** — normalizes dozens of synonyms, abbreviations, and common misspellings into two canonical visit types (`new_referral` and `followup`).
2. **Synonym-based department resolution** — maps variant department names (including British/American spelling differences and shorthand) to canonical department keys.
3. **Graceful fallback** — returns `None` when no department match is found, allowing the caller to fall back to the catch-all SOAP template (`prompts_catchall_soap.py`).

Source: `prompt_selector.py`

---

## Routing Flow

The following describes the end-to-end routing process from an incoming request to a resolved `PromptTemplate`.

```
  ┌──────────────────────────────────────┐
  │         Incoming API Request          │
  │  (department, visit_type, payload)    │
  └──────────────┬───────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────┐
  │  1. Extract department & visit_type  │
  │     from request / nested payload    │
  │                                      │
  │  resolve_department_context(payload) │
  │  extract_department_and_visit_type() │
  └──────────────┬───────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────┐
  │  2. Normalize visit_type             │
  │     _normalize_visit_type(raw)       │
  │                                      │
  │  "referral" ──► "new_referral"       │
  │  "follow up" ─► "followup"           │
  │  "" / unknown ► "new_referral"       │
  └──────────────┬───────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────┐
  │  3. Normalize department             │
  │     _norm(raw) → lowercase, strip    │
  │                                      │
  │  "General Surgery" ──► "surgery"     │
  │  "Breast & Endocrine" ► matched set  │
  └──────────────┬───────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────┐
  │  4. Match department against known   │
  │     synonym sets (if/elif chain)     │
  │                                      │
  │  Match found?                        │
  │  ├─ YES → select module by visit_type│
  │  │        → _get_template(module)    │
  │  │        → return PromptTemplate    │
  │  │                                   │
  │  └─ NO  → return None               │
  │           (caller uses catch-all)    │
  └──────────────────────────────────────┘
```

**Step-by-step:**

1. **Extract** — The caller (or the selector itself via `resolve_department_context`) extracts department and visit type from the request payload. The extraction searches recursively through nested dicts and lists for known key names.
2. **Normalize visit type** — The raw visit-type string is lowercased, separators are replaced, and the result is matched against referral terms and follow-up terms. Unrecognized or empty values default to `new_referral`.
3. **Normalize department** — The raw department string is lowercased and stripped of whitespace.
4. **Match department** — The normalized department is compared against known synonym tuples. If matched, the corresponding module for the normalized visit type is loaded and its `get_prompt_template()` function is called.
5. **Return or fallback** — A `PromptTemplate` is returned on match; `None` is returned otherwise.

---

## Visit Type Normalization

The `_normalize_visit_type()` function maps raw visit-type strings to one of two canonical values. Normalization is case-insensitive and replaces hyphens/underscores with spaces before matching.

### Canonical: `new_referral`

All of the following terms (or substrings) resolve to `new_referral`:

| Term | Notes |
|---|---|
| `new` | Generic new visit |
| `first` | First appointment |
| `initial` | Initial consultation |
| `exam` | Examination |
| `examination` | Full word variant |
| `referral` | Standard referral |
| `referal` | Common misspelling (single 'r') |
| `refferal` | Common misspelling (double 'f') |
| `refer` | Shortened form |
| `referr` | Shortened with double 'r' |
| `refd` | Abbreviation |
| `consult` | Consultation shorthand |
| `consultation` | Full word |

### Canonical: `followup`

| Term | Notes |
|---|---|
| `follow` | Matches "follow", "follow up", "follow-up" |
| `follow up` | Two-word variant |
| `followup` | Single-word variant |
| `follow-up` | Hyphenated variant |
| `fu` | Common medical abbreviation |
| `review` | Used by some departments (e.g., orthopedics) |
| `revisit` | Used by some departments (e.g., hematology) |
| `rv` | Abbreviation for review/revisit |

### Default Behavior

- **Empty or `None` input** → `new_referral`
- **Unrecognized non-empty input** → `new_referral`

The matching uses substring containment (`any(term in vt for term in ...)`), so a value like `"new referral visit"` matches because it contains `"new"`.

---

## Department Matching

Department matching is case-insensitive (input is lowercased and stripped). Each department is identified by a set of accepted input strings that map to a canonical department key and its corresponding prompt module pair.

| Input Strings (case-insensitive) | Canonical Key | New Referral Module | Follow-up Module |
|---|---|---|---|
| `surgery`, `general surgery` | surgery | `prompts_surgery_new_referral` | `prompts_surgery_followup` |
| `rheumatology` | rheumatology | `prompts_rheumatology_new_referral` | `prompts_rheumatology_followup` |
| `medicine`, `general medicine`, `internal medicine` | medicine | `prompts_medicine_new_referral` | `prompts_medicine_followup` |
| `neurology` | neurology | `prompts_neurology_new_referral` | `prompts_neurology_followup` |
| `orthopedics`, `orthopaedics`, `ortho` | orthopedics | `prompts_orthopedics_new_referral` | `prompts_orthopedics_review` |
| `hematology`, `haematology` | hematology | `prompts_hematology_new_referral` | `prompts_hematology_revisit` |
| `breast & endocrine`, `breast and endocrine`, `breast`, `endocrine`, `breast endocrine`, `breast/endocrine` | breast_endocrine | `prompts_breast_endocrine_new_referral` | `prompts_breast_endocrine_followup` |
| `dietetics`, `dietitian`, `clinical nutrition`, `nutrition` | dietetics | `prompts_dietetics_new_referral` | `prompts_dietetics_followup` |
| `dermatology`, `derm` | dermatology | `prompts_dermatology_new_referral` | `prompts_dermatology_followup` |
| `nephrology`, `nephro` | nephrology | `prompts_nephrology_new_referral` | `prompts_nephrology_followup` |
| `surgical oncology`, `surgical_oncology`, `surg oncology`, `oncosurgery`, `oncology surgery` | surgical_oncology | `prompts_surgical_oncology_new_referral` | `prompts_surgical_oncology_followup` |

**Notable naming exceptions:**

- Orthopedics follow-up uses module `prompts_orthopedics_review` (not `_followup`).
- Hematology follow-up uses module `prompts_hematology_revisit` (not `_followup`).
- These are internal naming choices; the visit-type normalization still maps to `followup` canonically.

---

## Context Resolution

Two functions handle extracting department and visit-type information from different payload shapes.

### resolve_department_context

Extracts department and visit type from deeply nested request payloads. Uses recursive search through dicts and lists to find the first non-empty value for each category of keys.

**Department ID keys** (searched in order):

```
department_id, departmentId,
current_department_id, currentDepartmentId,
dept_id, deptId
```

**Department name keys** (searched in order):

```
department_name, departmentName,
current_department_name, currentDepartmentName
```

**Department keys** (searched in order):

```
department, current_department, currentDepartment, dept
```

**Visit type keys** (searched in order):

```
visit_type, visitType,
session_type, sessionType,
encounter, encounter_type, encounterType
```

The recursive search (`_find_first`) traverses:
- **Dicts**: checks top-level keys first, then recurses into values.
- **Lists/Tuples**: iterates each element and recurses.
- Stops at the first non-empty, non-`None` match.

### extract_department_and_visit_type

A simpler, non-recursive extraction from flat `session_metadata` dicts. Checks a smaller set of keys at the top level only.

**Department keys**: `department`, `department_name`, `current_department`, `dept`, `department_id`

**Visit type keys**: `visit_type`, `visit`, `encounter`, `encounter_type`

Falls back to `session_type` parameter if no visit type is found in metadata.

---

## Fallback Behavior

When `select_prompt_template()` returns `None`:

1. No department synonym matched the input, **or**
2. The matched department module was not available (import failed, guarded by `try/except`), **or**
3. The module did not expose a `get_prompt_template()` function.

The caller is responsible for handling the `None` return. The standard fallback is to use the **catch-all SOAP template** from `prompts_catchall_soap.py`, which produces a generic four-section SOAP note (Subjective, Objective, Assessment, Plan).

```
select_prompt_template("cardiology", "new")
# → None (cardiology is not in the department map)
# → caller should use prompts_catchall_soap or ConversationalPrompts defaults
```

---

## API Reference

### select_prompt_template

```python
def select_prompt_template(
    department: Optional[str],
    visit_type: Optional[str],
) -> Optional[PromptTemplate]:
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `department` | `Optional[str]` | Human-readable department name (e.g., `"Surgery"`, `"Rheumatology"`, `"breast & endocrine"`). Case-insensitive. |
| `visit_type` | `Optional[str]` | Visit type string (e.g., `"New"`, `"Referral"`, `"Follow-up"`, `"Review"`, `"FU"`). Case-insensitive. |

**Returns:** `Optional[PromptTemplate]` — A `PromptTemplate` dataclass with `content`, `description`, and `variables` fields, or `None` if no match.

---

### resolve_department_context

```python
def resolve_department_context(
    payload: Optional[dict],
) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[str]]:
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `payload` | `Optional[dict]` | Arbitrarily nested request payload (dict/list structure). |

**Returns:** `Tuple[Optional[str], Optional[str], Optional[str], Optional[str]]`

| Index | Name | Description |
|---|---|---|
| 0 | `department_id` | Extracted department ID |
| 1 | `department_name` | Extracted department name |
| 2 | `department` | Extracted department (generic key) |
| 3 | `visit_type` | Extracted visit type |

---

### extract_department_and_visit_type

```python
def extract_department_and_visit_type(
    session_metadata: Optional[dict],
    session_type: Optional[str],
) -> Tuple[Optional[str], Optional[str]]:
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `session_metadata` | `Optional[dict]` | Flat metadata dict from the session. |
| `session_type` | `Optional[str]` | Fallback value for visit type if not found in metadata. |

**Returns:** `Tuple[Optional[str], Optional[str]]` — `(department, visit_type)`

---

## Internal Helpers

These are private functions not intended for external use but documented here for maintainability.

### _norm

```python
def _norm(text: Optional[str]) -> str
```

Lowercases and strips whitespace. Returns empty string for `None`.

### _normalize_visit_type

```python
def _normalize_visit_type(visit_type: Optional[str]) -> str
```

Full normalization pipeline: `_norm()` → replace hyphens/underscores with spaces → match against referral and follow-up term lists → return canonical value.

### _get_template

```python
def _get_template(module) -> Optional[PromptTemplate]
```

Safely calls `module.get_prompt_template()` with exception handling. Returns `None` if the module is `None`, lacks the function, or the function raises.

### _find_first

```python
def _find_first(payload: object, keys: Tuple[str, ...]) -> Optional[object]
```

Recursively searches a nested dict/list structure for the first non-empty value matching any of the provided keys. Checks dict keys at each level before recursing into values.

---

## Usage Examples

### Basic department + visit type selection

```python
from prompt_selector import select_prompt_template

# Surgery new referral
template = select_prompt_template("Surgery", "New Referral")
assert template is not None
print(template.description)
print(template.content[:200])

# Rheumatology follow-up (using abbreviation)
template = select_prompt_template("rheumatology", "FU")
assert template is not None

# Orthopedics with British spelling
template = select_prompt_template("Orthopaedics", "Review")
assert template is not None
```

### Handling fallback for unknown departments

```python
from prompt_selector import select_prompt_template
from prompts_catchall_soap import get_prompt_template as get_catchall

template = select_prompt_template("Cardiology", "New")
if template is None:
    template = get_catchall()
    print("Using catch-all SOAP template")
```

### Extracting from nested payloads

```python
from prompt_selector import resolve_department_context

payload = {
    "session": {
        "metadata": {
            "departmentName": "Breast & Endocrine",
            "visitType": "Follow-up",
        },
        "patient": {"id": "P-12345"},
    }
}

dept_id, dept_name, dept, visit_type = resolve_department_context(payload)
# dept_id    = None
# dept_name  = "Breast & Endocrine"
# dept       = None
# visit_type = "Follow-up"

template = select_prompt_template(dept_name or dept, visit_type)
assert template is not None
```

### Extracting from flat session metadata

```python
from prompt_selector import extract_department_and_visit_type

metadata = {
    "department": "Medicine",
    "visit_type": "initial consultation",
}

dept, visit = extract_department_and_visit_type(metadata, session_type="routine")
# dept  = "Medicine"
# visit = "initial consultation"

template = select_prompt_template(dept, visit)
# Normalized: department="medicine", visit_type="new_referral" (contains "initial")
assert template is not None
```

### Visit type normalization edge cases

```python
from prompt_selector import _normalize_visit_type

assert _normalize_visit_type("New Referral") == "new_referral"
assert _normalize_visit_type("refferal") == "new_referral"       # misspelling
assert _normalize_visit_type("follow-up") == "followup"
assert _normalize_visit_type("FU") == "followup"                 # abbreviation
assert _normalize_visit_type("rv") == "followup"                 # abbreviation
assert _normalize_visit_type("") == "new_referral"               # empty default
assert _normalize_visit_type(None) == "new_referral"             # None default
assert _normalize_visit_type("something_unknown") == "new_referral"  # unknown default
```
