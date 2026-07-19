# TASK-509 — Generation Metrics Contract (AD-1)

| Field | Value |
|---|---|
| **Status** | Completed (eng) — follow-ups open |
| **Type** | feature |
| **Parent** | [TASK-508 Agentic SOTA Program](../TASK-508-Agentic-SOTA-Program/README.md) — Phase 1 (owner ask 1) |
| **Depends on** | Phase 0 foundations (TASK-508-Agentic-Foundations) |
| **Unblocks** | TASK-510 (trajectory embeds stats), TASK-512 Metrics screen |
| **Numbering note** | Gap-review §8 (superseded) used TASK-509 for *critique-informed regen* — that work is now **TASK-517**. This ticket is generation metrics only. |

---

## 1. Requirement Analysis

Every LLM call in the platform yields one normalized **AD-1 `GenerationStats`** shape:

- stop reason (normalized + raw)
- total time, time-to-first-token, tokens/sec
- prompt / predicted / total token counts
- provider + model identity
- optional `engine_native` timings blob

Aggregates land in Prometheus; OTel GenAI span attributes when the exporter is on; headline fields persist on `SummaryMeta`; full stats ride trajectory `LLM_CALL` steps (Phase 2) and live-summary SSE.

Authoritative contract: program README §AD-1 + Phase 1.

---

## 2. Current State Evaluation (at ticket open)

SMR already returned `usage` / `finish_reason` / `latency_ms` and had TTFT Prometheus — but **no tokens/sec**, no normalized stop-reason enum, no TTFT on non-stream responses, no shared stats contract across harness/judge/guardrail/live-doc, and no persistence beyond summary token columns.

---

## 3. Implementation Plan (executed, TDD)

1. **1A RED** — `apps/smr/src/smr_v2/tests/unit/test_generation_stats.py` (openai/ollama/bedrock/azure maps, stream usage chunk, client fallback, never-fail generation).
2. **1A GREEN** — `models/stats.py` + provider `generate`/`generate_stream` return `GenerationStats`; `/generate` stamps Prometheus + OTel attrs.
3. **1B RED→GREEN** — additive `SummaryMeta` columns; summary + live-doc parse/persist/SSE; harness `smr_client` + generate activity; judge/granite/guardrail local mirrors.
4. Gateway `smr-proxy` stays pass-through; cross-service E2E deferred to Phase 7 (probe file authored).

---

## 4. Implementation Summary

### AD-1 shape (`apps/smr/src/smr_v2/models/stats.py`)

```
GenerationStats {
  stop_reason:        "stop" | "length" | "content_filter" | "tool_call" | "abort" | "error" | "other"
  stop_reason_raw:    str
  total_ms:           int
  ttft_ms:            int | null
  tokens_per_second:  float | null
  prompt_tokens:      int
  predicted_tokens:   int
  total_tokens:       int
  provider: str; model: str
  engine_native:      dict | null
}
```

Helpers: `normalize_stop_reason`, `build_generation_stats`, `degraded_stats`, `stats_from_{openai_usage,ollama_response,bedrock,llama_cpp}`.

### SMR (1A)

| File | Change |
|---|---|
| `models/stats.py` | NEW AD-1 contract |
| `models/responses.py` | `GenerateResponse.stats`; legacy `usage`/`finish_reason`/`latency_ms` kept (deprecated in docstring) |
| `providers/{openai_compat,azure_openai,ollama,bedrock}.py` | Real stats; stream drains to `usage` then `done` |
| `providers/{vllm,llama_cpp}.py` | Later phases — same contract (4A/4B/4C) |
| `api/endpoints/generate.py` | Coerce/degrade; stamp metrics; never fail gen on stats errors |
| `core/metrics.py` | `TOKENS_PER_SECOND`, `STOP_REASON_TOTAL` (+ existing `TTFT_SECONDS`) |
| `core/observability.py` | `set_generation_span_attributes` → `gen_ai.*` |

### Consumers (1B)

