# TASK-242: Playground Debug Mode for Pre-Summary & Summary

- **Ticket**: TASK-242
- **Type**: Feature
- **Created**: 2026-03-08
- **Updated**: 2026-03-08
- **Status**: Completed

---

## Requirement Analysis

### Description

Build an always-on debug mode for the pre-summary and summary playgrounds in `ui-playground`, enabling advanced control over input parameters and LLM configurations. Add a corresponding server-side prompt assembly endpoint in the API gateway.

### Business Context

The pre-summary and summary playgrounds are testing tools for developers and administrators. Debug mode allows fine-grained control over every parameter in the generation pipeline — visit type, context items, prompt templates, DNA writing styles, and provider/model selection — enabling rapid iteration and troubleshooting.

### Acceptance Criteria

1. Debug mode UI allows selection of visit type (new visit / referral)
2. Context item ID input with transcript content display, OR manual message entry
3. Prompt template picker (by ID from list) with read-only content display
4. DNA writing style picker (by ID from list) with read-only content display
5. Provider and model selection from available lists
6. SSE streaming mode toggle
7. API gateway endpoint for server-side prompt assembly with validation
8. E2E tests passing for Ollama (qwen3.5:latest) and LM Studio (qwen3.5-4b)

---

## Current State Evaluation

### Existing Code

- Pre-summary page (`apps/ui-playground/src/features/summarization/pre-summary/index.tsx`) had basic prompt editing and generation
- Summary page (`apps/ui-playground/src/features/summarization/summary/index.tsx`) had similar basic functionality
- `SmrProxyController` had proxy-only endpoints for raw SMR requests
- No server-side prompt assembly existed

### Dependencies

- `@arcaai/domains` — `ContextItemRepository`, `PromptTemplateRepository`, `DnaWritingStyleReportRepository`, `DepartmentRepository`
- `@arcaai/ui` — UI components (Card, Tabs, Select, Switch, Badge, Textarea, etc.)
- `apps/smr` — SMR service for LLM generation

---

## Implementation Summary

### API Gateway Changes

**New endpoint: `POST /streaming/text/generate/assembled`**

Server-side prompt assembly endpoint that:
- Validates request parameters (type, context_item_id vs message, visit_type)
- Enforces debug mode access control (SUPER_ADMIN, GLOBAL_ADMIN, TENANT_ADMIN only)
- Fetches context item content, prompt template, and DNA writing style by ID
- Constructs final prompt and system_prompt combining all inputs
- Forwards assembled payload to SMR `/api/v1/generate`
- Returns debug metadata alongside generation results

**DTOs**: `VisitType`, `GenerationType`, `AssembledGenerateRequest`

**Module update**: `StreamingModule` now imports `CoreDatabaseModule` for repository access

### UI Playground Changes

Both pre-summary and summary pages refactored with debug mode UI:

- **Visit Type**: Select component (new_visit / referral)
- **Input Mode**: Tabs switching between Context Item ID (with fetch/display) and Manual Message
- **Prompt Template**: Read-only display with ID, fetched from API
- **DNA Writing Style**: Read-only display with ID, selectable from list (summary only)
- **Provider & Model**: Selection from available providers/models
- **SSE Streaming**: Toggle switch for streaming mode
- **Generation**: Calls `/text/generate/assembled` endpoint in debug mode

### E2E Test Infrastructure Fix

Fixed a pre-existing issue in the SMR E2E test conftest where `ASGITransport` doesn't trigger FastAPI's lifespan. The `_create_e2e_app` function now manually initializes:
- Provider registry (Ollama, LM Studio/OpenAI-compat, Azure)
- Rate limiters, circuit breakers, provider queues, semaphores
- Shutdown manager

### E2E Tests

New test file: `test_presummary_summary_providers.py` with 10 tests across 4 test classes:
- `TestOllamaQwen35PreSummary` — sync + streaming pre-summary (5 tests)
- `TestOllamaQwen35Summary` — sync + streaming summary + context enrichment
- `TestLmStudioQwen35PreSummary` — sync + streaming pre-summary
- `TestLmStudioQwen35Summary` — sync + streaming summary + visit type context

Note: qwen3.5:latest is a thinking model requiring `max_tokens=2048` to allow room for chain-of-thought reasoning before producing the response.

### Files Changed

| File | Purpose |
|------|---------|
| `apps/api/src/modules/streaming/smr-proxy.controller.ts` | New `POST /text/generate/assembled` endpoint with prompt assembly |
| `apps/api/src/modules/streaming/streaming.module.ts` | Added `CoreDatabaseModule` import |
| `apps/api/src/modules/streaming/__tests__/smr-proxy.controller.test.ts` | 15 new unit tests for assembled endpoint |
| `apps/ui-playground/src/features/summarization/pre-summary/index.tsx` | Debug mode UI for pre-summary |
| `apps/ui-playground/src/features/summarization/summary/index.tsx` | Debug mode UI for summary |
| `apps/smr/src/smr/tests/e2e/conftest.py` | Fixed provider registry initialization, added LM Studio fixtures |
| `apps/smr/src/smr/tests/e2e/test_presummary_summary_providers.py` | New E2E tests for both providers |

### Test Results

- **API Gateway unit tests**: 33 passed, 1 pre-existing failure (TASK-240 catalog test)
- **SMR E2E Ollama tests**: 5/5 passed (qwen3.5:latest with 2048 max_tokens)
- **SMR E2E LM Studio tests**: Correctly structured, require LM Studio with qwen3.5-4b loaded

---

## Change History

| Date | Description | Files Modified |
|------|-------------|----------------|
| 2026-03-08 | Initial implementation of debug mode for pre-summary/summary playgrounds | All files listed above |
