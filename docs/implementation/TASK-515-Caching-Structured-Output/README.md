# TASK-515 — Prefix-Cache Friendliness, Structured Output + Bounded Auto-Repair, Engine-Integration Wiring

**Parent program:** TASK-508 Agentic SOTA Program — **Phase 4D** (with the deferred Phase 4B/4C engine-integration wiring).
**Status:** Completed
**Type:** feature + infrastructure
**Owner scope (exclusive manifest):** `packages/applications/**`, `packages/database/**` (additive seed only), `apps/harness/**`, `apps/guardrail/**`, `infrastructure/grafana/**`, `.env.example`, `.env.production`, `turbo.json`, this README.
**Explicitly NOT touched:** `apps/smr/**`, `apps/admin-console/**`, `deployment/**`, `apps/api/**`.

---

## Requirement Analysis

Phase 4D (TASK-515) makes the SOAP + judge generation paths **prefix-cache friendly** and **robust to malformed structured output**, adds the **measurement panel**, and lands the **deferred engine-integration wiring** for the two production self-host engines (`vllm`, `llama-cpp`) introduced in Phase 4B/4C.

1. **Prompt reorder for prefix-cache friendliness (4D.1)** — reorder the live SOAP prompt to `[stable system] + [transcript] + [current note] + [delta instruction]` and hoist the harness generation prompt into a byte-stable prefix ordering, so a prefix-cache engine (vLLM prefix cache / llama.cpp `cache_prompt`) reuses the KV cache of the invariant prefix across flushes/regens.
2. **Structured output + bounded auto-repair (4D.3)** — `json_schema` structured output is already forwarded to non-Ollama engines on both SOAP paths; add a **shared bounded auto-repair** step: on a JSON parse failure do **exactly one** corrective retry appending the seeded `CORRECTIVE_RETRY` content, with the tolerant parser as the final fallback. Record **both** SMR calls as ordered trajectory steps. Harness `jsonio` stays untouched.
3. **Measurement panel (4D.2)** — a Grafana panel reading `smr_engine_cache_hit_rate{engine}` alongside TTFT p50.
4. **Deferred engine-integration wiring** — additive `AiModel.provider` seed rows for the vLLM + llama.cpp models; guardrail engine selector accepts `vllm`/`llama-cpp` (config prefixes `GUARDRAIL_VLLM_` / `GUARDRAIL_LLAMA_CPP_`); harness `JudgeConfig.provider` accepts `vllm`/`llama-cpp`; new env vars registered in `.env.example`/`.env.production` + `turbo.json#globalEnv`.

**Constraints:** no git writes; additive-only DB seed (no DROP/DELETE/TRUNCATE, no migrate reset); harness changes additive + Temporal replay-compat green; TDD RED→GREEN per item.

## Current State Evaluation (at start)

- SMR `GenerateRequest` already carries `response_format` with `json_schema` (verified) — structured output is client-side; **no `apps/smr` edit needed**.
- The live SOAP prompt led with a **mode-specific directive** that differed between the first flush and update flushes, breaking the shared cache prefix.
- The `CORRECTIVE_RETRY` prompt-template row **already exists and is seeded** (`07-prompt-template.ts` → `CORRECTIVE_RETRY_SUFFIX`, id `TEMPLATE_IDS.CORRECTIVE_RETRY`) — no new seed row required.
- The live-doc flush parsed `parseSoapJson(text) ?? parseSoapSections(text)` with no retry; the durable summary path stores the raw SMR text (no in-applications JSON parse).
- SMR already exports `smr_engine_cache_hit_rate{engine}` (gauge) and `smr_v2_time_to_first_token_seconds` (histogram); no cache-friendliness dashboard existed.
- `AI_MODEL_PROVIDERS` did not include `vllm`/`llama-cpp`; guardrail + harness-judge selectors did not route them.

## Implementation Plan (TDD)

| # | Item | RED | GREEN |
|---|------|-----|-------|
| 1 | Live-doc prompt reorder + harness stable prefix | prefix-stability unit tests | `LIVE_SOAP_STABLE_SYSTEM_PREFIX` reorder; `assemble_generation_prompt` |
| 2 | Shared bounded auto-repair (live-doc) | invalid→valid repair test (one retry, both steps) | `bounded-json-repair.ts` + flush wiring + repair trajectory step |
| 3 | Grafana cache-friendliness panel | n/a (dashboard asset) | `smr-v2-cache-friendliness.json` |
| 4 | Additive `AiModel` vLLM/llama.cpp rows | catalog assertions | 2 seed rows + `AI_MODEL_PROVIDERS` extension |
| 5 | Guardrail `vllm`/`llama-cpp` selector | pytest | `VLLMConfig`/`LlamaCppConfig` + selector routing |
| 6 | Harness `JudgeConfig` `vllm`/`llama-cpp` | pytest | `JudgeProvider` enum + `build_judge_client` routing |
| 7 | Env vars + `turbo.json#globalEnv` | — | `.env.example`/`.env.production`/`turbo.json` |

