# TASK-513 / TASK-514 — SMR Production Inference Engines (vLLM + llama.cpp)

- **Status**: Review (unit gates green; live GPU e2e authored, owner-run)
- **Program**: [TASK-508 Agentic SOTA Program](../TASK-508-Agentic-SOTA-Program/README.md) Phase 4 (4B vLLM · 4C llama.cpp). Rides on Phase 4A (provider contract) — see the program [TRACKER](../TASK-508-Agentic-SOTA-Program/TRACKER.md).
- **Type**: feature (SMR providers) + infrastructure (serving)
- **Owner run decisions**: GPU / tier-hardware suites deferred to owner; no git writes by the agent.

---

## 1. Requirement Analysis

Owner ask 6 (engine split): LM Studio + Ollama stay for local dev/test;
**production runs vLLM and llama.cpp** as first-class SMR providers (engine
identity, native AD-1 stats, structured-output control, health/cache metrics),
plus serving infrastructure (compose + k3s) and a staging runbook.

- **4B / TASK-513 — vLLM**: `providers/vllm.py`; registry key `"vllm"`; config prefix `SMR_V2_VLLM_`; `stream_options.include_usage` always on; real `finish_reason`; native `response_format` json_schema with an `extra_body.guided_json` fallback toggle; `provider="vllm"` in stats; `health_check()` → `/health`; optional `/metrics` scrape → `SMR_ENGINE_CACHE_HIT_RATE{engine="vllm"}`.
- **4C / TASK-514 — llama.cpp**: `providers/llama_cpp.py`; native `/completion` client; `json_schema` or GBNF `grammar`; parse `timings{prompt_n, predicted_n, predicted_ms, predicted_per_second}` + `stopped_eos/stopped_word/stopped_limit` → exact AD-1 stats (reference engine); SSE streaming; registry key `"llama-cpp"`; config prefix `SMR_V2_LLAMA_CPP_`; `stopped_limit → "length"`.

## 2. Current State Evaluation

Phase 4A widened the provider contract to `generate → (content, reasoning, GenerationStats)`
and `generate_stream → chunk*/reasoning* → one usage(full stats) → done (last)`,
with `stats.py` (AD-1) already carrying the `vllm` + `llama_cpp` normalization
tables and a parametrized `test_provider_contract.py` over the 4 existing
providers. This ticket adds the two production providers so they pass the SAME
invariants **unchanged**, then wires + serves them.

## 3. Implementation Plan (TDD)

1. **RED** — extend `test_provider_contract.py`: add `vllm` + `llama-cpp` adapters to `ADAPTERS` (must pass the 6 shared invariants) + a `TestLlamaCppReferenceEngine` class (timings passthrough vs client-compute divergence, GBNF grammar passthrough, json_schema passthrough, stop-reason mapping). Run → fail.
2. **GREEN** — `VllmConfig`/`LlamaCppConfig`; `stats_from_llama_cpp`; `SMR_ENGINE_CACHE_HIT_RATE`; `providers/vllm.py` (subclass the OpenAI-wire provider, parametrized engine identity + `_apply_response_format` hook); `providers/llama_cpp.py` (native `/completion`); register in `main.py` + timeout map.
3. **Serve** — compose `inference` profile; k3s base manifests + kustomization; `.env.example`/`.env.production`; `turbo.json#globalEnv`; live e2e; runbook.

## 4. Implementation Summary

