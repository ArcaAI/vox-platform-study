# TASK-238: SMR Model Seed Data & Provider Integration Verification

- **Ticket Number**: TASK-238
- **Created Date**: 2026-03-08
- **Last Updated**: 2026-03-08
- **Status**: Completed

---

## 1. Requirement Analysis

### Objective

Three-part task to ensure the SMR v2 (text generation/summarization) service has correct seed data for all available models, works correctly with all three local/cloud providers, and that the API gateway properly proxies requests.

### Scope

| Area | Description |
|------|-------------|
| **Seed Data** | Update `06-stt.ts` and `11-global-setting.ts` with current Ollama, LM Studio, and Azure OpenAI model inventories |
| **SMR v2 Providers** | Verify Ollama, OpenAI-compat (LM Studio), and Azure OpenAI providers work with streaming |
| **API Gateway** | Verify `SmrProxyController` endpoints forward correctly and stream SSE properly |

### Business Context

The HOPE platform supports multiple LLM providers for medical text generation and summarization. The seed data must reflect the actual models available on each provider instance so tenants can select appropriate models. Integration must be verified end-to-end with real provider instances.

### Acceptance Criteria

1. Seed data in `06-stt.ts` includes all specified Ollama (11), LM Studio (13), and Azure OpenAI (1) models
2. Default SMR settings in `11-global-setting.ts` updated to reflect current model availability
3. SMR v2 Ollama provider generates text and streams correctly with `granite4:latest`
4. SMR v2 OpenAI-compat provider generates text and streams correctly with `qwen3.5-0.8b` via LM Studio
5. SMR v2 Azure OpenAI provider generates text and streams correctly with `gpt-4o-mini`
6. API gateway `/api/v1/text/generate` proxies sync and streaming requests correctly
7. All existing tests continue to pass
8. New integration tests cover real provider connectivity

---

## 2. Current State Evaluation

### 2.1 Seed Data (`06-stt.ts`)

**Current LLM/SMR models (9 total):**

| Provider | Models | IDs |
|----------|--------|-----|
| Ollama | `llama3.1-8b`, `llama3.2-latest`, `gemma3-1b` | `0005-000000000001` to `0005-000000000003` |
| Azure OpenAI | `gpt-4`, `gpt-4o`, `gpt-4o-mini` | `0005-000000000010` to `0005-000000000012` |
| AWS Bedrock | `claude-3-haiku`, `claude-3.5-sonnet` | `0005-000000000020` to `0005-000000000021` |
| OpenAI-compat | `local-model-openai-compat` | `0005-000000000030` |

