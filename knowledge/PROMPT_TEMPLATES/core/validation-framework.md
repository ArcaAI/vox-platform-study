# Prompt Validation Framework

## Overview

The prompt validation framework (`prompt_validation.py`) provides automated quality assessment for prompt templates. It scores prompts across six dimensions and generates actionable improvement suggestions. The framework includes pre-built test scenarios for common medical encounters.

> **Note**: This module imports from `.schemas` (`StructuredOutputManager`, `SchemaType`, `ValidationLevel`) which resides in a sibling package. It may not be available in all deployments.

---

## Validation Metrics

The `PromptValidator` class evaluates prompts across six quality dimensions:

| Metric | Weight | What It Checks |
|---|---|---|
| **Clarity** | Equal | Vague phrases ("might", "maybe", "sort of"), sentence length (>30 words flagged), clarity indicators |
| **Completeness** | Equal | Essential medical elements (chief complaint, symptoms, examination, assessment, treatment, follow-up, medical history), JSON format guidance |
| **Specificity** | Equal | Ratio of vague terms vs. medical terminology; flags >5 vague term instances |
| **Consistency** | Equal | Bullet point style consistency, terminology variations (patient/client, doctor/physician, examination/exam) |
| **Medical Accuracy** | Equal | Concerning phrases ("cure", "guaranteed", "always works"), safety term presence (safety, risk, warning, caution, emergency) |
| **JSON Guidance** | Equal | JSON format requirements (json, format, structure, schema, object, field), specific JSON instructions (double quotes, valid json, required fields) |

### Scoring

- **Overall Score**: 0.0 to 1.0 (average of all metric scores)
- **Per-Metric Score**: `1.0 - (errors × 0.2) - (warnings × 0.1)`
- **Validation Pass**: `overall_score > 0.7` AND no errors in any metric

### Severity Levels

| Severity | Impact on Score | Meaning |
|---|---|---|
| **ERROR** | -0.2 per issue | Critical problem that must be fixed |
| **WARNING** | -0.1 per issue | Quality concern that should be addressed |
| **INFO** | No impact | Suggestion for improvement |

---

## Validation Checks Detail

### Clarity Validation

**Unclear phrases detected** (WARNING each):
```
might, maybe, possibly, could be, sort of, kind of,
somewhat, rather, fairly, pretty much
```

**Long sentence detection** (WARNING): Sentences with >30 words.

**Clarity indicators scoring**:
- Positive: `must`, `required`, `specify`, `include`, `extract`, `identify`, `document`, `list`, `describe`, `analyze`, `format`
- Negative: `might`, `maybe`, `possibly`, `could`, `sort of`, `kind of`, `somewhat`, `rather`, `fairly`, `pretty`

### Completeness Validation

**Essential medical elements** (WARNING if missing):
```
chief complaint, symptoms, examination, assessment,
treatment, follow, medical history
```

**JSON format guidance** (ERROR if missing): At least one of `json`, `format`, `structure`, `schema` must be present.

### Specificity Validation

**Vague terms tracked**:
```
relevant, appropriate, necessary, important, significant,
various, different, multiple, several, some, any
```

- WARNING if >5 instances total
- INFO if <5 medical terms found

### Consistency Validation

**Formatting consistency** (WARNING): Mixed bullet styles (-, *, numbered) in same template.

**Terminology consistency** (INFO): Using multiple terms from same group:
- patient / client
- doctor / physician / provider
- examination / exam
- medication / drug
- treatment / therapy

### Medical Accuracy Validation

**Concerning phrases** (WARNING each):
```
cure, guaranteed, always works, never fails, definitely
```

**Safety terms** (INFO if none found):
```
safety, risk, warning, caution, emergency
```

### JSON Guidance Validation

**Format requirements** (WARNING if <3 found):
```
json, format, structure, schema, object, field
```

**Specific instructions** (INFO if <2 found):
```
double quotes, valid json, no markdown, no explanations,
start with {, end with }, required fields
```

---

## Pre-Built Test Scenarios

The framework includes three standard test cases:

### 1. Emergency Chest Pain
```python
PromptTestCase(
    name="emergency_chest_pain",
    description="Emergency department chest pain case",
    variables={
        "session_id": "test_001",
        "patient_info": "45-year-old male with hypertension",
        "conversation_text": "Patient: I have severe chest pain. Doctor: When did it start?",
        "session_date": "2024-01-01",
        "additional_context": "Emergency department visit"
    },
    expected_elements=["chest pain", "emergency", "vital signs", "assessment"],
    specialty=MedicalSpecialty.EMERGENCY,
    encounter_type=EncounterType.EMERGENCY
)
```