### Files created
- `apps/smr/src/smr_v2/providers/vllm.py` — `VllmProvider(OpenAICompatProvider)`; `provider="vllm"`; `use_guided_json` toggle; `/health`; `scrape_cache_hit_rate()` + pure `_parse_cache_hit_rate()`.
- `apps/smr/src/smr_v2/providers/llama_cpp.py` — `LlamaCppProvider`; native `/completion` (httpx); `timings`+`stopped_*` → AD-1; SSE streaming; GBNF/json_schema; `cache_prompt: true`.
- `apps/smr/src/smr_v2/tests/e2e/test_vllm_live.py` — env-gated (`SMR_E2E_VLLM_BASE_URL`) live suite, `-m e2e`, deselected by default.
- `deployment/k3s/base/vllm.yaml` — StatefulSet (GPU, PVC weights cache) + Service.
- `deployment/k3s/base/llama-cpp.yaml` — PVC + Deployment (CPU GGUF tier, `--slots`) + Service.
- `docs/operations/inference/README.md` — staging per tier, quantization, wiring, smoke commands.
- `docs/implementation/TASK-513-514-SMR-Production-Engines/README.md` — this doc.

### Files modified
- `apps/smr/src/smr_v2/core/config.py` — `VllmConfig` (extends `OpenAICompatConfig`) + `LlamaCppConfig`; registered on `Settings`.
- `apps/smr/src/smr_v2/models/stats.py` — `stats_from_llama_cpp` builder.
- `apps/smr/src/smr_v2/core/metrics.py` — `SMR_ENGINE_CACHE_HIT_RATE{engine}` gauge.
- `apps/smr/src/smr_v2/providers/openai_compat.py` — parametrized engine identity (`provider_name`/`display_name`, default unchanged) + extracted `_apply_response_format` hook (behavior-preserving refactor so vLLM can subclass).
- `apps/smr/src/smr_v2/main.py` — register `vllm` + `llama-cpp` (enabled-gated); added to the rate-limiter/semaphore provider-config maps.
- `apps/smr/src/smr_v2/api/endpoints/generate.py` — `vllm`/`llama-cpp` timeouts in `_get_provider_timeout`.
- `apps/smr/src/smr_v2/tests/unit/test_provider_contract.py` — vllm + llama-cpp adapters + reference-engine tests.
- `infrastructure/docker/docker-compose.dev.yml` — `inference` profile: `vllm`, `llama-cpp`, `tei-embed` + `vllm-cache`/`tei-embed-data` volumes.
- `deployment/k3s/base/kustomization.yaml` — register `vllm.yaml` + `llama-cpp.yaml`.
- `.env.example`, `.env.production` — `SMR_V2_VLLM_*` / `SMR_V2_LLAMA_CPP_*` reference blocks.
- `turbo.json` — new runtime env vars in `globalEnv`.

### RED → GREEN evidence

**RED** (`pytest apps/smr/src/smr_v2/tests/unit/test_provider_contract.py -q`) — after adding the adapters, before implementing the providers:

```
18 failed, 24 passed in 3.32s
FAILED ...test_generate_returns_content_and_populated_stats[vllm]
FAILED ...test_generate_returns_content_and_populated_stats[llama-cpp]
FAILED ...test_generate_stream_drains_chunk_then_usage_then_done[vllm]
FAILED ...test_generate_stream_drains_chunk_then_usage_then_done[llama-cpp]
FAILED ...test_response_format_json_schema_passes_through[vllm]
FAILED ...test_response_format_json_schema_passes_through[llama-cpp]
FAILED ...test_timeout_is_surfaced_not_swallowed[vllm]
FAILED ...test_timeout_is_surfaced_not_swallowed[llama-cpp]
FAILED ...test_resolve_model_honors_caller_model[vllm]
FAILED ...test_resolve_model_honors_caller_model[llama-cpp]
FAILED ...test_registry_key_and_get_info_are_consistent[vllm]
FAILED ...test_registry_key_and_get_info_are_consistent[llama-cpp]
FAILED ...TestLlamaCppReferenceEngine::test_engine_native_tokens_per_second_is_passthrough_not_recomputed
FAILED ...TestLlamaCppReferenceEngine::test_gbnf_grammar_passes_through_verbatim
FAILED ...TestLlamaCppReferenceEngine::test_json_schema_passes_through_as_native_field
FAILED ...TestLlamaCppReferenceEngine::test_stop_reason_mapping[flags0-length]
FAILED ...TestLlamaCppReferenceEngine::test_stop_reason_mapping[flags1-stop]
FAILED ...TestLlamaCppReferenceEngine::test_stop_reason_mapping[flags2-stop]
```

