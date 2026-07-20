# Model Retention & Lifecycle — Operator Runbook

**Owner**: Platform / Inference · **Introduced**: TASK-529 · **Completed by**: TASK-530 · **Last updated**: 2026-07-20

How HOPE decides when a model is loaded, how long it stays resident, and how an
operator changes that at runtime **without a redeploy**.

---

## 1. The one-paragraph version

Every in-process model is loaded **on first request** and released after an
**idle TTL** (default **600 s**, clamped to `[60 s, 3600 s]`). Models in active
use are *pinned* and are never evicted. Retention is set from the admin console
(settings registry), served to each service over
`GET /api/v1/internal/effective-config?service=<name>`, and applied within one
refresh window (~60 s). If the control plane is unreachable, every service keeps
its own env/bootstrap value — a degraded control plane never changes behaviour.

---

## 2. Settings keys

All keys are `globalOnly`, `tier: global-kv`, system-scoped (never tenant-set).

| Key | Default | Meaning |
|---|---|---|
| `<svc>.modelCache.ttlSeconds` | **600** | Idle TTL before eviction. Clamped `[60, 3600]` by the registry **and** again by the service. |
| `<svc>.modelCache.maxModels` | stt 5 · nlp 3 · guardrail 2 · harness 1 · tts 2 | Max resident models (LRU beyond it). |
| `<svc>.modelCache.vramBudgetMb` | 0 (unset) | Optional VRAM bound. Only effective where NVML is available. |
| `stt.modelCache.maxMemoryMb` | 10000 | stt-v2 only — its historical MB estimate budget. |
| `smr.modelCache.ttlSeconds` | 600 | **Not a cache.** Forwarded to server-managed engines (below). |

`<svc>` ∈ `stt`, `nlp`, `guardrail`, `harness`, `tts`.

> **Key prefix ≠ service name for tts-v2.** The service is registered as
> `tts-v2` (that is what it sends as `?service=` and what its token is keyed on),
> but its settings live under the **`tts`** prefix. Both spellings are load-
> bearing and neither is interchangeable.

### 2a. Which services actually read these keys

Set a key here and it reaches every service in this table within one refresh
window, with no redeploy. **As of TASK-535 that is all six** — before it,
guardrail, harness and tts-v2 silently ignored the console and ran on env.

| Service | Reads the control plane since | Client | Refresh trigger |
|---|---|---|---|
| stt-v2 | TASK-525 | `core/effective_config.py` | request-path refresher |
| nlp | TASK-529 | `core/effective_config.py` | request-path (`refresh_inference_limit`) |
| smr | TASK-525 | `core/effective_config.py` | request path (`get_runtime_limits`) |
| guardrail | **TASK-535** | `core/effective_config.py` | aux-model resolution (analyze / groundedness) |
| harness | **TASK-535** | `core/effective_config.py` | **Temporal worker** housekeeping tick (60 s) — §6a |
| tts-v2 | **TASK-535** | `core/effective_config.py` | `POST /api/v1/audio/speech` |

All six are **read-triggered, not background pollers** — a service that is never
called never polls — and all six re-apply the `[60, 3600]` clamp client-side.
Both halves are covered: a cache built *after* a refresh is born with the current
values, and a cache that is **already resident** is reconfigured in place without
dropping its models.

Bootstrap fallbacks (used only until the first successful fetch, and whenever the
gateway is unreachable): `GUARDRAIL_V2_MODEL_CACHE_TTL_S` /
`..._MAX_MODELS`, `HARNESS_MODEL_CACHE_TTL_SECONDS` / `..._MAX_MODELS`,
`TTS_MODEL_CACHE_TTL_SECONDS`. Where each service finds the control plane:
`GUARDRAIL_V2_GATEWAY_URL`, `TTS_GATEWAY_URL`, and (harness) the existing
`HARNESS_API_BASE_URL` + `/api/v1`.

> **The clamp is real.** Setting `ttlSeconds = 7200` does not give you a 2-hour
> TTL — the service clamps it to 3600. Setting `30` clamps up to 60. This is
> deliberate: E6 specifies a 1-hour maximum retention.

### ⚠️ The 600 s default is a change from the pre-TASK-529 behaviour

stt-v2, guardrail and nlp previously ran a **3600 s** idle TTL; nlp's was
hardcoded with no knob at all. TASK-529 adopts the program-approved OD-5 default
of **600 s** for every service. Expect **more frequent model reloads** on
low-traffic deployments after this ships.

Per-service `maxModels` defaults are unchanged (behaviour-preserving) — only the
TTL default moved.

**Rollback is a settings change, not a deploy**: set
`<svc>.modelCache.ttlSeconds = 3600` to restore the old behaviour. It takes
effect within one refresh window.

---

## 3. Who owns retention for which engine

Not every "model" is HOPE's to evict. Three different owners:

| Engine | Retention owner | Mechanism |
|---|---|---|
| In-process (stt-v2 loaders, GLiNER, NLP transformers, harness MiniCheck entailer, Kokoro/IndicParler/IndicF5) | **HOPE** | The shared cache: `ttl → lru → vram` eviction, per-service budgets. As of TASK-530 **no in-process engine is exempt** — see §6a. |
| **Ollama** | The Ollama server, per-request influenced | HOPE sends `keep_alive: <ttl>s` on every generate/stream, overriding the server's `OLLAMA_KEEP_ALIVE` (default 5 min). Cap residents with `OLLAMA_MAX_LOADED_MODELS`. |
| **LM Studio** | The LM Studio server, per-request influenced | HOPE sends `ttl: <seconds>` via the OpenAI SDK's `extra_body`. JIT-loaded models otherwise default to a 60 min idle TTL. Leave **Auto-Evict ON** so a new JIT load unloads the previous one. |
| **vLLM / llama.cpp server** | Launch-time; **resident by design** | One model per launch, stays resident. `smr.modelCache.ttlSeconds` does **not** apply. |

**Why vLLM is out of scope.** vLLM's dedicated-tier posture is intentional: a
model is pinned at launch for predictable latency. vLLM *does* have a
[sleep mode](https://docs.vllm.ai/en/latest/features/sleep_mode) (level 1:
weights → CPU RAM, discard KV; level 2: discard weights) with a `/wake_up`
endpoint, which would let several models share one GPU. That is a **future
opt-in**, deliberately not enabled here — it trades wake latency for capacity
and needs its own evaluation.

> The `ttl` body field is sent **only** when the provider is `lm-studio`. vLLM
> and generic OpenAI-compatible endpoints reject unknown body fields, and they
> share the same provider class — so the hint is gated on engine identity.

---

## 4. Eviction order, and the two guards

Under pressure the cache always evicts in this order, labelling each eviction:

1. **`ttl`** — idle-expired entries. Free wins, taken first.
2. **`lru`** — least-recently-used unpinned entry (count budget, or the
   MB-estimate budget where configured).
3. **`vram`** — only when a live NVML probe reports less free VRAM than the
   incoming model needs.

Two behaviours that look like bugs and are not:

- **Soft ceiling.** If every eviction candidate is pinned, the cache **exceeds**
  `maxModels` rather than drop a model serving a live request, and logs
  `all_pinned_cannot_evict`. Sustained warnings mean `maxModels` is too low for
  your concurrency.
- **Min-residency floor.** An entry is never TTL-evicted younger than **60 s**
  idle, whatever the TTL. This is the anti-thrash guard: without it a small TTL
  plus a small `maxModels` can cycle load/evict on every request.

---

## 5. VRAM awareness

- The NVML probe is **feature-detected**: `pynvml` is imported inside a `try`,
  and *any* failure (no GPU, no driver, container without device access)
  disables the probe for the process — logged once — and the memory-estimate
  path takes over. CI and CPU-only hosts always land here.
- Budgets are **per service and static**. There is no cross-process arbiter:
  that would be a new failure domain, a new deploy unit and an IPC protocol to
  solve what static partitioning already solves on a fixed set of services per
  GPU host.
- Sizing: give each service a `vramBudgetMb` under its share of the card, and
  leave headroom for activations — the budget bounds *weights*, not peak usage.

---

## 6. Dashboard & metrics

Dashboard: `infrastructure/grafana/dashboards/model-retention.json`.

| Metric | Read it for |
|---|---|
| `model_cache_resident_models{cache}` | What is loaded right now |
| `model_cache_resident_bytes_estimate{cache}` | Rough memory footprint per cache |
| `model_cache_loads_total{cache}` | Load rate — a proxy for cold-start cost |
| `model_cache_evictions_total{cache,reason}` | **Thrash detector.** See below. |
| `vram_free_bytes{device}` | Only present when NVML is live |

**Reading the eviction panel**

- `reason="ttl"` rising steadily → normal idle release.
- `reason="lru"` high **and** `loads_total` tracking it → **thrash**: models are
  being evicted and immediately reloaded. Raise `maxModels`, or raise
  `ttlSeconds`.
- `reason="vram"` non-zero → the GPU is oversubscribed. Lower `maxModels` or
  `vramBudgetMb` for the noisiest service, or move a service off the card.
- Load rate ≈ request rate → the TTL is shorter than your traffic gaps; raise it.

---

## 6a. The cache inventory (which `cache=` label is what)

Every in-process cache reports under a `cache` label on the metrics in §6.

| `cache=` | Service | Holds | Notes |
|---|---|---|---|
| `stt_model_cache` | stt-v2 | ASR/VAD/diarization models, by slug | The only cache with an **MB budget** (`stt.modelCache.maxMemoryMb`) as well as a count bound |
| `nlp_model_cache` | nlp | NER / text- and token-classification models | Three singletons share the label |
| `guardrail_model_cache` | guardrail | GLiNER + the MiniCheck scorer | |
| `harness_minicheck` | harness **worker** | The MiniCheck-Flan-T5 GGUF entailer | Lives in the **Temporal worker** process, not the FastAPI app — see below |
| `tts_kokoro` · `tts_indic_parler` · `tts_indic_f5` | tts-v2 | One pipeline/model handle each | `maxModels` is 1 per engine by construction |