| Surface | Change |
|---|---|
| Migration `20260719000000_task_509_summary_meta_generation_stats` | `SummaryMeta.stopReason` / `ttftMs` / `tokensPerSecond` |
| `summary.service.ts` | Persist headlines; emit trajectory `LLM_CALL` with full `stats` |
| `live-documentation.service.ts` + `LiveSummaryStatsDto` | SSE `metadata.stats` (snake_case; **no** `engine_native`) |
| Harness `smr_client.py` + `activities.py#generate` | Stats on activity result |
| Judge / granite / guardrail | Local AD-1-shaped mirrors (`last_stats` / `GuardrailCallStats`) |
| `smr-proxy.controller.ts` | Pass-through (unchanged) |

---

## 5. Verification Evidence

Unit coverage (representative):

| Suite | File |
|---|---|
| SMR AD-1 | `apps/smr/src/smr_v2/tests/unit/test_generation_stats.py` |
| Provider contract (4A) | `test_provider_contract.py` |
| Domains | `SummaryMetaEntityMapper.test.ts` |
| Applications | `summary.service.test.ts` (TASK-509 block), live-doc SSE stats cases |
| Harness | `test_smr_client.py`, `test_activities.py` (stats thread), `test_judge_stats.py`, `test_granite_stats.py` |
| Guardrail | `test_openai_compat_stats.py` |

Phase 7 probe (not executed in this run): `apps/api/tests/e2e/task-509-generation-stats.spec.ts` — asserts trajectory `stats` shape / no `payloadRef` leak; documents that SummaryMeta headlines have **no** gateway read DTO yet.

Gate counts at land time recorded in program [TRACKER](../TASK-508-Agentic-SOTA-Program/TRACKER.md) (Phase 1 + subsequent provider waves).

---

## 6. Deviations & open follow-ups

| Item | Status |
|---|---|
| OTel GenAI **metrics** (`gen_ai.client.token.usage`, server TTFT/tok histograms) | **Missing** — span attrs + Prometheus only |
| Server `GET` generation-metrics aggregate / Prometheus proxy for console | **Done (aggregate)** — `GET admin/agent-trajectory/metrics/generation` (default last 7d + hard max 5000 LLM_CALL rows). Prometheus proxy still absent. |
| SummaryMeta headlines on a public read/provenance DTO | **Missing** — write path only; trajectory is the gateway surface |
| Console camelCase (`ttftMs`) vs wire snake_case (`ttft_ms`) | **Fixed (console)** — `normalizeGenerationStats` accepts both; Metrics aggregate + Runs `StepStats` use it |
| Cross-service E2E | Deferred to TASK-522 (probe authored) |

---

## 7. Change History

| Date | Change |
|---|---|
| 2026-07-19 | Phase 1A/1B implemented (W0-B + W1). AD-1 contract + consumers + Prometheus/OTel attrs. Tracker marked Completed. |
| 2026-07-19 | **Retrospective README** authored (was missing). Documents follow-ups: aggregate endpoint, SummaryMeta read DTO, casing, OTel metrics. |
| 2026-07-19 | **Follow-up (admin-console only):** Trajectory/live emitters store AD-1 stats as snake_case; Metrics/Runs expected camelCase → empty panels / raw JSON. Added pure `normalizeGenerationStats` (camel + snake, maps `predicted_tokens` → `completionTokens`); wired into `aggregateGenerationStats` + `StepStats`. Types document both casings. Gate: `pnpm --filter @arcaai/admin-console test -- ai-operations`. |
| 2026-07-19 | **Follow-up (server aggregate):** `AgentTrajectoryService.aggregateGenerationStats` + `GET admin/agent-trajectory/metrics/generation` (`@CanManage('HarnessPolicy')`). Bounded LLM_CALL scan (default last 7d, max 5000 rows); parses snake_case AD-1 `stats`. Admin-console Metrics screen switched to the endpoint; client `normalizeGenerationStats` + pure rollup helper kept. Gates: applications/api `agent-trajectory`, admin-console `ai-operations-metrics`. |