### 2. Pediatric Checkup
```python
PromptTestCase(
    name="pediatric_checkup",
    description="Routine pediatric wellness visit",
    variables={
        "session_id": "test_002",
        "patient_info": "5-year-old female for wellness check",
        "conversation_text": "Parent: She's been growing well. Doctor: Let's check her development.",
        "session_date": "2024-01-01",
        "additional_context": "Routine wellness visit"
    },
    expected_elements=["growth", "development", "immunizations", "pediatric"],
    specialty=MedicalSpecialty.PEDIATRICS,
    encounter_type=EncounterType.OUTPATIENT
)
```

### 3. Surgical Consultation
```python
PromptTestCase(
    name="surgical_consultation",
    description="Pre-operative surgical consultation",
    variables={
        "session_id": "test_003",
        "patient_info": "60-year-old male for gallbladder surgery",
        "conversation_text": "Doctor: We need to discuss the surgical procedure and risks.",
        "session_date": "2024-01-01",
        "additional_context": "Pre-operative consultation"
    },
    expected_elements=["surgical", "procedure", "risks", "consent"],
    specialty=MedicalSpecialty.SURGERY,
    encounter_type=EncounterType.CONSULTATION
)
```

---

## API Reference

### PromptValidator

```python
class PromptValidator:
    def validate_prompt_template(self, template: PromptTemplate) -> PromptValidationResult
    def validate_enhanced_templates(self) -> Dict[str, PromptValidationResult]
    def test_prompt_with_scenarios(self, template, test_cases) -> Dict[str, Dict[str, Any]]
```

### PromptValidationResult

```python
@dataclass
class PromptValidationResult:
    is_valid: bool                              # True if no ERROR-severity issues
    overall_score: float                        # 0.0 to 1.0
    issues: List[ValidationIssue]               # All detected issues
    metrics_scores: Dict[PromptMetric, float]   # Per-metric scores
    suggestions: List[str]                      # Generated improvement suggestions
    metadata: Dict[str, Any]                    # total_issues, error_count, warning_count, template_length, variable_count
```

### ValidationIssue

```python
@dataclass
class ValidationIssue:
    severity: ValidationSeverity    # ERROR, WARNING, INFO
    metric: PromptMetric           # CLARITY, COMPLETENESS, SPECIFICITY, CONSISTENCY, MEDICAL_ACCURACY, JSON_GUIDANCE
    description: str               # Human-readable description
    suggestion: Optional[str]      # Improvement suggestion
    location: Optional[str]        # Where in the template
    line_number: Optional[int]     # Line number if applicable
```

---

## Usage Examples

### Validate a Single Template

```python
from model.prompt_validation import PromptValidator
from model.prompts import PromptTemplate

validator = PromptValidator()
template = PromptTemplate(
    content="Your prompt content here...",
    description="My custom template",
    variables=[]
)

result = validator.validate_prompt_template(template)
print(f"Valid: {result.is_valid}")
print(f"Score: {result.overall_score:.2f}")
for issue in result.issues:
    print(f"  [{issue.severity.value}] {issue.metric.value}: {issue.description}")
```

### Run Comprehensive Validation

```python
from model.prompt_validation import run_comprehensive_validation

results = run_comprehensive_validation()
print(f"Overall Score: {results['overall_score']:.2f}")
print(f"Templates Tested: {results['summary']['total_templates_tested']}")
print(f"Scenarios Tested: {results['summary']['total_scenarios_tested']}")
print(f"Passed: {results['summary']['validation_passed']}")
```

### Test with Custom Scenarios

```python
from model.prompt_validation import PromptValidator, PromptTestCase, create_test_cases

validator = PromptValidator()
test_cases = create_test_cases()

# Add custom test case
test_cases.append(PromptTestCase(
    name="rheumatology_followup",
    description="Rheumatology follow-up visit",
    variables={
        "session_id": "test_004",
        "patient_info": "55-year-old female with RA",
        "conversation_text": "Doctor: How are your joints today?",
        "session_date": "2024-06-15",
    },
    expected_elements=["joint", "medication", "disease activity"],
))

results = validator.test_prompt_with_scenarios(template, test_cases)
```

---

## Improvement Suggestions Generated

The framework automatically generates improvement suggestions based on the lowest-scoring metrics:

| Low-Scoring Metric | Generated Suggestion |
|---|---|
| Clarity (<0.7) | "Improve clarity by using more direct, specific language and shorter sentences" |
| Completeness (<0.7) | "Add missing medical documentation elements and JSON format guidance" |
| Specificity (<0.7) | "Replace vague terms with specific medical terminology and concrete examples" |
| Consistency (<0.7) | "Ensure consistent formatting and terminology throughout the prompt" |
| Medical Accuracy (<0.7) | "Enhance medical accuracy with proper terminology and safety considerations" |
| JSON Guidance (<0.7) | "Strengthen JSON format instructions with specific requirements and examples" |
