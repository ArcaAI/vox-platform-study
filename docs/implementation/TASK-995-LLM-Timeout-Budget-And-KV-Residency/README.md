# TASK-995 — LLM timeout budget + LM Studio KV residency

| | |
|---|---|
| **Status** | In Progress |
| **Type** | bugfix |
| **Branch** | `dev-2.2` |
| **Repos** | `arca/hope-v2`, `arca/hope-v2-deployment` |
| **Owner directives** | 2026-09-21 — "increase the timeout to 5m"; "decrease the context from 131k to 65536" |

---

## Requirement Analysis

A live realtime consultation returned **no summarization at all**, and attempting to cancel
the run answered `harness job not found`. Two unrelated defects plus a capacity problem.

Scope taken here, per owner instruction "implement 1 and 2" plus the context change:

1. Per-call LLM timeout raised to 5 minutes.
2. `generate`'s Temporal start-to-close raised to admit it.
3. `LMS_CONTEXT` 131072 → 65536, with its lockstep seed declaration.

**Deliberately NOT in this ticket** — the cancel defect (below). It is understood and
reproduced but was not part of "implement 1 and 2"; it needs its own ticket.

## Current State Evaluation

### Evidence (dev cluster, `hope-v2-dev`, 2026-09-21)

`hope-text` `generation.audit`, gemma-4-e2b-it-qat, all `status: completed`:

| Time | Prompt tokens | Latency |
|---|---|---|
| 03:28:54 | 12,168 | 70.9s |
| 03:29:27 | 12,168 | 102.9s |
| 03:32:38 | 12,173 | 195.7s |
| 03:32:48 | 12,233 | 179.3s |
| 03:34:59 | — | >300s (timeout + retry) |

Meanwhile `hope-harness-worker`:

```
harness.core.llm_concurrency.LlmCallTimeout: llm request exceeded 120s per-call timeout
temporalio.exceptions.ApplicationError: TextResponseLost: text generate failed
  (per-call timeout; not re-issued)
```

**The summaries were being generated successfully and thrown away.** Every generation past
~03:28 exceeded the harness's 120s bound while `hope-text` ran to completion at 179–195s.

### The budget was a nest, and it was inverted

```
Temporal activity `generate`   start_to_close = _ACTIVITY_TIMEOUT (150s), retry = 2
  └─ per-call LLM bound        120s   (HARNESS_LLM_REQUEST_TIMEOUT_S, unset → default)
       └─ hope-text            300s + 3 retries
```

`HARNESS_LLM_REQUEST_TIMEOUT_S` was **set nowhere in the deployment repo** (verified by
grep), so it ran on the code default.

Raising only the inner value to 300 would have made things **worse**: Temporal cancels at
150s first, so the terminal `LlmCallTimeout` is replaced by a retryable
`ActivityTaskTimedOut`, and `_GENERATE_RETRY` (max 2 attempts) runs the whole generation
again on a GPU box already at 67–80% utilisation.

### Why the generations were slow — and why Q4 KV was not available

Measured on the serving pod:

- `nvidia-smi`: LM Studio's process held **13.9 GiB** (4994 + 8906 MiB) across two 16 GiB
  RTX 2000 Ada cards; STT held a further 6.7 GiB.
- `lms ps`: weights are only **8.5 GiB** (gemma 3.35 + granite-guardian 5.12).
- So **~5.4 GiB is KV cache + compute buffers**, at `context 131072 × parallel 10`.

`base/lmstudio.yaml` already documents that LM Studio gives **each** parallel slot the full
context rather than dividing it, so residency scales with `context × parallel`.

**Q4 KV quantization was the first choice and is not reachable on this build.** Verified
against the running pod (LM Studio 0.0.23-1, runtime `llama.cpp-linux-x86_64-nvidia-cuda12-avx2`
2.31.2):

| Surface | Result |
|---|---|
| `lms load --help` | No KV-quant flag (`--gpu`, `--context-length`, `--parallel`, `--ttl`, `--identifier`, `--speculative-draft-*`, `--estimate-only` only) |
| `POST /api/v1/models/load` | Accepts exactly `model, context_length, flash_attention, offload_kv_cache_to_gpu, eval_batch_size, num_experts, parallel`. Every KV-quant spelling → `unrecognized_keys` |
| `~/.lmstudio/settings.json` | No KV-quant key |
| `config-presets/` | Empty; `experimentalLoadPresets: false` |

The daemon *does* support it — the bundle carries `llm.load.llama.kCacheQuantizationType`,
`llm.load.llama.vCacheQuantizationType`, `mlxKvCacheQuantizationType` — but only via the
lmstudio SDK's kvConfig stack over the websocket API, i.e. replacing `lms load` in
`infrastructure/docker/lmstudio/entrypoint.sh`. **Deferred to its own ticket.**

Two facts that ticket will need: `flash_attention` *is* settable over REST and llama.cpp
requires it for V-cache quantization; and `granite-guardian-4.1-8b` is **JIT-loaded**, not
via `LMS_LOAD`, so an entrypoint-only change would not cover it (it comes up on
`defaultContextLength: 8192`, `parallel: 4`, `jitModelTTL: 3600s`).

Halving the context is the reachable half of the same lever, needs no rebuild, and 65536 is
still ~5.4× the largest prompt actually measured (12,233 tokens).

### Out of scope, recorded

- **Cancel is structurally broken.** `registerHarnessNoteJob` registers harness note jobs as
  `type: 'SUMMARY'` ([consultation-job.service.ts:225]), but `cancelJob`'s switch has no
  `SUMMARY` case ([consultation-job.service.ts:272]) and falls through to `default: return
  false` → the controller's 404 `not found or no longer cancellable`. The comment there
  assumes a `SUMMARY` row can only be a stale leftover; `registerHarnessNoteJob` creates them
  on the live path. Every harness summary is uncancellable by construction, and nothing
  signals/terminates the Temporal workflow either. **Needs its own ticket**, including an
  owner call on whether cancel should terminate the workflow or only mark the Redis row.