## Implementation Summary

### 4D.1 — Prompt reorder (prefix-cache friendliness)

- `packages/applications/.../live-documentation/live-documentation.service.ts`: added `LIVE_SOAP_STABLE_SYSTEM_PREFIX` (byte-identical across every flush) and reordered `buildSmrUserPrompt` to `[stable system] + [transcript] + [current note] + [delta instruction]`, moving the mode-specific directive to the trailing block.
- `apps/harness/src/harness/temporal/prompt_cache.py` (new): `assemble_generation_prompt(user_prompt, prompt_block)` concatenates the invariant `[template+transcript]` prefix then the variable RAG StrictCitations block — **byte-identical** to the prior inline concatenation (Temporal replay-safe).
- `apps/harness/src/harness/temporal/activities.py`: the `generate` activity now calls `assemble_generation_prompt(...)` instead of inline concatenation.
- Tests: `live-documentation.prompt-cache.test.ts`, `apps/harness/.../temporal/test_prompt_cache.py`.

### 4D.3 — Structured output + bounded auto-repair

- `packages/applications/src/services/consultation/shared/bounded-json-repair.ts` (new, shared): `generateJsonWithRepair(...)` runs the model, strict-parses, and on failure does **exactly one** corrective retry (default `CORRECTIVE_RETRY_INSTRUCTION`, mirrored byte-for-byte from the seeded template), else tolerant fallback. `looksLikeJsonObject(...)` scopes the retry to a genuine malformed-JSON attempt (leading `{`), so clean prose is served by the tolerant parser with **no wasted regen**. Returns every model call for ordered trajectory recording.
- `live-documentation.service.ts`: the flush drives `generateJsonWithRepair` (strict = `parseSoapJson`, tolerant = `parseSoapSections`, `shouldRepair = structured && looksLikeJsonObject`). `callSmr` gained a `corrective` suffix (appended **after** the stable prefix so 4D.1 caching holds) and now returns `structured`. `recordFlushTrajectory` emits a second `LLM_CALL:flush.repair` step only when the retry ran.
- **`CORRECTIVE_RETRY` seed:** already present — reused, not re-seeded.
- **Summary path:** structured `json_schema` output is already forwarded for non-Ollama providers (`buildSmrGeneratePayload`). The durable summary path stores the **raw** SMR text and does not JSON-parse it in the applications layer, so there is no in-applications parse-failure trigger to wrap; the shared helper lives in `consultation/shared/` and is ready for any future summary-side JSON parse. Harness `jsonio` untouched.
- Tests: `live-documentation.repair.test.ts`, `shared/__tests__/bounded-json-repair.test.ts`.

### 4D.2 — Measurement panel

- `infrastructure/grafana/dashboards/smr-v2-cache-friendliness.json` (new): panel 1 = `smr_engine_cache_hit_rate{engine}` per engine; panel 2 = TTFT p50 (`histogram_quantile(0.5, …smr_v2_time_to_first_token_seconds_bucket…)`) per-provider + fleet. Template vars `$engine`, `$provider`; uid `smr-v2-cache-friendliness`.

### Deferred engine-integration wiring