**GREEN** (contract suite, then full SMR suite) — after implementing providers + wiring:

```
apps/smr/src/smr_v2/tests/unit/test_provider_contract.py .......... 42 passed in 3.20s
apps/smr/src/smr_v2/tests/                                          867 passed, 29 deselected, 8 warnings in 146.91s
```

(867 = the prior 849 baseline + 18 new cases; the 6 shared invariants now hold
for all **6** providers, and the llama.cpp reference-engine specifics pass.)

### Gate output

| Gate | Command | Result |
|---|---|---|
| Tests | `conda run -n arcaenv --no-capture-output pytest apps/smr/src/smr_v2/tests/ -q` | **867 passed, 29 deselected** |
| Lint | `conda run -n arcaenv ruff check apps/smr/src/` | **All checks passed!** |
| Types | `conda run -n arcaenv --no-capture-output mypy --config-file apps/smr/pyproject.toml apps/smr/src/` | **Success: no issues found in 48 source files** |
| Compose | `docker compose -f infrastructure/docker/docker-compose.dev.yml --profile inference config` | **OK** |
| Kustomize | `kubectl kustomize deployment/k3s/base` | **OK** |
| turbo.json | JSON parse | **OK** |

Live GPU e2e (`test_vllm_live.py`) is authored, skipped by default, **owner-run**
on GPU hardware (not executed here).

## 5. Deviations & deferred follow-ups

- **Image tags** (pinned, real, no `latest`): compose/k3s vLLM `vllm/vllm-openai:v0.11.0`; llama.cpp `ghcr.io/ggml-org/llama.cpp:server-b9853`; TEI `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9` (bge-m3). vLLM/llama.cpp roll fast — operators bump to a build validated on the target hardware (documented in the runbook).
- **`OpenAICompatProvider` refactor**: parametrizing the engine identity + extracting `_apply_response_format` touches a file outside the strict "new provider" scope but inside the allowed `apps/smr/**` manifest. Defaults are byte-preserving; the full existing openai_compat + contract suites stay green.
- **llama.cpp GBNF grammar input**: `GenerateRequest` has no grammar field, so a GBNF grammar is passed via `request.context["grammar"]` (documented extension; takes precedence over `json_schema`).
- **k3s llama.cpp GGUF staging**: the GGUF is operator-staged into the `hope-llama-cpp-models` PVC (pod pulls no weights) — noted in the manifest + runbook.
- **DEFERRED (owned by parallel agents — NOT touched here):**
  - `AiModel.provider` seed rows for `vllm` / `llama-cpp` (`packages/database/**`).
  - Guardrail engine selector accepting `vllm`/`llama-cpp` (`GUARDRAIL_VLLM_` prefix) — `apps/guardrail/**`.
  - Harness `JudgeConfig.provider` accepting `vllm`/`llama-cpp` (`HARNESS_JUDGE_`) — `apps/harness/**`.
  - 4C's prompt-reorder + bounded auto-repair program (`packages/applications/**`) and the cache-hit Grafana panel are separate surfaces.

## 6. Change History

| Date | Change |
|---|---|
| 2026-07-19 | TASK-513 (vLLM) + TASK-514 (llama.cpp) implemented TDD RED→GREEN. Two first-class SMR providers passing the Phase-4A contract unchanged (6 providers total); serving infra (compose `inference` profile + k3s base manifests); env/turbo/runbook. Gates: 867 passed, ruff clean, mypy clean, compose+kustomize valid. Live GPU e2e authored + owner-deferred. No git writes; no DO-NOT-TOUCH paths edited. |