- **NLP 503s** on `extract_entities` at 03:29:55 (2 attempts) — transient, recovered by
  03:34 (200s at 96–252ms). No action.
- Benign: `Namespace default has no mapping defined for search attribute HarnessTenantId`.

## Implementation Plan

| # | Change | File |
|---|---|---|
| 1 | RED test pinning the nesting invariant | `apps/harness/.../tests/unit/temporal/test_task995_llm_timeout_budget.py` |
| 2 | `request_timeout_s` default 120 → 300 (dataclass + `_env_float`) | `apps/harness/src/harness/core/llm_concurrency.py` |
| 3 | New `_GENERATE_TIMEOUT = 330s`; wire `generate` to it | `apps/harness/src/harness/temporal/workflows.py` |
| 4 | `HARNESS_LLM_REQUEST_TIMEOUT_S=300` explicit | deployment `base/harness-worker.yaml` |
| 5 | `LMS_CONTEXT` 131072 → 65536 | deployment `base/lmstudio.yaml` |
| 6 | `LM_STUDIO_CONTEXT_LENGTH` 131072 → 65536 (lockstep) | `packages/database/.../seed/ai-models/llm.ts` |

Design notes:

- `generate` gets its **own** constant rather than a raise of `_ACTIVITY_TIMEOUT`, which
  governs ~15 other activities. Precedent: `_INFERENTIAL_TIMEOUT = 900s`.
- 330s = 300s inner + 30s headroom, the same ratio the old 120/150 pair used.
- **Replay-safe.** A `start_to_close_timeout` is an activity *option*, not a command in the
  recorded sequence, so no `workflow.patched()` gate and **no drain** is required — the same
  rule `_INFERENTIAL_HEARTBEAT_TIMEOUT` already relies on, proven by `test_replay_compat.py`.
- The code default is raised *and* the manifest sets it explicitly: the default keeps the
  invariant true in every environment, the manifest keeps all three layers of the nest
  visible in one place.

### Ordering constraint (lockstep)

`LMS_CONTEXT` is what the engine loads; `LM_STUDIO_CONTEXT_LENGTH` is what the live lane
budgets against. Over-claiming yields `exceed_context_size_error`; under-claiming is safe.
So on the way **down**, lower the served window first, then the declaration. Both are in
this ticket, but they land in two repos and the deployment change must reach the cluster
first.

## Verification Criteria

- [x] `test_task995_llm_timeout_budget.py` RED before (4 failed), GREEN after (4 passed)
- [x] Temporal suite green — `1341 passed in 72.86s`
- [x] Replay compatibility green — `33 passed, 2642 deselected` (`-k replay`)
- [x] `pnpm harness:lint` — `All checks passed!`
- [x] `pnpm harness:typecheck` — `Success: no issues found in 155 source files`
- [x] `pnpm --filter @arcaai/database typecheck` — clean
- [x] `kubectl kustomize deployment/k8s/overlays/dev` — renders `LMS_CONTEXT: "65536"` and
      `HARNESS_LLM_REQUEST_TIMEOUT_S: "300"`; `grep -c 131072` = 0
- [ ] **Post-deploy, NOT YET DONE**: a live consultation returns a summary; `lms ps` shows
      context 65536; `generation.audit` latency after the context drop

## Implementation Summary

All six changes implemented and committed; every local gate green.

| Repo | Commit |
|---|---|
| `arca/hope-v2` | `4567ab098` |
| `arca/hope-v2-deployment` | `f7abcc3` |

**Neither is pushed.** Pushing the deployment commit *is* the deploy — Argo auto-syncs
`overlays/dev`. Two consequences the owner should confirm first:

1. **`hope-lmstudio` rolls retire-then-replace** (`maxSurge: 0`, because the pod holds 4 of
   the node's 6 time-sliced GPU units and a surge would deadlock). So there is a real
   service gap while the pod restarts and reloads the model — `progressDeadlineSeconds` is
   1560 for exactly this reason. Any consultation in flight during the roll loses its LLM.
2. **The seed constant only takes effect where the seed is re-run.** The gemma `AiModel`
   row's `_metadata.contextLength` is existing data in the cluster DB; a deploy does not
   refresh seed data. Until it is re-seeded the DB still declares 131072 against a
   65536-loaded engine — which is the over-claiming direction, i.e. the one that yields
   `exceed_context_size_error`. **This must be resolved as part of the rollout**, not after.

### Residual risk

The timeout fix makes the system stop discarding good work, but it does not make generation
fast — it admits a 5-minute wait. The context halving should reduce KV pressure, but the
effect on latency is unmeasured. If generations still approach 300s after this lands, the
next levers are `LMS_PARALLEL` (10 → 4, same env-var reachability) and then the deferred Q4
KV ticket.

## Change History

| Date | Change |
|---|---|
| 2026-09-21 | Ticket opened. Diagnosed via Grafana/Loki + Rancher; root cause is an inverted timeout nest, not a generation failure. Implemented items 1–6. Q4 KV quantization investigated and found unreachable on LM Studio 0.0.23-1 headless — deferred. Cancel defect recorded as out of scope. |

[consultation-job.service.ts:225]: ../../../packages/applications/src/services/consultation/jobs/consultation-job.service.ts
[consultation-job.service.ts:272]: ../../../packages/applications/src/services/consultation/jobs/consultation-job.service.ts