**Two cache classes, one policy.** Most services use the asyncio cache
(`ModelCache`). The harness entailer uses `SyncModelCache` — the same policy
engine with a thread lock instead of an event loop, because its consumer
(`_atomic_fact_entailer`) is synchronous and a `llama_cpp.Llama` construction is
a blocking CPU/GPU call rather than awaited I/O. **Operationally they are
identical**: same TTL clamp, same `ttl → lru → vram` order, same pin semantics,
same `CacheStats`, same metric names and reason labels. Nothing in this runbook
differs between them.

**Where the harness entailer actually lives.** It is loaded by a Temporal
*activity*, so its weights are resident in the **worker** process
(`pnpm dev:harness:worker`), not in the harness FastAPI app. The worker runs its
own periodic sweep (every 60 s) so an idle entailer is released even when no
further verification arrives. Restarting only the FastAPI app will NOT free it —
restart the worker.

The same placement applies to its **retention refresh** (TASK-535): the worker's
housekeeping tick pulls `harness.modelCache.*` and reconfigures the entailer
cache immediately before sweeping against it. A refresher in the harness FastAPI
app would be a no-op — that process holds no entailer. So a `harness.modelCache.
ttlSeconds` change lands within ~60 s **of the worker**, and if the worker is
down it lands when the worker comes back, not when the API restarts.


## 7. tts-v2: the health-semantics change

Local TTS engines (Kokoro, IndicParler, IndicF5) used to load at boot and
register **only if** the load succeeded. They now register unconditionally and
load on first use.

**What changed for you:** a broken/missing model file used to show up as a
*missing provider* at boot. It now shows up as a **503 on the first synth
request** for that voice.

To restore fail-at-boot: set `TTS_WARMUP_ENABLED=true`. The engine warms during
startup again — but it still registers either way, so a failure is loud in the
logs rather than silently removing a route.

**TASK-530 completion note.** TASK-529 made all three engines lazy but put only
**Kokoro** behind the cache, so IndicParler and IndicF5 loaded on first use and
then stayed resident forever. All three are now TTL-unloaded on the same terms,
and each zeroes its `tts_model_loaded{model=…}` gauge on release.

---

## 8. Runbook — common tasks

**"Models are reloading too often / first requests are slow."**
Check `model_cache_evictions_total{reason="ttl"}` and `loads_total`. Raise
`<svc>.modelCache.ttlSeconds` (max 3600). Takes effect within ~60 s.

**"The GPU is out of memory."**
Check `model_cache_resident_models` per service and `vram_free_bytes`. Lower
`maxModels` for the largest consumer, or set `vramBudgetMb`. For Ollama, also
set `OLLAMA_MAX_LOADED_MODELS` — HOPE's budgets do not bound the Ollama server.

**"A retention change didn't take effect."**
1. Each service's `/api/v1/health` has an effective-config diagnostics block —
   check `last_refresh_ok` and the `sources` labels.
2. `source: "env-fallback"` means no DB override is winning: either the key is
   unset, or the control-plane read failed and the service kept its env value.
3. Refresh is read-triggered with a ~60 s TTL — an idle service refreshes on its
   next request, not on a timer.

**"The harness is holding a GGUF and I restarted the service."**
The MiniCheck entailer lives in the **Temporal worker** process, not the harness
FastAPI app (§6a). Check `model_cache_resident_models{cache="harness_minicheck"}`
and restart `pnpm dev:harness:worker` — or just wait: the worker sweeps every
60 s and releases it once idle past `harness.modelCache.ttlSeconds`.

**"I changed `ttlSeconds` in the console and nothing happened."**
First check §2a — before TASK-535, guardrail / harness / tts-v2 did not read the
control plane at all. On a build that has it: the refresh is **read-triggered**,
so a service with no traffic has not polled yet — issue one request (or, for
harness, wait one 60 s worker tick). If it still has not moved, the fetch is
failing and the service is on its env fallback: check the service log for
`<svc>.effective_config.fetch_error` and confirm its gateway URL and
`X-Service-Token`.

**"I need a model to stay loaded permanently."**
Set `ttlSeconds = 3600` (the maximum). There is deliberately no "never evict"
setting — E6 specifies a 1-hour cap. For a genuinely dedicated model, use a
launch-time-resident engine (vLLM / llama.cpp server) instead.

---

## 9. Related

- Contract + conformance clauses: `packages/py-runtime-models/README.md`
- Tickets: `docs/implementation/TASK-529-Model-Lifecycle-Retention/README.md` (contract + first adoption wave), `docs/implementation/TASK-530-Lifecycle-Convergence-Tail/README.md` (harness D-08, stt-v2 convergence, D-09 completion) and `docs/implementation/TASK-535-Retention-Client-Adoption/README.md` (guardrail / harness / tts-v2 control-plane clients — the last three env-only services)
- Config plane: `docs/implementation/TASK-525-*` (effective-config read path)
- Ollama: <https://docs.ollama.com/faq> · LM Studio:
  <https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict>