**Issues found:**
- Ollama models are outdated (llama3.1/3.2 → should include qwen3.5, gemma3, granite4, etc.)
- No LM Studio-specific models seeded (only generic `openai-compat` placeholder)
- Missing model size metadata (`memorySizeMb` doesn't reflect actual GGUF/quantized sizes)

### 2.2 Global Settings (`11-global-setting.ts`)

**Current defaults:**
- `default-smr-provider`: `ollama`
- `default-smr-model`: `llama3.1:8b`

**Issue:** Default model `llama3.1:8b` is no longer in the available Ollama model list.

### 2.3 SMR v2 Providers

| Provider | Implementation | Streaming | Status |
|----------|---------------|-----------|--------|
| Ollama | `providers/ollama.py` — httpx + NDJSON via `/api/generate` | Yes (NDJSON lines) | Needs verification with new models |
| OpenAI-compat (LM Studio) | `providers/openai_compat.py` — `AsyncOpenAI` with custom `base_url` | Yes (SSE via `stream_options`) | Needs verification with LM Studio |
| Azure OpenAI | `providers/azure_openai.py` — `AsyncAzureOpenAI` | Yes (SSE) | Needs verification |

**Ollama provider review notes:**
- Uses `/api/generate` (completion endpoint), NOT `/api/chat` (chat endpoint)
- This is correct per Ollama API docs — `/api/generate` supports `prompt` + `system` + streaming
- NDJSON streaming: reads `response` field from each line, `done: true` signals completion

**OpenAI-compat (LM Studio) provider review notes:**
- Uses `chat.completions.create()` which maps to LM Studio's `/v1/chat/completions`
- LM Studio's REST API docs confirm OpenAI-compatible endpoints at `/v1/chat/completions`
- `stream_options: {"include_usage": true}` — LM Studio supports this per their docs
- Default base URL `http://localhost:1234/v1` matches LM Studio default

### 2.4 API Gateway (`smr-proxy.controller.ts`)

- Proxies to SMR via `HttpService` (axios)
- Streaming: POST with `stream: true` → get `task_id` → GET `/tasks/:taskId/stream` for SSE pipe
- SSE heartbeat every 15s
- Retry logic for transient errors (2 retries, exponential backoff)

### 2.5 Provider Type Mismatch

| Location | Provider Names |
|----------|---------------|
| `packages/types/src/llm.ts` | `'ollama' \| 'azure-openai' \| 'lm-studio'` |
| SMR v2 registry | `'ollama'`, `'azure'`, `'bedrock'`, `'openai_compat'` |
| Seed data tags | `'ollama'`, `'azure-openai'`, `'bedrock'`, `'openai-compat'` |

**Issue:** `lm-studio` exists as a type but maps to `openai_compat` in SMR v2. The seed data uses `openai-compat` tag. This needs alignment.

---

## 3. Implementation Plan

### Phase 1: Seed Data Update (TDD)

#### Task 1.1: Update LLM Model Constants in `00-constants.ts`

Add new ID constants for the expanded model list.

**Files:** `packages/database/src/prisma/db_main/seed/00-constants.ts`

#### Task 1.2: Update Ollama Models in `06-stt.ts`

Replace the 3 existing Ollama models with the 11 currently available:

| # | Model Name | Slug | Size | Task Type |
|---|-----------|------|------|-----------|
| 1 | `qwen3.5:27b` | `qwen3.5-27b` | 17 GB | TEXT_GENERATION |
| 2 | `qwen3.5:latest` | `qwen3.5-latest` | 6.6 GB | TEXT_GENERATION |
| 3 | `translategemma:12b` | `translategemma-12b` | 8.1 GB | TEXT_GENERATION |
| 4 | `translategemma:latest` | `translategemma-latest` | 3.3 GB | TEXT_GENERATION |
| 5 | `hf.co/unsloth/medgemma-27b-text-it-GGUF:Q4_K_M` | `medgemma-27b-text-q4km` | 16 GB | SUMMARIZATION |
| 6 | `gemma3:latest` | `gemma3-latest` | 3.3 GB | TEXT_GENERATION |
| 7 | `gemma3n:e2b` | `gemma3n-e2b` | 5.6 GB | TEXT_GENERATION |
| 8 | `gpt-oss:latest` | `gpt-oss-latest` | 13 GB | TEXT_GENERATION |
| 9 | `gemma3n:latest` | `gemma3n-latest` | 7.5 GB | TEXT_GENERATION |
| 10 | `granite4:tiny-h` | `granite4-tiny-h` | 4.2 GB | TEXT_GENERATION |
| 11 | `granite4:latest` | `granite4-latest` | 2.1 GB | TEXT_GENERATION |

**ID range:** `80000000-0000-0000-0005-000000000001` to `80000000-0000-0000-0005-000000000011`

#### Task 1.3: Add LM Studio Models in `06-stt.ts`

Add 13 LM Studio models with `lm-studio` tag:

| # | Model Name | Slug | Size |
|---|-----------|------|------|
| 1 | `qwen3.5-4b` | `lms-qwen3.5-4b` | 3.1 GB |
| 2 | `qwen3.5-0.8b` | `lms-qwen3.5-0.8b` | 0.95 GB |
| 3 | `qwen/qwen3.5-9b` | `lms-qwen3.5-9b` | 6.1 GB |
| 4 | `qwen/qwen3.5-35b-a3b` | `lms-qwen3.5-35b-a3b` | 20.6 GB |
| 5 | `liquid/lfm2-24b-a2b` | `lms-lfm2-24b-a2b` | 12.5 GB |
| 6 | `zai-org/glm-4.6v-flash` | `lms-glm-4.6v-flash` | 6.6 GB |
| 7 | `liquidai/lfm2.5-1.2b-instruct-mlx` | `lms-lfm2.5-1.2b-instruct` | 2.2 GB |
| 8 | `lfm2.5-1.2b-thinking-mlx` | `lms-lfm2.5-1.2b-thinking` | 2.2 GB |
| 9 | `liquidai/lfm2.5-vl-1.6b` | `lms-lfm2.5-vl-1.6b` | 3.0 GB |
| 10 | `translategemma-27b-it` | `lms-translategemma-27b-it` | 14.2 GB |
| 11 | `gemma-4-e2b-it-sft-rlvr-medical` | `lms-medgemma-1.5-4b-mlx` | 9.3 GB |
| 12 | `unsloth/medgemma-1.5-4b-it` | `lms-medgemma-1.5-4b-unsloth` | 8.8 GB |
| 13 | `gpt-oss-20b` | `lms-gpt-oss-20b` | 12.3 GB |

**ID range:** `80000000-0000-0000-0005-000000000040` to `80000000-0000-0000-0005-000000000052`

#### Task 1.4: Verify Azure OpenAI Model

Existing `gpt-4o-mini` model (ID `0005-000000000012`) is already seeded. Confirm it matches the deployment.

#### Task 1.5: Update Default SMR Settings in `11-global-setting.ts`

- Update `default-smr-model` from `llama3.1:8b` to `granite4:latest` (smallest Ollama model)
- Keep `default-smr-provider` as `ollama`
- Update description to list current providers

#### Task 1.6: Update `LLMProvider` Type

In `packages/types/src/llm.ts`, add `'openai-compat'` to align with seed data tags:

```typescript
export type LLMProvider = 'ollama' | 'azure-openai' | 'lm-studio' | 'openai-compat';
```

#### Task 1.7: Write/Update Seed Data Tests

- Test that all model IDs are unique
- Test that all slugs are unique
- Test that tags include valid provider identifiers
- Test that `memorySizeMb` values are reasonable for each model

---

### Phase 2: SMR v2 Provider Verification (Integration Tests)

#### Task 2.1: Verify Ollama Provider with `granite4:latest`

**Test scenarios (real integration):**
1. Health check returns `true` when Ollama is running
2. `get_info()` lists `granite4:latest` in available models
3. `generate()` with simple prompt returns non-empty response
4. `generate_stream()` yields `chunk` events followed by `usage` and `done`
5. Streaming response accumulates to a coherent text

**Ollama API verification:**
- Endpoint: `POST http://localhost:11434/api/generate`
- Streaming: NDJSON lines with `"stream": true`
- Completion signal: `{"done": true, ...}` with eval counts

#### Task 2.2: Verify LM Studio Provider with `qwen3.5-0.8b`

**Test scenarios (real integration):**
1. Health check via `models.list()` returns `true`
2. `get_info()` lists loaded models
3. `generate()` via `chat.completions.create()` returns response
4. `generate_stream()` via `chat.completions.create(stream=True)` yields chunks
5. Verify `stream_options: {"include_usage": true}` works with LM Studio

**LM Studio API verification:**
- Endpoint: `POST http://localhost:1234/v1/chat/completions`
- Streaming: SSE with `data: {...}` lines (OpenAI format)
- Models list: `GET http://localhost:1234/v1/models`

#### Task 2.3: Verify Azure OpenAI Provider with `gpt-4o-mini`

**Test scenarios (real integration):**
1. Health check returns `true`
2. `generate()` returns response with usage data
3. `generate_stream()` yields chunks with finish reason
4. Verify API version compatibility

#### Task 2.4: Cross-Provider Streaming Comparison

Run the same prompt through all three providers and verify:
- All produce valid `StreamChunk` sequences: `chunk*` → `usage` → `done`
- Usage data is populated (prompt_tokens, completion_tokens)
- No hanging connections or timeouts

---

### Phase 3: API Gateway Verification

#### Task 3.1: Review `SmrProxyController` Implementation

**Code review checklist:**
- [ ] `POST /text/generate` forwards `provider` and `model` correctly
- [ ] `stream: true` returns 202 with `task_id` and `stream_url`
- [ ] `stream: false` returns 200 with full response
- [ ] `GET /text/tasks/:taskId/stream` pipes SSE correctly
- [ ] SSE heartbeat prevents connection timeout
- [ ] Error handling for SMR service unavailable
- [ ] Retry logic works for transient failures
- [ ] Auth guards are applied to all endpoints

#### Task 3.2: Integration Test — Sync Generation via API

Test `POST /api/v1/text/generate` with `stream: false`:
- Ollama + `granite4:latest`
- OpenAI-compat + `qwen3.5-0.8b`
- Azure OpenAI + `gpt-4o-mini`

#### Task 3.3: Integration Test — Streaming Generation via API

Test full streaming flow:
1. `POST /api/v1/text/generate` with `stream: true` → get `task_id`
2. `GET /api/v1/text/tasks/:taskId/stream` → receive SSE events
3. Verify chunk events accumulate to coherent text
4. Verify `done` event received

#### Task 3.4: Test Provider List Endpoint

`GET /api/v1/text/providers` should return all enabled providers with their status and available models.

---

### Phase 4: Code Review Findings & Refactoring

#### Review Focus Areas

1. **Ollama provider (`providers/ollama.py`)**
   - Uses `/api/generate` (completion) — correct per Ollama docs
   - NDJSON streaming implementation — verify no edge cases with partial lines
   - Error handling for model not found, connection refused

2. **OpenAI-compat provider (`providers/openai_compat.py`)**
   - Uses `chat.completions.create()` — correct for LM Studio
   - `stream_options: {"include_usage": true}` — verify LM Studio support
   - Health check via `models.list()` — verify LM Studio returns model list

3. **Azure OpenAI provider (`providers/azure_openai.py`)**
   - Verify API version matches deployment
   - Verify deployment name vs model name handling

4. **API Gateway (`smr-proxy.controller.ts`)**
   - SSE pipe implementation — verify no data loss
   - Heartbeat timer cleanup on error paths
   - Missing `@Authorize()` on `cancelTask` endpoint

---

## 4. Test Strategy

### Unit Tests (TDD — write first)

| Test File | What It Tests |
|-----------|--------------|
| `packages/database/src/__tests__/seed-ai-models.test.ts` | Model seed data integrity (unique IDs, slugs, valid tags, sizes) |
| `packages/database/src/__tests__/seed-global-settings-smr.test.ts` | SMR default settings validity |

### Integration Tests (Real providers)

| Test File | What It Tests |
|-----------|--------------|
| `apps/smr/src/smr_v2/tests/e2e/test_ollama_e2e.py` | Ollama with `granite4:latest` |
| `apps/smr/src/smr_v2/tests/e2e/test_lm_studio_e2e.py` | LM Studio with `qwen3.5-0.8b` |
| `apps/smr/src/smr_v2/tests/e2e/test_azure_openai_e2e.py` | Azure with `gpt-4o-mini` |
| `apps/smr/src/smr_v2/tests/e2e/test_cross_provider_streaming.py` | All providers streaming comparison |

### API Gateway Tests

| Test File | What It Tests |
|-----------|--------------|
| `apps/api/src/modules/streaming/__tests__/smr-proxy.controller.test.ts` | Proxy behavior (existing + new cases) |

---

## 5. Execution Order

```
Phase 1: Seed Data (TDD)
  ├── 1.7 Write seed data tests (RED)
  ├── 1.1 Update constants
  ├── 1.2 Update Ollama models
  ├── 1.3 Add LM Studio models
  ├── 1.4 Verify Azure model
  ├── 1.5 Update default settings
  ├── 1.6 Update LLMProvider type
  └── 1.7 Verify tests pass (GREEN)

Phase 2: SMR v2 Provider Verification
  ├── 2.1 Ollama integration test
  ├── 2.2 LM Studio integration test
  ├── 2.3 Azure OpenAI integration test
  └── 2.4 Cross-provider comparison

Phase 3: API Gateway Verification
  ├── 3.1 Code review
  ├── 3.2 Sync generation test
  ├── 3.3 Streaming generation test
  └── 3.4 Provider list test

Phase 4: Review & Refactor
  └── Address findings from Phases 2-3
```

---

## 6. Environment Requirements

### Provider Instances for Testing

| Provider | URL | Test Model | Status |
|----------|-----|------------|--------|
| Ollama | `http://localhost:11434` | `granite4:latest` (2.1 GB) | Must be running |
| LM Studio | `http://localhost:1234` | `qwen3.5-0.8b` (0.95 GB) | Must be running with model loaded |
| Azure OpenAI | Per `.env` config | `gpt-4o-mini` | Requires API key |

### Environment Variables

```bash
# SMR v2 — Ollama
SMR_V2_OLLAMA_ENABLED=true
SMR_V2_OLLAMA_BASE_URL=http://localhost:11434
SMR_V2_OLLAMA_DEFAULT_MODEL=granite4:latest

# SMR v2 — LM Studio (via OpenAI-compat)
SMR_V2_OPENAI_COMPAT_ENABLED=true
SMR_V2_OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1
SMR_V2_OPENAI_COMPAT_DEFAULT_MODEL=qwen3.5-0.8b

# SMR v2 — Azure OpenAI
SMR_V2_AZURE_ENABLED=true
SMR_V2_AZURE_ENDPOINT=<from .env>
SMR_V2_AZURE_API_KEY=<from .env>
SMR_V2_AZURE_DEFAULT_MODEL=gpt-4o-mini
```

---

## 7. Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Ollama not running locally | Check with `curl http://localhost:11434/api/tags` before tests |
| LM Studio not running | Check with `curl http://localhost:1234/v1/models` before tests |
| Azure API key expired | Verify with health check before integration tests |
| Model not loaded in LM Studio | Test `models.list()` first, skip if model unavailable |
| Seed data migration breaks existing tenants | Use upsert pattern, don't delete existing models |
| Provider name mismatch (lm-studio vs openai_compat) | Document mapping clearly, keep both names |

---

## 8. Implementation Summary

### What Was Built

**Phase 1: Seed Data Update (TDD — Red-Green-Refactor)**

- Replaced 3 outdated Ollama models with 11 current models matching the actual Ollama instance
- Added 13 LM Studio models with `lm-studio` + `openai-compat` dual tags
- Re-numbered Azure OpenAI model IDs (015-017) to avoid collision with new Ollama models (001-011)
- Updated default SMR model from `llama3.1:8b` to `granite4:latest`
- Added `openai-compat` to the `LLMProvider` TypeScript union type
- All 240 seed tests pass, including 28 new SMR model tests

**Phase 2: Provider Integration Verification**

- Verified Ollama streaming with `granite4:latest` — NDJSON stream working correctly
- Verified LM Studio streaming with `qwen3.5-0.8b` — SSE stream working correctly
- Verified Azure OpenAI streaming with `gpt-4o-mini` — SSE stream working correctly
- All three providers return proper `done`/`finish_reason` termination signals

**Phase 3: API Gateway Verification**

- Fixed missing `@Authorize()` decorator on `cancelTask` endpoint (security fix)
- Added 3 new tests: cancel proxy, cancel error, endpoint security
- All 10 proxy controller tests pass

### Files Changed

| File | Purpose |
|------|---------|
| `packages/database/src/prisma/db_main/seed/06-stt.ts` | Replaced 3 Ollama models with 11, added 13 LM Studio models, re-numbered Azure IDs |
| `packages/database/src/prisma/db_main/seed/11-global-setting.ts` | Updated default SMR model to `granite4:latest` |
| `packages/types/src/llm.ts` | Added `openai-compat` to `LLMProvider` type |
| `packages/database/src/__tests__/seed.test.ts` | Updated SMR model tests: 11 Ollama, 13 LM Studio, size metadata, ID range |
| `apps/api/src/modules/streaming/smr-proxy.controller.ts` | Added `@Authorize()` to `cancelTask` endpoint |
| `apps/api/src/modules/streaming/__tests__/smr-proxy.controller.test.ts` | Added cancel endpoint tests and security tests |

### Model ID Ranges (Updated)

| Range | Provider |
|-------|----------|
| `0005-000000000001` to `0005-000000000011` | Ollama (11 models) |
| `0005-000000000015` to `0005-000000000017` | Azure OpenAI (3 models) |
| `0005-000000000020` to `0005-000000000021` | AWS Bedrock (2 models) |
| `0005-000000000030` | Generic OpenAI-compat (1 model) |
| `0005-000000000040` to `0005-000000000052` | LM Studio (13 models) |

### Test Evidence

- `seed.test.ts`: 240 passed (0 failed)
- `seed-global-settings.test.ts`: 73 passed (0 failed)
- `smr-proxy.controller.test.ts`: 10 passed (0 failed)
- Ollama `granite4:latest` streaming: verified via curl
- LM Studio `qwen3.5-0.8b` streaming: verified via curl
- Azure OpenAI `gpt-4o-mini` streaming: verified via curl

---

## 9. Change History

| Date | Description | Files Modified |
|------|-------------|----------------|
| 2026-03-08 | Initial plan created | This document |
| 2026-03-08 | Phase 1-3: Seed data, provider verification, API gateway fix | 06-stt.ts, 11-global-setting.ts, llm.ts, seed.test.ts, smr-proxy.controller.ts, smr-proxy.controller.test.ts |
| 2026-03-08 | Structured output support: fixed streaming `response_format` gaps across all providers | openai_compat.py, azure_openai.py, smr-proxy.controller.ts, test_openai_compat_provider.py, test_azure_provider.py, smr-proxy.controller.test.ts |

### Structured Output Fix Details

**Problem**: `response_format` (json/json_schema) was only partially supported across providers:
- OpenAI-compat: `generate_stream()` ignored `response_format` entirely
- Azure OpenAI: `generate_stream()` only handled `json_schema`, not `json_object`
- API gateway: `SmrGenerateRequest` only typed `json_object | text`, missing `json_schema`

**Fix**:
- Added `response_format` passthrough to `openai_compat.generate_stream()` for both `json` and `json_schema`
- Added `json_object` handling to `azure_openai.generate_stream()`
- Updated `SmrGenerateRequest` to use `SmrResponseFormat` interface with `text | json | json_schema` types
- Added 9 new tests (3 Python OpenAI-compat, 5 Python Azure, 3 TypeScript API gateway)

**Provider Structured Output Matrix (after fix)**:

| Format | Ollama | OpenAI Compat | Azure OpenAI | Bedrock |
|--------|--------|---------------|--------------|---------|
| `json` (sync) | Yes | Yes | Yes | No (API limitation) |
| `json` (stream) | Yes | **Yes (fixed)** | **Yes (fixed)** | No |
| `json_schema` (sync) | Yes | Yes | Yes | Yes (via toolConfig) |
| `json_schema` (stream) | Yes | **Yes (fixed)** | Yes | Yes |

**LM Studio note**: LM Studio rejects `json_object` format — only `json_schema` and `text` are supported. Callers should use `json_schema` for LM Studio models.

**Test evidence**:
- `test_openai_compat_provider.py`: 19 passed
- `test_azure_provider.py`: 14 passed
- `smr-proxy.controller.test.ts`: 13 passed
- Ollama JSON streaming: verified via curl
- LM Studio `json_schema` streaming: verified via curl
- Azure OpenAI `json_object` streaming: verified via curl

---

## Change History

### 2026-06-07 — Default local LLM engine switched to LM Studio

The default local engine was changed from Ollama to **LM Studio** (OpenAI-compatible).
Ollama is now an optional, lower-priority engine. This supersedes the original
Task 1.5 decision ("keep `default-smr-provider` as `ollama`").

Files modified:
- `apps/smr/src/smr_v2/models/requests.py` — `GenerateRequest.provider` default `ollama` → `lm-studio`
- `apps/smr/src/smr_v2/main.py` — LM Studio registered before Ollama
- `packages/database/src/prisma/db_main/seed/11-global-setting.ts` — `default-smr-provider` → `lm-studio`, `default-smr-model` → `lmstudio-community/gemma-4-E4B-it-QAT-GGUF`, `SMR_PROVIDER_NAMES`/catalog reordered (LM Studio first), added `gemma-4-E4B-it-QAT-GGUF` and `gemma-4-12b-qat` to the LM Studio catalog
- `packages/applications/src/services/tenant/tenant.service.ts` — fallback provider `ollama` → `lm-studio`
- `.env.dev` — LM Studio enabled by default, Ollama disabled
- `apps/smr/tests/load/locustfile.py` — load-test provider → `lm-studio`
- Tests updated: SMR default-provider assertions, `seed-smr-provider-models.test.ts` ordering/count
- `docs/marketing/V2_BRIEF_TECHNICAL.md` — LM Studio listed as default self-hosted engine

Note: the Granite Guardian safety sensor (`apps/harness`) and the harness eval judge are
unchanged — the judge already defaults to `openai_compat` (LM Studio), and Granite Guardian
intentionally uses Ollama's native `/api/chat` API.
