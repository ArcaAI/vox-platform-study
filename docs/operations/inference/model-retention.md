# Model Retention & Lifecycle — Operator Runbook

**Owner**: Platform / Inference · **Introduced**: TASK-529 · **Last updated**: 2026-07-20

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
| In-process (stt-v2 loaders, GLiNER, NLP transformers, MiniCheck, Kokoro/IndicParler) | **HOPE** | The shared cache: `ttl → lru → vram` eviction, per-service budgets |
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

**"I need a model to stay loaded permanently."**
Set `ttlSeconds = 3600` (the maximum). There is deliberately no "never evict"
setting — E6 specifies a 1-hour cap. For a genuinely dedicated model, use a
launch-time-resident engine (vLLM / llama.cpp server) instead.

---

## 9. Related

- Contract + conformance clauses: `packages/py-runtime-models/README.md`
- Ticket: `docs/implementation/TASK-529-Model-Lifecycle-Retention/README.md`
- Config plane: `docs/implementation/TASK-525-*` (effective-config read path)
- Ollama: <https://docs.ollama.com/faq> · LM Studio:
  <https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict>