- **DB seed (additive):** `ai-models/shared.ts` `AI_MODEL_PROVIDERS` extended with `vllm`, `llama-cpp` (free-string, no Prisma enum migration). `ai-models/llm.ts` adds two rows — `vllm-medgemma-1.5-27b-it` (SAFETENSOR, provider `vllm`, id `…0007-…020`) and `llama-cpp-medgemma-1.5-4b-it` (GGUF, provider `llama-cpp`, id `…0007-…021`). Catalog-shape tests updated to `+2` (30 total / 11 LLM rows) and the provider allow-lists extended.
- **Guardrail:** `VLLMConfig` (`GUARDRAIL_VLLM_`) + `LlamaCppConfig` (`GUARDRAIL_LLAMA_CPP_`) subclass `OpenAICompatConfig`; `Settings` fields, `_validate_provider`, `engine_for`, `_PROVIDER_TO_ATTR`, and the `_GRANITE_ENGINES` set route both onto the OpenAI-compat client with the Granite BYOC protocol. Test: `test_vllm_llama_cpp_engine.py`.
- **Harness judge:** `JudgeProvider` enum gains `VLLM`/`LLAMA_CPP`; `build_judge_client` routes both to `OpenAICompatJudgeClient` (they reuse the `HARNESS_JUDGE_OPENAI_COMPAT_*` block). Test: `test_judge_config.py`.
- **Env:** `GUARDRAIL_VLLM_*` / `GUARDRAIL_LLAMA_CPP_*` and `HARNESS_JUDGE_*` added to `.env.example`, `.env.production`, and `turbo.json#globalEnv`.

## Verification Evidence (actual gate output)

```
# packages/applications
pnpm --filter @arcaai/applications build   → tsc, exit 0
pnpm --filter @arcaai/applications test     → Test Files 307 passed | 1 skipped; Tests 6361 passed | 4 skipped
  live-documentation.repair.test.ts         → 2 passed  (RED first: "expected 1 to be 2" on generate-call count)
  shared/__tests__/bounded-json-repair.test.ts → 6 passed
  live-documentation (whole suite)          → 7 files / 82 passed

# packages/database
pnpm --filter @arcaai/database build        → tsc, exit 0
pnpm --filter @arcaai/database test         → Tests 795 passed | 4 failed  (see "Known pre-existing failures")
  task-506 catalog: 30 slugs / unique / provider allow-list → PASS
  seed.test.ts: 11 LLM rows / +vllm +llama-cpp counts       → PASS

# apps/harness  (conda arcaenv)
pytest apps/harness/src/harness/tests/ -q   → 809 passed
  test_prompt_cache.py 15/15 · test_replay_compat.py 47/47 (replay-compat GREEN) · test_judge_config vllm/llama-cpp PASS

# apps/guardrail (conda arcaenv)
pytest apps/guardrail/src/guardrail/tests/ -q → 118 passed  (incl. test_vllm_llama_cpp_engine.py)

# lint
ruff check <changed .py>                    → All checks passed!
pnpm --filter @arcaai/applications lint      → 0 errors (108 pre-existing prettier warnings in untouched files; my files clean)
```

### Known pre-existing failures (NOT introduced by TASK-515)

`task-506-ai-model-consolidation.test.ts` has **4 failing AiTaskDefault tests** (`expected 5 to be 3`). These come from a concurrent working-tree change to `packages/database/.../seed/16-ai-task-default.ts` (a parallel agent added the `smr.live` + `smr.finalize` SYSTEM task defaults, growing the set 3→5) whose matching test update has not landed. TASK-515 never touched `16-ai-task-default.ts`; verified independent by inspection. My additive catalog changes (slug list, counts, provider allow-lists) are all green.

## Deviations

- **`CORRECTIVE_RETRY` seed** was already present — reused rather than re-seeded (the "if absent" condition was not met).
- **Summary-path auto-repair** is not wired: the applications summary path stores raw SMR text and performs no JSON parse there, so there is no parse-failure trigger to wrap. Structured output is already enabled on that path; the shared helper is placed in `consultation/shared/` for reuse.
- **Harness judge** vLLM/llama.cpp reuse the existing `HARNESS_JUDGE_OPENAI_COMPAT_*` config (they share the OpenAI-compat wire) rather than introducing new `HARNESS_JUDGE_VLLM_*` prefixes — matches the judge's provider-routing design.

## Compliance confirmation

- **No git writes** of any kind were performed.
- **Additive-only DB seed** — no DROP/DELETE/TRUNCATE, no `migrate reset`; only new rows + an extended provider string-list.
- **No edits** to any DO-NOT-TOUCH path (`apps/smr`, `apps/admin-console`, `deployment`, `apps/api`).

## Change History

| Date | Change |
|------|--------|
| 2026-07-19 | Initial implementation: 4D.1 prompt reorder (live-doc + harness), 4D.3 shared bounded auto-repair + repair trajectory step, 4D.2 cache-friendliness Grafana panel, additive vLLM/llama.cpp `AiModel` seed rows, guardrail + harness-judge `vllm`/`llama-cpp` selectors, env + `turbo.json` wiring. All target gates green; 4 pre-existing AiTaskDefault DB-test failures documented as out-of-scope. |
