# TASK-222 — Prompt, Template & Token Management: Gap Analysis & Enhancement Plan

- **Ticket**: TASK-222
- **Created**: 2026-02-24
- **Last Updated**: 2026-02-24
- **Status**: In Progress
- **Scope**: Prompts, Templates, Token Management, Structured Output, LLM Provider Optimization
- **User Stories Covered**: 117-150 (Prompt Lifecycle, Pre-Summary, Summary Generation, Doctor Review)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Baseline](#2-architecture-baseline)
3. [Current State Assessment](#3-current-state-assessment)
4. [Gap Analysis — Prompt Assembly & Variable Substitution](#4-gap-analysis--prompt-assembly--variable-substitution)
5. [Gap Analysis — Structured JSON Output](#5-gap-analysis--structured-json-output)
6. [Gap Analysis — Context Length & Token Management](#6-gap-analysis--context-length--token-management)
7. [Gap Analysis — Pre-Summary Pipeline](#7-gap-analysis--pre-summary-pipeline)
8. [Gap Analysis — DNA Writing Style](#8-gap-analysis--dna-writing-style)
9. [Gap Analysis — Department Template Consistency](#9-gap-analysis--department-template-consistency)
10. [Gap Analysis — Prompt Template Lifecycle](#10-gap-analysis--prompt-template-lifecycle)
11. [LLM Provider Fit Assessment](#11-llm-provider-fit-assessment)
12. [Structured Output — Provider-Specific Implementation Guide](#12-structured-output--provider-specific-implementation-guide)
13. [Context Length — Provider-Aware Budget Model](#13-context-length--provider-aware-budget-model)
14. [Prompt Template Enhancement Recommendations](#14-prompt-template-enhancement-recommendations)
15. [Prioritized Implementation Roadmap](#15-prioritized-implementation-roadmap)
16. [Appendix A — Full Prompt Template Inventory](#appendix-a--full-prompt-template-inventory)
17. [Appendix B — Department Seed Data Reference](#appendix-b--department-seed-data-reference)
18. [Appendix C — Source File Reference Map](#appendix-c--source-file-reference-map)
19. [Appendix D — Research Sources](#appendix-d--research-sources)
20. [Related Documentation](#related-documentation)

---

## 1. Executive Summary

This document presents a gap analysis and enhancement plan for the HOPE platform's prompt engineering, structured output, and token management systems. The analysis is **aligned with the intentional architecture** where:

- **SMR v2** is a **generic LLM gateway** (Ollama, Azure OpenAI, AWS Bedrock) — this is correct by design
- **The NestJS API layer** handles prompt composition, template resolution, variable substitution, and context assembly
- **Med-Gemma** (via Ollama), **GPT-4/4o** (Azure OpenAI), and **Claude** (Bedrock) are the target LLM providers

### Key Findings

| Metric | Value |
|--------|-------|
| Total enhancement items identified | **20** |
| Critical (blocks core quality) | **5** (E1, E2, E3, E4, E20) |
| High (significant improvement) | **5** |
| Medium (quality-of-life) | **6** |
| Low (future optimization) | **2** |
| User stories affected | **34** (stories 117-150) |

### Top 5 Critical Enhancements

| # | Enhancement | Impact |
|---|------------|--------|
| **E1** | SMR v2: Add optional `response_format`, fix defaults (temp→0.1 fallback, max_tokens→4096 fallback), ensure streaming | Correct provider behavior; structured output when template requires it |
| **E2** | API Layer: Prompt assembly — load template + hyperparameters + schema, substitute variables, build full SMR payload | Enables `{conversation_language}`, `{pre_summary_text}`, `{style_DNA_*}`; passes per-template settings |
| **E3** | Implement provider-aware context budgeting with token validation | Prevents truncation on Ollama, optimizes cost on Azure/Bedrock |
| **E4** | Connect pre-summary output to final summary input via `{pre_summary_text}` | Completes the two-stage pipeline |
| **E20** | Align seed data with `docs/prompts/` — add hyperparameters + outputSchema per template, seed 4 missing departments | Templates carry their own configuration; structured output per department |

---

## 2. Architecture Baseline

### Design Principles

1. **SMR v2 is a generic LLM gateway** — it accepts assembled prompts and forwards them to providers. It does NOT hardcode hyperparameters; it uses sensible defaults only when values are not supplied in the request body.
2. **The NestJS API layer handles prompt composition** — it resolves templates, substitutes variables, attaches hyperparameters from the prompt/template configuration, and assembles the full request payload.
3. **Hyperparameters are per-template configuration** — temperature, max_tokens, top_p, etc. are stored alongside each prompt/template in the database and sent to SMR as part of the request.
4. **Structured JSON output is optional and per-template** — each prompt/template may optionally define a JSON schema. When present, the API layer includes it in the request; SMR v2 maps it to the provider's native structured output API.
5. **Streaming is a core capability** — SMR v2 supports real-time streaming responses via SSE. The API layer must preserve this capability when forwarding to clients.

### Target Architecture

```
Client SDK → API Gateway → SummaryService (Prompt Assembly) → SMR v2 → LLM Provider
                              │
                              ├── 1. Resolve prompt template by department + visit type
                              ├── 2. Load template content + hyperparameters + JSON schema (optional)
                              ├── 3. Substitute variables ({language}, {dna_style}, {pre_summary})
                              ├── 4. Assemble: { prompt, system_prompt, hyperparams, response_format?, stream }
                              └── 5. Send to SMR v2 with all parameters
                                       │
                                       ▼
                              SMR v2 /api/v2/generate
                              ├── Uses request hyperparams (temperature, max_tokens, etc.)
                              ├── Falls back to defaults ONLY when not provided:
                              │     temperature: 0.1, max_tokens: 4096
                              ├── Maps response_format to provider-native API (when present)
                              ├── Supports stream: true for real-time SSE responses
                              ├── Handles retry, circuit breaker, rate limiting
                              └── Returns generated text + token usage (stream or sync)
```

**Responsibility Matrix:**

| Concern | Where It Lives | Why |
|---------|---------------|-----|
| Medical domain logic (departments, templates, DNA) | API Layer (NestJS) | Direct DB access to departments, prompts, DNA styles, consultations |
| Prompt/template hyperparameters (temperature, max_tokens, etc.) | Stored per-template in DB → sent by API Layer | Each department/visit-type has different optimal settings |
| Structured JSON output schema (optional) | Stored per-template in DB → sent by API Layer → mapped by SMR v2 | Not all templates need structured output; department schemas vary |
| Variable substitution | API Layer (NestJS) | `promptUtils.ts` already exists; context data lives in NestJS |
| LLM provider management (retry, circuit breaker, streaming) | SMR v2 (Python) | Python ecosystem for LLM provider SDKs; resilience patterns |
| Provider-native structured output mapping | SMR v2 (Python) | Maps generic `response_format` to Ollama `format` / Azure `json_schema` / Bedrock `outputConfig` |
| Default hyperparameters (fallback only) | SMR v2 (Python) | `temperature: 0.1`, `max_tokens: 4096` when not in request |

### SMR v2 Default Behavior

SMR v2 does **not** hardcode hyperparameters. It uses defaults **only** when the request body omits them:

| Parameter | Default (when not in request) | Rationale |
|-----------|:---:|-----------|
| `temperature` | `0.1` | Deterministic medical output |
| `max_tokens` | `4096` | Sufficient for most clinical notes |
| `top_p` | `0.95` | Slightly restrictive nucleus sampling |
| `stream` | `false` | Sync by default; streaming opt-in |
| `response_format` | `null` (plain text) | Structured output is optional |

When the API layer sends hyperparameters from the template configuration, those values **override** the defaults entirely.

### Streaming Requirement

SMR v2 **must** support real-time streaming responses for summary generation:

- **SSE (Server-Sent Events)** for token-by-token delivery to the client
- The API layer passes `stream: true` when the client requests streaming
- All 3 providers (Ollama, Azure OpenAI, Bedrock) support streaming natively
- SMR v2 already has streaming infrastructure (`StreamChunk`, SSE endpoint, task manager) — this must be preserved and enhanced
- Token usage metadata should be returned in the final stream event

### Current Flow vs Target Flow

**Current (gaps marked with ⚠):**

```
SDK.generateSummary({ dnaStyleId, template, transcript, departmentId })
    │
    ▼
SummaryService.generateSummary()
    │ 1. Fetches transcripts
    │ 2. [Async] Resolves prompt config → gets template name + promptId
    │ ⚠ Does NOT load template content or hyperparameters
    │ ⚠ Does NOT substitute variables
    │ ⚠ Does NOT attach JSON schema
    │ 3. Calls SMR: POST { text, dnaStyleId, template }
    │
    ▼
SMR v2 GenerateRequest
    │ ⚠ temperature hardcoded to 0.7 (should default to 0.1)
    │ ⚠ max_tokens hardcoded to 4096 (correct default, but should be overridable)
    │ ⚠ No response_format field
    │ ⚠ Token usage ignored in non-streaming mode
```

**Target:**

```
SDK.generateSummary({ dnaStyleId, template, transcript, departmentId, stream? })
    │
    ▼
SummaryService (Prompt Assembly)
    │ 1. Resolve prompt template → load content + hyperparameters + JSON schema
    │ 2. Substitute variables: {conversation_language}, {pre_summary_text}, {style_DNA_*}
    │ 3. Build payload: { prompt, system_prompt, temperature, max_tokens, response_format?, stream }
    │ 4. Send to SMR v2 with all parameters from template config
    │
    ▼
SMR v2 GenerateRequest
    │ ✅ Uses request temperature (from template config, e.g., 0.1)
    │ ✅ Uses request max_tokens (from template config, e.g., 6000)
    │ ✅ Maps response_format to provider-native API (when present)
    │ ✅ Supports stream: true for real-time SSE
    │ ✅ Returns token usage in response
```

---

## 3. Current State Assessment

### Maturity Matrix

| Area | Status | Maturity | Notes |
|------|--------|----------|-------|
| Prompt Templates (Backend CRUD) | Implemented | **High** | 42 templates seeded, versioning, 7 API endpoints |
| Department-Prompt Wiring | Implemented | **High** | 9/15 departments with full new-patient + revisit prompts |
| Prompt Resolution | Implemented | **High** | 3-tier fallback (explicit → department → default) |
| Summary Generation (API) | Implemented | **High** | Sync/async/comprehensive/NER |
| Pre-Summary Generation | Implemented | **Medium** | Functional; prompts need enrichment; not wired to final summary |
| DNA Writing Style | Partial | **Medium** | DB + backend modules exist; not injected into prompts |
| SDK Integration | Implemented | **High** | All types, hooks, utils complete |
| SMR v2 (LLM Gateway) | Implemented | **High** | 3 providers, retry, circuit breaker, streaming. Needs: default fixes, `response_format` field |
| Structured JSON Output | **Not implemented** | **None** | Optional per-template; no provider passes `response_format`. SMR v2 needs the field; API layer needs to attach schema from template config |
| Per-Template Hyperparameters | **Not implemented** | **None** | Templates don't carry temperature/max_tokens/schema config yet |
| Token Management | **Not implemented** | **None** | No budgeting, chunking, or validation |
| Prompt Variable Substitution | Partial | **Low** | SDK utils exist; server-side not wired |
| Streaming (Real-time) | Implemented | **High** | SMR v2 has SSE + WebSocket streaming; API layer needs to expose it for summary generation |
| Admin UI for Prompts | Partial | **Medium** | 55% E2E stories pass (TASK-218) |

---

## 4. Gap Analysis — Prompt Assembly & Variable Substitution

### E2 — Wire Variable Substitution (Critical)

**User Stories**: 117, 118, 135, 139

**Current state**: `promptUtils.ts` in the SDK provides `substitutePromptVariables()`, `extractPromptVariables()`, and `validatePromptVariables()`. `PromptResolutionService` resolves `promptId` and `contextVariables`. However:

- `SummaryService` sends raw text to SMR without loading prompt template content
- `SummaryProcessor` resolves `promptId` but only forwards the `template` string name — the ID is silently dropped
- No server-side code loads prompt content and substitutes `{conversation_language}`, `{pre_summary_text}`, `{style_DNA_*}`, etc.

**What needs to happen** (in the NestJS API layer):

```
PromptAssemblyService.assemble(params):
  1. PromptResolutionService.resolve(departmentId, visitType)
     → Returns { promptId, template, contextVariables }
  
  2. Load prompt template content by promptId from DB
     → Returns full template text + variable definitions
  
  3. Load system prompt (SMR_SYSTEM_BASE + JSON_ENFORCEMENT)
  
  4. Substitute variables in user prompt:
     - {conversation_language} ← from request or consultation metadata
     - {pre_summary_text} ← from pre-summary ContextItem if available
     - {style_DNA_doctor_department_*} ← from loaded DNA style if dnaStyleId provided
     - {same_day_prequel_summary} ← from same-day prior consultation if exists
     - {session_id}, {session_date}, {patient_info} ← from consultation data
     - {conversation_text} ← the transcript
  
  5. Append department-specific JSON schema to system prompt
  
  6. Return { systemPrompt, userPrompt, jsonSchema, parameters }
```

**Files to modify:**

| File | Change |
|------|--------|
| `packages/applications/src/services/consultation/prompt/` | New `PromptAssemblyService` |
| `packages/applications/src/services/consultation/summary/summary.service.ts` | Call assembly before SMR |
| `packages/applications/src/services/consultation/jobs/processors/summary.processor.ts` | Call assembly in async path |

---

## 5. Gap Analysis — Structured JSON Output

### E1 — Add Optional Structured Output Support to SMR Providers (Critical)

**User Stories**: 137 (department-specific sections), 138 (retry if invalid JSON)

**Current state**: All 3 providers return unstructured plain text. None pass `response_format`, `format`, or `toolConfig` parameters.

**Key design decision**: Structured JSON output is **optional** and configured **per prompt/template**. Not all templates require structured output — for example, pre-summary prompts produce narrative text. The JSON schema, when defined, is stored alongside the template in the database and sent by the API layer only when present.

**The fix has two parts:**
1. **SMR v2**: Add a `response_format` field to `GenerateRequest` (optional, defaults to plain text). Map to provider-native APIs when present.
2. **Prompt Template DB schema**: Add an optional `outputSchema` (JSON) field alongside hyperparameters for each template.

### Provider-Native Structured Output APIs

| Provider | API Parameter | Mechanism | Reliability |
|----------|--------------|-----------|-------------|
| **Ollama** | `format: { <JSON Schema> }` | GBNF grammar-constrained decoding | High — token-level enforcement |
| **Azure OpenAI** | `response_format: { type: "json_schema", json_schema: { schema, strict: true } }` | Constrained decoding | Very High — server-side enforcement |
| **AWS Bedrock** | `outputConfig: { textFormat: { type: "json_schema", structure: { jsonSchema } } }` | Constrained decoding | Very High — server-side enforcement |

All 3 providers now support **native schema-constrained generation**. When the template defines a JSON schema, SMR v2 maps it to the provider's native API. When no schema is defined, SMR v2 returns plain text.

### Proposed `GenerateRequest` Enhancement

```python
class ResponseFormat(BaseModel):
    type: Literal["text", "json", "json_schema"] = "text"
    json_schema: dict[str, Any] | None = None
    strict: bool = True

class GenerateRequest(BaseModel):
    prompt: str
    system_prompt: str | None = None
    provider: str = "ollama"
    model: str | None = None
    temperature: float | None = None     # Default: 0.1 (applied if None)
    max_tokens: int | None = None        # Default: 4096 (applied if None)
    top_p: float | None = None           # Default: 0.95 (applied if None)
    stream: bool = False
    response_format: ResponseFormat | None = None   # Optional — plain text if omitted
    context: dict[str, Any] | None = None
    retry_config: RetryConfig = RetryConfig()
```

**Default resolution in SMR v2 (not hardcoded — applied only when `None`):**

```python
DEFAULTS = {
    "temperature": 0.1,
    "max_tokens": 4096,
    "top_p": 0.95,
}

def resolve_params(request: GenerateRequest) -> dict:
    return {
        "temperature": request.temperature if request.temperature is not None else DEFAULTS["temperature"],
        "max_tokens": request.max_tokens if request.max_tokens is not None else DEFAULTS["max_tokens"],
        "top_p": request.top_p if request.top_p is not None else DEFAULTS["top_p"],
    }
```

### Per-Template Hyperparameter & Schema Configuration

Each prompt template in the database stores its own configuration:

```typescript
interface PromptTemplateConfig {
    hyperparameters?: {
        temperature?: number;       // e.g., 0.1 for clinical, 0.3 for DNA analysis
        max_tokens?: number;        // e.g., 6000 for surgery, 4096 for SOAP
        top_p?: number;             // e.g., 0.95
        top_k?: number;             // e.g., 40 (Ollama-specific)
    };
    outputSchema?: {                // Optional — only for templates requiring structured output
        type: "json_schema";
        schema: Record<string, unknown>;    // The JSON Schema object
        strict?: boolean;                   // Default: true
    };
}
```

**Example configurations:**

| Template | temperature | max_tokens | outputSchema |
|----------|:---:|:---:|:---:|
| Surgery - New Referral | 0.1 | 6000 | ✅ 14-field surgery schema |
| Neurology - Revisit | 0.1 | 6000 | ✅ 14-field neurology schema |
| SOAP Summary | 0.1 | 4096 | ✅ 4-field SOAP schema |
| General Pre-Summary | 0.1 | 4096 | ❌ (narrative text) |
| DNA Writing Style Analysis | 0.3 | 4096 | ❌ (structured report, not JSON) |
| Corrective Retry | 0.0 | 4096 | Same as original template |

The API layer reads these from the template record and includes them in the SMR request. SMR v2 applies its own defaults only for fields not provided.

### Provider Mapping

**Ollama** — add to `_build_payload()`:
```python
if request.response_format.type == "json_schema" and request.response_format.json_schema:
    payload["format"] = request.response_format.json_schema
elif request.response_format.type == "json":
    payload["format"] = "json"
```

**Azure OpenAI** — add to `generate()`:
```python
kwargs = {}
if request.response_format.type == "json_schema" and request.response_format.json_schema:
    kwargs["response_format"] = {
        "type": "json_schema",
        "json_schema": {
            "name": request.response_format.json_schema.get("title", "output"),
            "schema": request.response_format.json_schema,
            "strict": request.response_format.strict,
        }
    }
elif request.response_format.type == "json":
    kwargs["response_format"] = {"type": "json_object"}
```

**Bedrock** — add to `_build_converse_params()`:
```python
if request.response_format.type == "json_schema" and request.response_format.json_schema:
    params["outputConfig"] = {
        "textFormat": {
            "type": "json_schema",
            "structure": {
                "jsonSchema": {
                    "schema": json.dumps(request.response_format.json_schema),
                    "name": request.response_format.json_schema.get("title", "output"),
                }
            }
        }
    }
```

### JSON Schema Design Best Practices (from research)

1. **Schema per department template, not one mega-schema** — separate schemas reduce grammar compilation time and improve model accuracy
2. **Mark most fields as `required`** — optional fields double the grammar's state space. If a section should exist even if empty, make it required and allow `""`
3. **Use `additionalProperties: false`** on all objects — required by Azure OpenAI strict mode and Bedrock
4. **Use descriptive property names** — `history_of_present_illness` produces better extraction than `hpi`
5. **Avoid deeply nested objects** — keep schemas as flat as practical; 2 levels max
6. **Use `enum` for categorical data only** — don't over-constrain free-text clinical content
7. **One-shot examples in the prompt** outperform complex reasoning chains for structured medical extraction

### Corrective Retry Strategy

Even with constrained decoding, handle edge cases:

```
Layer 1: Native structured output (prevents ~95%+ format errors)
Layer 2: Defensive parsing (strip markdown fences, trim preamble before first {)
Layer 3: Zod/Pydantic validation on the response
Layer 4: Corrective self-repair prompt (cheaper than full regeneration)
Layer 5: Full regeneration with temperature=0 (last resort)
```

Check `stop_reason` / `finish_reason` — distinguish:
- `stop` (normal) — validate output
- `length` / `max_tokens` — output was truncated, increase budget or summarize more aggressively
- `content_filter` / `refusal` — safety block, log for review

---

## 6. Gap Analysis — Context Length & Token Management

### E3 — Provider-Aware Context Budgeting (Critical)

**User Stories**: 141 (streaming), 10 (cross-chain summary)

**Current state**: No context size validation. Content is naively joined with `\n\n` and sent as one blob. Token usage from Azure/Bedrock responses is ignored in non-streaming mode. `total_tokens=0` is hardcoded in the generate endpoint.

### Provider Context Windows

| Provider / Model | Context Window | Max Output | Input Cost ($/1M) | Cached Input | Notes |
|-----------------|---------------|-----------|-------------------|-------------|-------|
| **Med-Gemma 4B** (Ollama) | 128K | 8,192 | Free (self-hosted) | KV-cache auto | Needs 20+ GB VRAM for 128K; default 4K |
| **Med-Gemma 27B** (Ollama) | 128K | 8,192 | Free (self-hosted) | KV-cache auto | 48+ GB VRAM recommended |
| **GPT-4o** (Azure) | 128K | 16,384 | $2.50 | $1.25 (50% off) | Auto prompt caching |
| **GPT-4o-mini** (Azure) | 128K | 16,384 | $0.15 | ~$0.075 (50% off) | Best cost/quality ratio |
| **Claude Sonnet 4.5** (Bedrock) | 200K | 8,192 | $3.00 | $0.30 (90% off) | Explicit cache control |
| **Claude Haiku 4.5** (Bedrock) | 200K | 8,192 | $1.00 | $0.10 (90% off) | Best for high-volume |

### Ollama Context Window Configuration

Ollama auto-scales context based on available VRAM:

| VRAM Available | Default Context | Override Needed |
|---------------|----------------|-----------------|
| >= 48 GiB | 256K | No |
| 24-48 GiB | 32K | Set `num_ctx: 65536` for Med-Gemma |
| < 24 GiB | 4K | **Critical: must set `num_ctx`** or transcripts will be truncated |

**Configuration in HOPE:**
```python
# Ollama options in _build_payload()
"options": {
    "temperature": 0.1,
    "num_predict": request.max_tokens,
    "top_p": 0.95,
    "top_k": 40,
    "num_ctx": 65536,  # Explicit context window
}
```

Also set `keep_alive: -1` during active consultation sessions to prevent model unloading (which invalidates KV-cache).

### Token Budget Model

Budget active context to **40%** of provider context window — this single rule eliminates most lost-in-the-middle attention degradation.

| Segment | Constrained (8K) | Standard (128K) | Extended (200K) |
|---------|:---:|:---:|:---:|
| System prompt (static) | 500 (6%) | 6,400 (5%) | 10,000 (5%) |
| Department template | 300 (4%) | 3,840 (3%) | 6,000 (3%) |
| JSON schema + enforcement | 200 (3%) | 2,560 (2%) | 4,000 (2%) |
| DNA style overlay | 100 (1%) | 1,280 (1%) | 2,000 (1%) |
| P1 safety context | 400 (5%) | 5,120 (4%) | 8,000 (4%) |
| Pre-summary (P3) | 0 (excluded) | 12,800 (10%) | 20,000 (10%) |
| Conversation transcript | 1,500 (19%) | 19,200 (15%) | 30,000 (15%) |
| Safety buffer | 200 (3%) | 5,120 (4%) | 8,000 (4%) |
| **Total active** | **3,200 (40%)** | **56,320 (44%)** | **88,000 (44%)** |
| Reserved (LitM buffer) | 4,800 (60%) | 71,680 (56%) | 112,000 (56%) |

### Chunking Strategy for Long Transcripts

If transcript exceeds provider budget, use **semantic-topic chunking** (87% accuracy vs 50% for fixed-token — 2025 peer-reviewed research):

1. Split by speaker turns (doctor ↔ patient boundaries)
2. Detect topic shifts via medical entity transitions
3. Merge adjacent same-topic turns into semantic chunks
4. Apply chunk carry-forward header with critical context:

```
[CONTEXT CARRY-FORWARD]
Active Medications: Metformin 500mg, Lisinopril 10mg
Known Allergies: Penicillin (anaphylaxis)
Chief Complaint: Left knee pain x 3 weeks
---
[CHUNK 3/5 — Physical Examination]
...chunk content...
```

For very long conversations (>15K tokens), use **map-reduce**: summarize each chunk independently, then aggregate.

### Prompt Caching Opportunities

| Provider | Mechanism | Savings | Activation |
|----------|-----------|---------|------------|
| **Azure OpenAI** | Automatic prefix matching | 50% input cost | No code change — just ensure system prompt is the consistent prefix |
| **Bedrock/Anthropic** | Explicit `cache_control: {type: "ephemeral"}` on content blocks | 90% read cost | Add cache marker to system prompt block; use 1-hour cache for consultation sessions |
| **Ollama** | Automatic KV-cache | Free | Set `keep_alive: -1`; keep `num_ctx` consistent per session; use `OLLAMA_KV_CACHE_TYPE=q8_0` for VRAM savings |

**Prompt structure for cache effectiveness:** Place all static content (system prompt + department template + JSON schema + DNA style) at the beginning. Dynamic content (transcript, pre-summary) comes after the cached prefix.

### Lost-in-the-Middle Mitigation

Structure every medical prompt in this order:

```
┌─────────────────────────────────────────────┐
│ POSITION 1 — BEGINNING (highest attention)  │
├─────────────────────────────────────────────┤
│ System role + department identity            │
│ P1 SAFETY: allergies, active meds,          │
│   contraindications, chief complaint         │
│ Assessment instructions                      │
├─────────────────────────────────────────────┤
│ POSITION 2 — EARLY-MIDDLE                   │
├─────────────────────────────────────────────┤
│ DNA writing style overlay                    │
│ Department template structure                │
│ JSON output schema                           │
├─────────────────────────────────────────────┤
│ POSITION 3 — MIDDLE (lowest attention)      │
├─────────────────────────────────────────────┤
│ Pre-summary / prior visit context            │
│ Historical data                              │
├─────────────────────────────────────────────┤
│ POSITION 4 — END (highest attention)        │
├─────────────────────────────────────────────┤
│ CURRENT conversation transcript              │
│ Explicit task instruction                    │
│ REPEAT P1 SAFETY (reinforcement)             │
│ Output format enforcement                    │
└─────────────────────────────────────────────┘
```

---

## 7. Gap Analysis — Pre-Summary Pipeline

### E4 — Connect Pre-Summary to Final Summary (Critical)

**User Stories**: 127, 128, 131, 133

**Current state**: `SummaryService.generatePreSummary()` creates a `PRE_SUMMARY` ContextItem. `SummaryService.generateSummary()` is called separately and does **not** fetch the pre-summary. The `{pre_summary_text}` variable is never injected.

**Enhancement**: In the `PromptAssemblyService`, when assembling the final summary prompt:

1. Query for the latest `PRE_SUMMARY` ContextItem for this consultation
2. If found, inject its content as the `{pre_summary_text}` variable
3. Place it in the **middle** of the prompt (Position 3 in the LitM structure above)
4. Record the pre-summary ID in `SummaryMeta.preSummaryIds[]` for traceability

### E7 — Enrich Pre-Summary Prompts (High)

All 15 pre-summary prompts are 1-2 sentence placeholders. They need:

- Section structure guidance (what headings to produce)
- Recency weighting instructions (prioritize last 3 visits, same department)
- Length/token budget guidance
- Output format specification (structured to be injectable as context)

### E11 — Referral Context Sharing (Medium)

Pre-summary generation should traverse the consultation parent-child chain to include referring doctor's case notes, not just the current consultation's notes.

---

## 8. Gap Analysis — DNA Writing Style

### E5 — Inject DNA Style into Prompts (High)

**User Story**: 135

**Current state**: `dnaStyleId` is accepted by the API and passed to SMR, but:
- No code loads the `DnaWritingStyleReport` content
- No code injects `styleText` into the prompt
- Only 4 of 11 department templates reference `{style_DNA_doctor_department_*}`

**Enhancement** in `PromptAssemblyService`:

1. If `dnaStyleId` provided, load `DnaWritingStyleReport` by ID
2. If not provided but doctor has a latest style, load that
3. Extract `styleText` from the report
4. Substitute into `{style_DNA_doctor_department_*}` variable in the template
5. Create `DnaUsageRecord` for analytics

### E6 — Complete DNA Analysis Endpoint (High)

**User Story**: 15

`analyzeDNA()` in the SDK throws "no backend endpoint exists". The BullMQ job processor exists but the trigger endpoint needs verification. The `useDnaStyle.generateDnaStyle()` hook calls `POST /dna-writing-styles/generate` — verify this is wired end-to-end including the actual LLM analysis step.

---

## 9. Gap Analysis — Department Template Consistency

### E8 — Seed Missing Department Templates (now merged into E20)

See **E20 — Seed Data Alignment Detail** in Section 15 for the complete plan including new department templates, per-template hyperparameters, and optional outputSchema.

**Summary of departments with documented templates needing seed data:**

| Department | Code | Exists in DB? | Templates in `docs/prompts/` | Action |
|-----------|------|:---:|:---:|--------|
| Dermatology | DERM | ✅ (no prompts) | ✅ New (16) + Follow-Up (8) | Seed prompts into existing department |
| Dietetics | — | ❌ | ✅ New (7) + Follow-Up (5) | Create department + seed prompts |
| Nephrology | — | ❌ | ✅ New (8) + Follow-Up (8) | Create department + seed prompts |
| Surgical Oncology | — | ❌ | ✅ New (23) + Follow-Up (13) | Create department + seed prompts |

**Departments with existing system prompts but no department-specific summary templates (lower priority):**

| Department | Code | Has system prompt? | Action |
|-----------|------|:---:|--------|
| Radiology | RAD | ❌ | Needs template creation (not documented yet) |
| Laboratory | LAB | ❌ | Needs template creation (not documented yet) |
| Psychiatry | PSYCH | ✅ (SMR_SYSTEM_PSYCH) | Needs department summary templates |
| Pediatrics | PEDS | ✅ (SMR_SYSTEM_PEDS) | Needs department summary templates |
| Emergency | ER | ✅ (SMR_SYSTEM_ER) | Needs department summary templates |

### E9 — Standardize Template Features (High)

| Feature | Older Templates (7) | Newer Templates (4) | Target |
|---------|:---:|:---:|:---:|
| `{style_DNA_*}` variable | ❌ | ✅ | All templates |
| `{same_day_prequel_summary}` | ❌ | ✅ | All templates |
| Distinct visit-type LLM notes | ❌ | ✅ | All templates |
| Anti-AI-opinion guardrails | Basic | Enhanced | All templates |

### E12 — Language Policy Standardization (Medium)

Templates have conflicting language directives. Options:
- **Option A**: All templates produce output in `{conversation_language}` (configurable per request)
- **Option B**: All templates produce output in English (consistent, simpler NER)
- **Recommendation**: Option A with English as default — `{conversation_language}` variable defaults to "English" but can be overridden per request per user story 139

---

## 10. Gap Analysis — Prompt Template Lifecycle

### E10 — FK Validation on Department Prompt IDs (High)

**User Story**: 124

`newPatientPromptId`, `revisitPromptId`, `preSummaryPromptId` on Department are unconstrained strings. Deleted/invalid prompt IDs silently break summary generation. Add either:
- Database-level FK constraints (preferred)
- Application-level validation on department prompt assignment

### E13 — Prompt Preview/Testing (Medium)

**User Story**: 120

Allow admins to run a prompt template against sample consultation data to verify output quality before publishing. Endpoint: `POST /prompt-templates/:id/preview { sampleData }`.

### E14 — Draft/Published Guard (Medium)

**User Story**: 122

`PromptTemplateStatus` (`DRAFT | PUBLISHED`) exists in SDK types but maps to `ResourceStatusType` (`ENABLED/DISABLED`) in the domain. Add a guard in `PromptResolutionService` to skip `DISABLED`/`ARCHIVED` prompts.

### E15 — Track Prompt Version in SummaryMeta (Medium)

**User Story**: 125

`SummaryMeta.promptVersion` is never populated. When the `PromptAssemblyService` loads a prompt template, it should return the version number for recording in the summary metadata.

### E16 — `summaryPromptId` Type Mismatch (Low)

SDK `DepartmentPromptField` includes `'summaryPromptId'` but domain entity only has `newPatientPromptId`, `revisitPromptId`, `preSummaryPromptId`. Either add the field to the schema or remove from the SDK type.

---

## 11. LLM Provider Fit Assessment

### Med-Gemma via Ollama

| Attribute | Assessment |
|-----------|-----------|
| **Model** | MedGemma 1.5 4B (`MedAIBase/MedGemma1.5:4b`) — recommended; outperforms 27B on structured JSON extraction |
| **Context** | 128K architecture; defaults to 4K in Ollama — **must set `num_ctx: 65536+`** |
| **Medical accuracy** | MedQA: 69.1% (vs 50.7% Gemma 3 base); EHR QA: 89.6%; PDF-to-JSON: 91% F1 |
| **Structured output** | Ollama `format` parameter with JSON Schema — GBNF grammar-constrained decoding |
| **Temperature** | Use 0.0-0.1 for medical summarization; research shows minimal accuracy impact across 0.0-1.0 but determinism matters for clinical docs |
| **Quantization** | Use `Q4_K_M` or `Q8_0`; **avoid `q4_0`** (known overfitting issues) |
| **VRAM** | 4B: ~8 GB for Q4_K_M; 27B: ~17 GB for Q4_K_M |
| **One-shot prompting** | Research shows simple one-shot outperforms complex reasoning (ReAct, agentic) for Med-Gemma medical extraction |
| **Fit verdict** | **Excellent** for on-premise/privacy-sensitive deployments. Best cost-to-quality ratio for structured medical extraction. |

### Azure OpenAI (GPT-4o / GPT-4o-mini)

| Attribute | Assessment |
|-----------|-----------|
| **Models** | GPT-4o (best quality), GPT-4o-mini (best cost/quality) |
| **Context** | 128K; 16K max output |
| **Structured output** | `response_format: { type: "json_schema", strict: true }` — server-side constrained decoding. Highest reliability. |
| **Prompt caching** | Automatic, 50% savings on cached input prefix. No code change needed. |
| **API version** | Use `2024-10-21` or later for GA structured outputs |
| **Limitations** | `additionalProperties: false` required on all objects; no `minLength`/`maxLength`; max 24 optional params per schema |
| **Fit verdict** | **Excellent** for production cloud deployment. Most mature structured output implementation. |

### AWS Bedrock (Claude Haiku/Sonnet)

| Attribute | Assessment |
|-----------|-----------|
| **Models** | Claude Haiku 4.5 (high-volume), Claude Sonnet 4.5 (complex reasoning) |
| **Context** | 200K; 8K max output |
| **Structured output** | `outputConfig.textFormat` with JSON schema — constrained decoding. Also supports strict tool use. |
| **Prompt caching** | 90% savings on cached reads; 1-hour cache duration (Jan 2026). Explicit `cache_control` markers. |
| **Grammar caching** | First request compiles grammar (~seconds); cached for 24 hours per account |
| **Fit verdict** | **Excellent** for cost-optimized production. Best caching economics (90% savings). Largest context window. |

### Provider Recommendation Matrix

| Use Case | Recommended Provider | Why |
|----------|---------------------|-----|
| On-premise / HIPAA-isolated | Med-Gemma 4B via Ollama | Zero data egress; free; 91% F1 on medical JSON |
| Production cloud (volume) | Claude Haiku 4.5 via Bedrock | Lowest cost per token; 90% cache savings; 200K context |
| Production cloud (quality) | GPT-4o via Azure | Most mature structured output; automatic caching |
| Complex multi-specialty cases | Claude Sonnet 4.5 via Bedrock | Best reasoning; 200K context for longitudinal data |
| Cost-constrained cloud | GPT-4o-mini via Azure | $0.15/1M input; 128K context; good structured output |

---

## 12. Structured Output — Provider-Specific Implementation Guide

### Schema Definition (Single Source of Truth)

Define department schemas using Zod in the NestJS codebase, convert to JSON Schema for SMR:

```typescript
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const SurgeryNewReferralSchema = z.object({
  patient_demographics: z.string(),
  presenting_complaints: z.string(),
  risk_factors: z.string(),
  history_of_present_illness: z.string(),
  reproductive_history: z.string(),
  treatment_history: z.string(),
  drug_history: z.string(),
  family_history: z.string(),
  physical_examination_general: z.string(),
  physical_examination_local: z.string(),
  investigations: z.string(),
  diagnosis: z.string(),
  plan_of_care: z.string(),
  review_date: z.string(),
});

const jsonSchema = zodToJsonSchema(SurgeryNewReferralSchema);
```

The API layer reads the schema from the template record and includes it in the SMR request **only when the template has an `outputSchema` configured**:

```typescript
const templateConfig = loadedTemplate.config; // { hyperparameters, outputSchema }

const smrPayload = {
  prompt: assembledUserPrompt,
  system_prompt: assembledSystemPrompt,
  provider: resolvedProvider,
  // Hyperparameters from template config (SMR defaults apply if omitted)
  temperature: templateConfig.hyperparameters?.temperature,   // e.g., 0.1
  max_tokens: templateConfig.hyperparameters?.max_tokens,     // e.g., 6000
  top_p: templateConfig.hyperparameters?.top_p,               // e.g., 0.95
  stream: request.stream ?? false,
  // Structured output — only when template defines it
  ...(templateConfig.outputSchema && {
    response_format: templateConfig.outputSchema,
  }),
};
```

### SMR v2 Provider Mapping

Each provider in SMR v2 maps `response_format` to their native API:

| Provider | Native Parameter | Added To |
|----------|-----------------|----------|
| Ollama | `format: schema` in payload | `_build_payload()` |
| Azure OpenAI | `response_format: { type: "json_schema", json_schema: { schema, strict } }` in `create()` | `generate()` |
| Bedrock | `outputConfig: { textFormat: { type: "json_schema", structure: { jsonSchema } } }` in `converse()` | `_build_converse_params()` |

### Token Usage Extraction

All 3 providers return token usage — currently ignored. Fix:

| Provider | Where Usage Lives | Change |
|----------|------------------|--------|
| Ollama | `response.get("eval_count")` (output), `response.get("prompt_eval_count")` (input) | Extract in `generate()` |
| Azure OpenAI | `response.usage.prompt_tokens`, `response.usage.completion_tokens` | Extract in `generate()` |
| Bedrock | `response["usage"]["inputTokens"]`, `response["usage"]["outputTokens"]` | Extract in `generate()` |

Return as part of `GenerateResponse` instead of hardcoding `total_tokens=0`.

---

## 13. Context Length — Provider-Aware Budget Model

### ProviderContextConfig

```typescript
interface ProviderContextConfig {
  maxContextTokens: number;
  effectiveContextTokens: number;    // 40% of max
  reservedForOutput: number;
  cachingSupported: boolean;
  costPerMillionInput: number;
  costPerMillionOutput: number;
  cachedInputDiscount: number;       // 0.5 for Azure, 0.9 for Bedrock, 0 for Ollama
}

const PROVIDER_CONFIGS: Record<string, ProviderContextConfig> = {
  "medgemma-4b": {
    maxContextTokens: 128_000,
    effectiveContextTokens: 51_200,
    reservedForOutput: 8_192,
    cachingSupported: true,
    costPerMillionInput: 0,
    costPerMillionOutput: 0,
    cachedInputDiscount: 0,
  },
  "gpt-4o": {
    maxContextTokens: 128_000,
    effectiveContextTokens: 51_200,
    reservedForOutput: 16_384,
    cachingSupported: true,
    costPerMillionInput: 2.50,
    costPerMillionOutput: 10.00,
    cachedInputDiscount: 0.50,
  },
  "claude-haiku-4.5": {
    maxContextTokens: 200_000,
    effectiveContextTokens: 80_000,
    reservedForOutput: 8_192,
    cachingSupported: true,
    costPerMillionInput: 1.00,
    costPerMillionOutput: 5.00,
    cachedInputDiscount: 0.90,
  },
};
```

### Priority-Based Context Selection

| Tier | Content | Rule |
|------|---------|------|
| **P1 — Always Include** | Allergies, active medications, chief complaint, contraindications | Always present, beginning + end |
| **P2 — Include if Space** | Current symptoms, vitals, exam findings, active diagnoses | Up to 60% budget |
| **P3 — Summarize if Space** | PMH, surgical history, prior visit summaries, lab trends | Summarize and include if budget allows |
| **P4 — Available on Demand** | Full lab panels, imaging reports, family history details | Only via RAG or explicit request |

---

## 14. Prompt Template Enhancement Recommendations

### Temperature & Sampling Defaults

| Parameter | Current (SMR v2) | Recommended | Rationale |
|-----------|:---:|:---:|-----------|
| `temperature` | 0.7 | **0.1** | Deterministic medical output; research shows minimal accuracy difference 0.0-0.4 but determinism matters for clinical docs |
| `max_tokens` | 4,096 | **6,000** | Clinical summaries need 4-6K tokens for department-specific structured output |
| `top_p` | 1.0 | **0.95** | Slightly restrictive nucleus sampling |
| `top_k` (Ollama) | not set | **40** | Limits vocabulary; reduces hallucination |
| `num_ctx` (Ollama) | not set | **65,536** | Must be set explicitly to leverage Med-Gemma's 128K context |

### One-Shot Example Strategy

Research shows one-shot prompting outperforms complex reasoning chains for medical extraction with Med-Gemma. For each department template, add a brief one-shot example showing the expected JSON output shape with realistic (but anonymized) clinical content. This can be included in the system prompt after the JSON schema.

### Prompt Structure Optimization

Restructure all department templates to follow the lost-in-the-middle mitigation ordering:

1. **System prompt prefix** (static, cacheable): Role + department identity + P1 safety block + assessment instructions
2. **Template structure** (static, cacheable): Section definitions + DNA style overlay + JSON schema
3. **Historical context** (dynamic, middle): Pre-summary, prior visit data
4. **Active content** (dynamic, end): Conversation transcript + explicit generation instruction + P1 safety reinforcement

---

## 15. Prioritized Implementation Roadmap

### Tier 1 — Critical (Blocks Core Quality)

| # | Enhancement | Effort | Files Changed |
|---|------------|--------|---------------|
| **E1** | SMR v2: Add optional `response_format` to `GenerateRequest` + map to all 3 providers. Change defaults to `None` with fallback resolution (temperature→0.1, max_tokens→4096). Ensure streaming works end-to-end. | Medium | `models/requests.py`, `providers/ollama.py`, `providers/azure_openai.py`, `providers/bedrock.py`, `api/endpoints/generate.py` |
| **E2** | API Layer: Build prompt assembly logic in `SummaryService` — load template content + hyperparameters + JSON schema, substitute variables, build full payload for SMR v2 | Large | `summary.service.ts`, `summary.processor.ts`, `prompt-resolution.service.ts` |
| **E3** | Add `ProviderContextConfig` + token budget validation before calling SMR | Medium | New utility in `packages/applications/` |
| **E4** | Wire pre-summary ContextItem into final summary via `{pre_summary_text}` | Small | Modify summary service assembly logic |
| **E20** | **Update seed data**: Align all 42 prompt templates with `docs/prompts/prompts/` documentation. Add hyperparameters + optional outputSchema to template config. Add 4 missing departments (Dietetics, Nephrology, Surgical Oncology + Dermatology prompts). | Large | `07-prompt-template.ts`, `04-department.ts` |

### Tier 2 — High (Significant Quality Improvement)

| # | Enhancement | Effort |
|---|------------|--------|
| **E5** | Inject DNA style into prompts (load report → substitute variable) | Medium |
| **E6** | Verify/complete DNA analysis endpoint (BullMQ job → LLM analysis) | Medium |
| **E7** | Enrich 15 pre-summary prompts with section structure and weighting | Medium |
| **E9** | Standardize all templates: add DNA variable, same-day prequel, enhanced guardrails to older templates | Large |
| **E10** | Add FK validation on department prompt IDs | Small |

### Tier 3 — Medium (Quality of Life & Optimization)

| # | Enhancement | Effort |
|---|------------|--------|
| **E11** | Referral context sharing in pre-summary | Large |
| **E12** | Language policy standardization across templates | Medium |
| **E13** | Prompt preview/testing endpoint | Medium |
| **E14** | Draft/Published guard in PromptResolutionService | Small |
| **E15** | Track prompt version in SummaryMeta | Small |
| **E18** | Enable prompt caching (Azure: automatic; Bedrock: add cache_control; Ollama: keep_alive) | Medium |

### Tier 4 — Long-term

| # | Enhancement | Effort |
|---|------------|--------|
| **E16** | Fix `summaryPromptId` SDK type mismatch | Small |
| **E19** | Semantic-topic chunking for transcripts exceeding provider budget | Large |

### Implementation Order

```
Sprint 1: E1 (SMR defaults + response_format + streaming) + E20 (seed data alignment)
Sprint 2: E2 (prompt assembly in API layer) + E4 (wire pre-summary)
Sprint 3: E3 (token budgeting) + E5 (DNA injection) + E10 (FK validation)
Sprint 4: E7 (enrich pre-summary prompts) + E9 (standardize older templates)
Sprint 5: E18 (prompt caching) + E6 (DNA endpoint)
Sprint 6: E13 (preview) + E14 (draft guard) + E15 (version tracking)
```

### E20 — Seed Data Alignment Detail

#### Prompt Template Content: Documentation vs Seed Data

Comparing `docs/prompts/prompts/` against `07-prompt-template.ts`, the seed data content **already matches** the documentation for all 14 department summary templates (#10-#23). The content was extracted from the documentation in TASK-024.

#### What Needs Adding to Seed Data

**A. Per-template hyperparameters and optional outputSchema:**

Each template record needs a `promptConfig` field (or extension of the existing `variables` JsonB) to store:

```typescript
{
    hyperparameters: { temperature: 0.1, max_tokens: 6000, top_p: 0.95 },
    outputSchema: {   // Optional — only for structured output templates
        type: "json_schema",
        schema: { /* department-specific JSON Schema */ },
        strict: true,
    }
}
```

**B. New departments + their prompt templates (from documentation):**

| New Department | Code | Templates to Seed | Source |
|---------------|------|-------------------|--------|
| Dietetics | DIET | New Referral (7 sections) + Follow-Up (5 sections) | `docs/prompts/prompts/dietetics/template.md` |
| Nephrology | NEPH | New Referral (8 sections) + Follow-Up (8 sections) | `docs/prompts/prompts/nephrology/template.md` |
| Surgical Oncology | SONC | New Referral (23 sections) + Follow-Up (13 sections) | `docs/prompts/prompts/surgical-oncology/template.md` |

**C. Dermatology prompts for existing DERM department:**

| Department | Code | Status | Action |
|-----------|------|--------|--------|
| Dermatology | DERM | Exists in DB, no summary prompts | Seed New Referral (16 sections) + Follow-Up (8 sections) from `docs/prompts/prompts/dermatology/template.md` |

**D. JSON schemas to define as outputSchema per department template:**

| Template | Schema Fields | Source |
|----------|:---:|--------|
| Surgery - New Referral | 14 fields | `docs/prompts/prompts/core/json-enforcement.md` |
| Surgery - Revisit | 12 fields | Same |
| Rheumatology - New Referral | 12 fields | Same |
| Rheumatology - Revisit | 10 fields | Same |
| Medicine - New Referral | 10 fields | Same |
| Medicine - Revisit | 10 fields | Same |
| Neurology - New Referral | 8 fields | Same |
| Neurology - Revisit | 14 fields | Same |
| Orthopedics - New Referral | 10 fields | Same |
| Orthopedics - Revisit | 6 fields | Same |
| Hematology - New Referral | 7 fields | Same |
| Hematology - Revisit | 14 fields | Same |
| Breast & Endocrine - New Referral | 14 fields | Same |
| Breast & Endocrine - Revisit | 12 fields | Same |
| Dietetics - New Referral | 7 fields | Same |
| Dietetics - Follow-Up | 5 fields | Same |
| Dermatology - New Referral | 16 fields | Same |
| Dermatology - Follow-Up | 8 fields | Same |
| Nephrology - New Referral | 8 fields | Same |
| Nephrology - Follow-Up | 8 fields | Same |
| Surgical Oncology - New Referral | 23 fields | Same |
| Surgical Oncology - Follow-Up | 13 fields | Same |
| SOAP Summary | 4 fields | Same |

**E. Templates that do NOT get outputSchema (plain text output):**

| Template | Why |
|----------|-----|
| All 15 Pre-Summary prompts | Produce narrative text for context injection |
| DNA Writing Style Analysis | Produces a report, not structured JSON |
| System prompts (Base, ER, Peds, Card, Psych) | System instructions, not output templates |
| JSON Enforcement Note | Appended to system prompt, not a standalone template |
| Corrective Retry Suffix | Retry instruction, not output template |
| Previous Visit System | System instruction |

---

## Appendix A — Full Prompt Template Inventory

### 42 Seeded Templates

| # | Key | Name | Category |
|---|-----|------|----------|
| 1 | `SYSTEM_DEFAULT` | System Default Prompt | SYSTEM |
| 2 | `SOAP_SUMMARY` | SOAP Summary Prompt | SUMMARY |
| 3 | `DNA_ANALYSIS` | DNA Writing Style Analysis Prompt | DNA_ANALYSIS |
| 4 | `CARD_CUSTOM` | Cardiology Department Prompt | CUSTOM |
| 5 | `SMR_SYSTEM_BASE` | SMR System Prompt - Base | SYSTEM |
| 6 | `SMR_SYSTEM_ER` | SMR System Prompt - Emergency Medicine | SYSTEM |
| 7 | `SMR_SYSTEM_PEDS` | SMR System Prompt - Pediatrics | SYSTEM |
| 8 | `SMR_SYSTEM_CARD` | SMR System Prompt - Cardiology | SYSTEM |
| 9 | `SMR_SYSTEM_PSYCH` | SMR System Prompt - Psychiatry | SYSTEM |
| 10 | `SURGERY_NEW_REFERRAL` | Surgery - New Referral | SUMMARY |
| 11 | `SURGERY_REVISIT` | Surgery - Revisit | SUMMARY |
| 12 | `MEDICINE_NEW_REFERRAL` | General Medicine - New Referral | SUMMARY |
| 13 | `MEDICINE_REVISIT` | General Medicine - Revisit | SUMMARY |
| 14 | `BREN_NEW_REFERRAL` | Breast & Endocrine - New Referral | SUMMARY |
| 15 | `BREN_REVISIT` | Breast & Endocrine - Revisit | SUMMARY |
| 16 | `RHEUM_NEW_REFERRAL` | Rheumatology - New Referral | SUMMARY |
| 17 | `RHEUM_REVISIT` | Rheumatology - Revisit | SUMMARY |
| 18 | `ORTH_NEW_REFERRAL` | Orthopedics - New Referral | SUMMARY |
| 19 | `ORTH_REVISIT` | Orthopedics - Revisit | SUMMARY |
| 20 | `NEUR_NEW_REFERRAL` | Neurology - New Referral | SUMMARY |
| 21 | `NEUR_REVISIT` | Neurology - Revisit | SUMMARY |
| 22 | `HEME_NEW_REFERRAL` | Hematology - New Referral | SUMMARY |
| 23 | `HEME_REVISIT` | Hematology - Revisit | SUMMARY |
| 24 | `JSON_ENFORCEMENT` | JSON Enforcement Note | SYSTEM |
| 25 | `CORRECTIVE_RETRY` | Corrective Retry Suffix | SYSTEM |
| 26 | `PRE_SUMMARY_SYSTEM` | Pre-Summary System Prompt | SYSTEM |
| 27 | `PREVIOUS_VISIT_SYSTEM` | Previous Visit Summary System Prompt | SYSTEM |
| 28-42 | `PRE_SUMMARY_*` | 15 department-specific pre-summary prompts | SUMMARY |

---

## Appendix B — Department Seed Data Reference

### 15 Departments with Prompt Assignments

| # | Code | Name | Summary Template | Pre-Summary | New Patient | Revisit |
|---|------|------|:---:|:---:|:---:|:---:|
| 1 | GEN | General Practice | SOAP | ✅ | ✅ (generic) | ✅ (generic) |
| 2 | CARD | Cardiology | SOAP | ✅ | ✅ (custom) | ✅ (SOAP) |
| 3 | RAD | Radiology | Radiology-Report | ✅ | ❌ | ❌ |
| 4 | LAB | Laboratory | Lab-Report | ✅ | ❌ | ❌ |
| 5 | NEUR | Neurology | Neurology-Structured | ✅ | ✅ | ✅ |
| 6 | ORTH | Orthopedics | Orthopedics-Structured | ✅ | ✅ | ✅ |
| 7 | DERM | Dermatology | SOAP | ✅ | ❌ | ❌ |
| 8 | PSYCH | Psychiatry | Psychiatric-Assessment | ✅ | ❌ | ❌ |
| 9 | PEDS | Pediatrics | SOAP | ✅ | ❌ | ❌ |
| 10 | ER | Emergency | ER-Triage | ✅ | ❌ | ❌ |
| 11 | SURG | Surgery | Surgery-Structured | ✅ | ✅ | ✅ |
| 12 | MED | General Medicine | Medicine-Structured | ✅ | ✅ | ✅ |
| 13 | BREN | Breast & Endocrine | BreastEndocrine-Structured | ✅ | ✅ | ✅ |
| 14 | RHEUM | Rheumatology | Rheumatology-Structured | ✅ | ✅ | ✅ |
| 15 | HEME | Hematology | Hematology-Structured | ✅ | ✅ | ✅ |

### Documented but Not Seeded

| Department | Templates in docs/ | Need Created |
|-----------|:---:|--------|
| Dietetics | ✅ (7+5) | Department + prompts |
| Nephrology | ✅ (8+8) | Department + prompts |
| Surgical Oncology | ✅ (23+13) | Department + prompts |

---

## Appendix C — Source File Reference Map

### SMR v2 Service (Enhancement Target)

| File | Key Change Needed |
|------|------------------|
| `apps/smr/src/smr_v2/models/requests.py` | Add `ResponseFormat` model + optional `response_format` field; make `temperature`/`max_tokens`/`top_p` optional with `None` default |
| `apps/smr/src/smr_v2/core/config.py` | Add `DEFAULTS` dict for fallback values (temperature: 0.1, max_tokens: 4096, top_p: 0.95) |
| `apps/smr/src/smr_v2/providers/ollama.py` | Map `response_format` → `format`; resolve defaults from config; return token usage |
| `apps/smr/src/smr_v2/providers/azure_openai.py` | Map `response_format` → Azure `response_format` kwarg; resolve defaults; extract `usage` |
| `apps/smr/src/smr_v2/providers/bedrock.py` | Map `response_format` → `outputConfig.textFormat`; resolve defaults; extract `usage` |
| `apps/smr/src/smr_v2/api/endpoints/generate.py` | Return token usage from provider responses; ensure SSE streaming path works |

### NestJS Application Layer (Enhancement Target)

| File | Key Change Needed |
|------|------------------|
| `packages/applications/src/services/consultation/summary/summary.service.ts` | Load template + hyperparameters + outputSchema; build full SMR payload; support streaming |
| `packages/applications/src/services/consultation/summary/summary.processor.ts` | Same assembly in async path |
| `packages/applications/src/services/consultation/prompt/prompt-resolution.service.ts` | Return template content + config alongside resolution result |
| `packages/agentic-sdk-v2/src/utils/promptUtils.ts` | Already has substitution utils — reuse server-side |

### Database Seeds (Enhancement Target)

| File | Key Change Needed |
|------|------------------|
| `packages/database/src/prisma/db_main/seed/04-department.ts` | Add Dietetics, Nephrology, Surgical Oncology departments |
| `packages/database/src/prisma/db_main/seed/07-prompt-template.ts` | Add templates for 4 new departments; add `promptConfig` (hyperparameters + outputSchema) to all templates |

### Prisma Schema (Enhancement Target — may need migration)

| File | Key Change Needed |
|------|------------------|
| `packages/database/src/prisma/db_main/prompt.prisma` | Add optional `promptConfig JsonB` field to `PromptTemplate` model for hyperparameters + outputSchema |

---

## Appendix D — Research Sources

### Med-Gemma

- Google MedGemma Model Card (developers.google.com/health-ai-developer-foundations/medgemma/model-card)
- MedGemma Technical Report (arXiv 2507.05201)
- Ollama MedGemma 1.5 listing (ollama.com/MedAIBase/MedGemma1.5)
- Clinical Note Summarization Benchmark (Springer, doi: 10.1007/s41666-025-00221-9)

### Structured Output

- Ollama Structured Outputs (ollama.com/blog/structured-outputs)
- Azure OpenAI Structured Outputs (learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/structured-outputs)
- AWS Bedrock Structured Outputs (aws.amazon.com/blogs/machine-learning/structured-outputs-on-amazon-bedrock)
- Claude Structured Outputs (docs.claude.com/en/docs/build-with-claude/structured-outputs)
- Cross-Provider Comparison (glukhov.org, Oct 2025)

### Context Length & Token Management

- Long Context Medical QA (arXiv 2510.18691)
- TRACE: Temporal Reasoning via Agentic Context Evolution (arXiv 2602.12833)
- Context Engineering for AI Agents (Anthropic, 2025)
- BriefContext Map-Reduce (npj Digital Medicine, 2025)
- Azure OpenAI Prompt Caching (learn.microsoft.com)
- AWS Bedrock Prompt Caching (docs.aws.amazon.com)
- Ollama Context Length & KV-Cache (docs.ollama.com)
- ConTextual Framework (MLHC 2025)

### Medical LLM Temperature & Hallucination

- Temperature Impact on Clinical Tasks (medRxiv 2024.07.22.24310824)
- Clinical LLM Hallucination Rates (Nature, doi: 10.1038/s43856-025-01021-3)
- Lost-in-the-Middle Mitigations Survey (arXiv 2511.13900)

---

## Related Documentation

- [User Stories (knowledge/06_USER_STORIES.md)](../../../knowledge/06_USER_STORIES.md)
- [API List (knowledge/05_API_LIST.md)](../../../knowledge/05_API_LIST.md)
- [Technical Architecture (knowledge/02_TECHNICAL_ARCHITECTURE.md)](../../../knowledge/02_TECHNICAL_ARCHITECTURE.md)
- [Prompts Documentation (docs/prompts/README.md)](../../prompts/README.md)
- [TASK-024 — Prompt Template Database Seed](../TASK-024-Prompt-Template-Database-Seed/README.md)
- [TASK-025 — Department, DNA & Prompt Refinement](../TASK-025-Department-DNA-Prompt-Refinement/README.md)
- [SDK-206 — SDK V2 Gap Analysis](../SDK-206-SDK-V2-Gap-Analysis/README.md)
- [QA-004 — Admin Departments & Prompts E2E](../QA-004-Admin-Departments-Prompts-E2E/README.md)
- [TASK-218 — Admin Panel E2E Gaps](../TASK-218-Admin-Panel-E2E-Gaps/README.md)

---

## Change History

### Update 1 — 2026-02-24: Architecture Clarifications & Seed Data Alignment

**Changes made based on user feedback:**

1. **Hyperparameters are per-template, not hardcoded in SMR**
   - Updated Architecture Baseline (Section 2) to clarify that temperature, max_tokens, top_p, and other hyperparameters are stored per prompt template in the database
   - The API layer reads these from the template record and includes them in the SMR v2 request
   - SMR v2 uses sensible defaults **only** when values are not provided in the request body

2. **SMR v2 default behavior clarified**
   - SMR v2 does NOT hardcode temperature=0.7 or max_tokens=4096
   - Instead, `GenerateRequest` fields are `Optional[float] = None` / `Optional[int] = None`
   - Fallback defaults applied in a resolver: temperature→0.1, max_tokens→4096, top_p→0.95
   - When the API layer sends values from the template config, those override defaults entirely

3. **Streaming is a core capability**
   - Added streaming requirement to Architecture Baseline
   - SMR v2 already has SSE infrastructure — this must be preserved
   - API layer must support `stream: true` parameter from client SDK
   - Token usage metadata returned in final stream event

4. **Structured JSON output is optional and per-template**
   - Not all templates require structured output (e.g., pre-summaries produce narrative text)
   - JSON schema is stored as optional `outputSchema` alongside each template's hyperparameters
   - SMR v2 maps `response_format` to provider-native APIs only when present
   - Updated E1 and Section 5 to reflect this

5. **New enhancement E20 — Seed Data Alignment**
   - Added comprehensive plan for aligning seed data with `docs/prompts/prompts/` documentation
   - Covers: per-template hyperparameters, optional outputSchema, 4 new department templates
   - Merged former E8 into E20 for a single cohesive seed update plan

**Files modified:** TASK-222 README.md (this document)

---

### Update 2 — 2026-02-24: TDD Implementation of E1 + E2

**Implemented E1 (SMR v2 Enhancements) using strict TDD (Red-Green-Refactor):**

1. **`ResponseFormat` model** — New Pydantic model with `type: Literal["text", "json", "json_schema"]`, optional `json_schema`, and `strict` flag
2. **`GenerateRequest` updated** — `temperature`, `max_tokens`, `top_p` changed from hardcoded defaults to `Optional[float|int] = None`; added `response_format: ResponseFormat | None = None`
3. **`resolve_request_defaults()`** — New utility in `core/defaults.py` that applies defaults (temp→0.1, max_tokens→4096, top_p→0.95) only when values are None
4. **All 3 providers updated** (Ollama, Azure OpenAI, Bedrock):
   - Use `resolve_request_defaults()` for None hyperparameters
   - Map `response_format` to provider-native APIs (Ollama `format`, Azure `response_format`, Bedrock `toolConfig`)
   - Return `tuple[str, dict]` (content, usage) instead of plain string
   - Extract and return token usage from provider responses
5. **Generate endpoint updated** — Handles tuple returns, includes `TokenUsage` in responses
6. **All existing tests updated** to match new tuple return type

**Implemented E2 (Prompt Assembly) using strict TDD:**

1. **`PromptAssemblyService`** — New NestJS service that:
   - Resolves template via `PromptResolutionService`
   - Loads template content + hyperparameters + JSON schema from DB
   - Substitutes variables (`{conversation_language}`, `{style_DNA_*}`, `{pre_summary_text}`, `{same_day_prequel_summary}`)
   - Builds complete payload with hyperparameters, response_format, and system prompt
2. **`promptUtils` test coverage** — Added 28 tests covering `substitutePromptVariables`, `extractPromptVariables`, `validatePromptVariables` with edge cases

**Test Results:**
- **Python (SMR v2)**: 360 tests passed, 97% coverage
- **TypeScript (NestJS + SDK)**: 816 tests passed, 23 test files

**New files created:**
- `apps/smr/src/smr_v2/core/defaults.py`
- `apps/smr/src/smr_v2/tests/unit/test_request_models_e1.py` (32 tests)
- `apps/smr/src/smr_v2/tests/unit/test_defaults_e1.py` (14 tests)
- `apps/smr/src/smr_v2/tests/unit/test_providers_e1.py` (20 tests)
- `apps/smr/src/smr_v2/tests/unit/test_generate_endpoint_e1.py` (9 tests)
- `packages/applications/src/services/consultation/prompt/prompt-assembly.service.ts`
- `packages/applications/src/services/consultation/prompt/__tests__/prompt-assembly.service.test.ts` (15 tests)
- `packages/agentic-sdk-v2/src/utils/__tests__/promptUtils.test.ts` (28 tests)

**Files modified:**
- `apps/smr/src/smr_v2/models/requests.py` — ResponseFormat + optional hyperparams
- `apps/smr/src/smr_v2/providers/ollama.py` — defaults + response_format + token usage
- `apps/smr/src/smr_v2/providers/azure_openai.py` — defaults + response_format + token usage
- `apps/smr/src/smr_v2/providers/bedrock.py` — defaults + response_format + token usage
- `apps/smr/src/smr_v2/api/endpoints/generate.py` — tuple return handling + usage
- `apps/smr/src/smr_v2/main.py` — Fixed provider constructor calls
- `apps/smr/src/smr_v2/tests/unit/test_models.py` — Updated defaults assertion
- `apps/smr/src/smr_v2/tests/unit/test_ollama_provider.py` — Updated to tuple return
- `apps/smr/src/smr_v2/tests/unit/test_azure_provider.py` — Updated to tuple return
- `apps/smr/src/smr_v2/tests/unit/test_bedrock_provider.py` — Updated to tuple return
- `apps/smr/src/smr_v2/tests/unit/test_provider_edge_cases.py` — Updated to tuple return
- `apps/smr/src/smr_v2/tests/unit/test_api_endpoints.py` — Updated mock return
- `apps/smr/src/smr_v2/tests/unit/test_lifespan.py` — Fixed sentinel registry
- `packages/applications/src/services/consultation/prompt/index.ts` — Added export
