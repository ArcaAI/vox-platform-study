# TASK-996 — LM Studio Serving Control & VRAM Observability

| Field | Value |
|---|---|
| **Status** | `Pending` — plan written, **awaiting owner decisions D-1 … D-7** |
| **Type** | `feature` (spans infrastructure, database, services, API, console) |
| **Branch** | `dev-2.2` |
| **Raised** | 2026-09-21, from a 6h text-generation performance review |
| **Depends on** | TASK-995 (context 131072 → 65536) — **committed in `hope-v2-deployment`, NOT yet pushed** |

---

## 1. Requirement Analysis

Owner request, 2026-09-21:

> move those configurations (default context length for text generation task, parallel
> config, KV cache quantization) to the admin console for platform admin to manage;
> including load and unload models. We also need to allow platform admin to monitor the
> NVRAM consumed by models/process/thread. […] check if lm-studio is able to utilize
> 2 GPUs, when loading and handling different models. […] can platform admin set gpu for
> handle what model?

Six deliverables:

| # | Ask | Verdict after investigation |
|---|---|---|
| R-1 | Default context length → console | Reachable |
| R-2 | Parallel slots → console | Reachable |
| R-3 | KV cache quantization → console | **Blocked on Phase 1** (SDK loader) |
| R-4 | Load / unload models from the console | Reachable, with a **JIT caveat** (§2.5) |
| R-5 | Monitor NVRAM by model / process / thread | Model ✅, process ✅ (new exporter), **thread ❌ impossible** |
| R-6 | Platform admin assigns a model to a GPU | **Yes — `gpuSplitConfig`**, blocked on Phase 1 |

This request is a **correction, not scope creep.** `00-project-context.md` §Configuration
Principles already says a value that must change without a restart is DB-tier, not env.
`LMS_CONTEXT` and `LMS_PARALLEL` are env vars on the Deployment today, so every change to
them is a manifest edit plus a pod restart. They are in violation of the platform's own
rule, and moving them into the governed tier is what the rule asks for.

---

## 2. Current State Evaluation

All figures measured on the live `hope-v2-dev` pod `hope-lmstudio-86bdb6ff75-vvgjc`
on 2026-09-21 via Rancher `kubernetes_exec`, Grafana/Prometheus and Loki.

### 2.1 What is actually running

```
llama-server --ctx-size 131072 --parallel 10 --split-mode layer --main-gpu 0
             --cache-type-k f16 --cache-type-v f16 --flash-attn off
             --n-gpu-layers 999999 --batch-size 2048 --ubatch-size 512 --threads 18
             --kv-offload --kv-unified --ctx-checkpoints 32
```

`lms ps` reports the model at **3.35 GB**. `nvidia-smi --query-compute-apps` reports the
same PID holding **4,996 MiB on GPU0 and 8,908 MiB on GPU1 — 13.9 GiB total**. The
~10.5 GiB delta is f16 KV cache: LM Studio gives **every parallel slot the full context**,
so residency is `context × parallel` = 131072 × 10 = 1.31M KV slots, for prompts that
measured ~6k tokens.

Measured throughput: **6.2 tok/s decode, ~400 tok/s prefill, 94.6 s average end-to-end**
for a 3.35 GB model on an RTX 2000 Ada.

### 2.2 Why it is slow — three compounding causes, not yet isolated

1. **`--flash-attn off`.** Naive attention. Also the reason KV is f16: llama.cpp requires
   flash attention for V-cache quantization.
2. **Split across both GPUs.** 13.9 GiB does not fit one 16 GiB card beside the STT
   models, so `--split-mode layer` spread the layers and every token pays a PCIe hop.
3. **GPU time-slicing ×3.** LM Studio contends with `hope-stt` and `hope-stt-worker`.

**These have not been separated.** Phase 0 measures after the already-committed
`context × parallel` reduction; the remaining gap attributes to (1) and (3).

### 2.3 The reachability wall — this is what shapes the whole plan

| Surface | Can set |
|---|---|
| `lms load` CLI | `--gpu <ratio>`, `--context-length`, `--parallel`, `--ttl`, `--identifier`, `--estimate-only`. **No flash-attn, no KV-quant, no device selection** |
| `POST /api/v1/models/load` REST | `model, context_length, flash_attention, offload_kv_cache_to_gpu, eval_batch_size, num_experts, parallel`. Every other key → `unrecognized_keys` (TASK-995 §measured) |
| `~/.lmstudio/settings.json` | `defaultContextLength` (JIT), `jitModelTTL`, `modelLoadingGuardrails`, `runtimeLogVerbosityLevel` |
| `config-presets/` | Empty, and `experimentalLoadPresets: false` |
| **`@lmstudio/sdk` kvConfig over websocket** | **Everything else**, including the three keys we need |

The daemon bundle carries the fields; only the *transport* is missing. Confirmed present
in `~/.lmstudio/extensions/plugins/*/node_modules/@lmstudio/sdk/dist/index.d.ts`:

- `llm.load.llama.kCacheQuantizationType` / `vCacheQuantizationType`
- `llm.load.llama.flashAttention`
- `llm.load.llama.gpuSplitConfig`

**`@lmstudio/sdk` version 1.5.0 is already inside the image**, vendored under two bundled
plugins. Phase 1 is therefore a transport change, not a new dependency — though the SDK
must be installed as a first-class dependency of the entrypoint, never imported out of a
plugin's `node_modules`, which is incidental and may vanish on an LM Studio upgrade.

### 2.4 R-6 answered: yes, per-model GPU assignment is supported

```ts
gpuSplitConfig: {
  strategy: "custom" | "evenly" | "priorityOrder" | "tensor";
  disabledGpus: number[];
  priority:     number[];
  customRatio:  number[];
}
```
— `@lmstudio/sdk@1.5.0`, `index.d.ts:2890`. `LLMSplitStrategy = "evenly" | "favorMainGpu"`
is the older, narrower sibling type; `gpuSplitConfig.strategy` is the one in force.

This is a **load-time, per-model** field, so different models can be pinned to different
cards. `disabledGpus: [1]` confines a model to GPU0; `strategy: "priorityOrder"` with
`priority: [1, 0]` prefers GPU1. The default is `"evenly"`, which is exactly what produced
the 4,996 / 8,908 MiB split observed in §2.1.

Two facts that make this actionable:

- The container sees **both** physical cards (`nvidia-smi -L` lists GPU 0 and GPU 1),
  and `NVIDIA_VISIBLE_DEVICES=void` because the GPU Operator injects devices via CDI.
- Therefore **`nvidia.com/gpu: 4` on the Deployment is capacity bookkeeping only.** It does
  not pin, restrict or reserve a card. Placement is entirely LM Studio's decision, which is
  precisely why `gpuSplitConfig` is the correct lever and a k8s resource change is not.

### 2.5 Constraints the design must absorb

| Constraint | Consequence |
|---|---|
| Context / parallel / flash-attn / gpuSplit are **load-time** | A console change means unload + reload, which **drops in-flight generations**. The console cannot present these as ordinary settings that save silently |
| **JIT loading cannot be disabled** (no CLI, no REST, no settings key — TASK-824 measured) | "Unload" is **advisory**: the next inference request reloads the model. The console must say so |
| `unloadPreviousJITModelOnLoad: true`, `jitModelTTL: 3600s`, `defaultContextLength: 8192` | `granite-guardian-4.1-8b` is JIT-loaded, so it is **not** covered by `LMS_LOAD` and comes up on JIT defaults. Managing only the preloaded model leaves the guardrail model unmanaged |
| `modelLoadingGuardrails: { mode: "high", customThresholdBytes: 4 GiB }` | LM Studio already has a built-in load guard. The platform guard must **compose with** it, not duplicate or fight it |
| One `hope-lmstudio` replica | A `GlobalSetting` is platform-wide and has no instance identity. Fine today; a second serving node would need per-instance addressing |
| `/ai-services/*` is documented **READ-ONLY** — `engine-screen.tsx`: *"the console reports engine state and never mutates the workload"* | This ticket reverses that stance. It needs an explicit owner decision, not a quiet edit |

### 2.6 NVRAM observability — what is and is not possible

| Granularity | Source | Status |
|---|---|---|
| Per **device** | `DCGM_FI_DEV_FB_USED` | ✅ already in Prometheus |
| Per **process** | `nvidia-smi --query-compute-apps=pid,used_gpu_memory` | ⚠️ **no exporter today** — dcgm-exporter publishes device-level only |
| Per **model** | `lms ps` SIZE (weights) + KV estimate from `context × parallel` | ⚠️ weights measured, KV **derived, not measured** |
| Per **thread** | — | ❌ **Impossible.** CUDA attributes memory to a process/context. There is no thread-level accounting in the driver, DCGM or NVML |

R-5's "thread" is not deliverable and should be struck from scope (D-5).

---

## 3. Owner Decisions Required

| # | Decision | Recommendation | Cost if we go the other way |
|---|---|---|---|
| **D-1** | Reverse the read-only stance of `/ai-services/*`? | **Yes**, as a separate super-admin **"Serving Control"** tab; existing tabs stay read-only | Knobs stay in the manifest; every change is a redeploy |
| **D-2** | Apply semantics for load-time knobs | **Explicit "Apply & reload"** with a confirm dialog naming the disruption, plus a drain. Never auto-apply on save | Auto-apply silently kills in-flight clinical generations |
| **D-3** | Replace `lms load` with an `@lmstudio/sdk` websocket loader? | **Yes.** It is the *only* path to R-3 and R-6, and it also unlocks `flashAttention`, likely the single biggest latency lever | R-3 and R-6 are undeliverable; KV stays f16 and split stays `evenly` |
| **D-4** | Manage JIT defaults (`defaultContextLength`, `jitModelTTL`) too? | **Yes** — otherwise `granite-guardian-4.1-8b` stays unmanaged on 8192/parallel-4 | Guardrail model invisible to the console and unconfigurable |
| **D-5** | Strike per-**thread** NVRAM from scope (physically impossible) | **Yes** — ship device + process + model | Nothing; the alternative cannot be built |
| **D-6** | Guard for load/unload (can OOM both cards, taking down text **and** guardrail together) | Super-admin imperative gate (`AUTH-NOTE`) + `@ForbidApiKey` + `--estimate-only` precheck + hard live-VRAM budget refusal | A mistyped context length takes out the whole AI plane |
| **D-7** | Where does per-model serving config live? | **`AiModel._metadata.serving`** on the SYSTEM row (§4.2), with a `GlobalSetting` platform default for models with no opinion | A flat `GlobalSetting` cannot express per-model GPU assignment, which is the core of R-6 |

---

## 4. Implementation Plan

Layer order per `01-development-workflow.md`: Database → Domain → Services → API → Console.
Phases 1–5 start only after D-1 … D-7 are answered.

### Phase 0 — deploy the already-committed fix and measure (no new code)

1. Push `hope-v2-deployment` (currently **5 commits ahead**, including TASK-995's
   context 131072 → 65536 and this review's `LMS_PARALLEL` 10 → 4 and s3fs silencing).
2. After Argo syncs, re-measure on the live pod:
   - `nvidia-smi --query-compute-apps` → did the model consolidate onto **one** card?
   - `text_tokens_per_second`, `text_time_to_first_token_seconds` → new baseline.
3. **This isolates cause (2) from causes (1) and (3) in §2.2** and is the control against
   which every later phase is judged. Record the numbers here before writing Phase 1.

> ⚠️ `lms load` exposes no device-selection flag, so llama.cpp may keep splitting
> `evenly` across both cards even once the model fits on one. If it does, that is *itself*
> the evidence that D-3 is mandatory rather than merely desirable.

### Phase 1 — SDK loader (unblocks R-3 and R-6)

- Add `@lmstudio/sdk@1.5.0` as a real dependency of `infrastructure/docker/lmstudio/`.
- Replace the `lms load` invocation in `entrypoint.sh` (lines ~411-415) with a small Node
  loader that drives the kvConfig stack: `flashAttention`, `kCacheQuantizationType`,
  `vCacheQuantizationType`, `gpuSplitConfig`, alongside the existing context/parallel/TTL.
- Keep `LMS_*` env vars as the **bootstrap floor** — the values the pod loads with before
  the database is reachable. The console governs steady state, env governs cold start.
- **Fail closed**: an unreachable or rejected kvConfig must refuse to serve, matching the
  existing `die "preload … failed"` posture. A pod that silently serves on different
  parameters than were requested is worse than one that does not come up.
- Tests: kvConfig assembly is unit-testable without a daemon; assert every key that
  TASK-995 measured as rejected over REST is now accepted over the websocket.

### Phase 2 — governed configuration

**2a. Per-model serving profile** (D-7). Extend `AiModel._metadata` with:

```jsonc
"serving": {
  "contextLength":  65536,
  "parallel":       4,
  "flashAttention": true,
  "kvCacheQuant":   { "k": "q8_0", "v": "q8_0" },
  "gpuSplit":       { "strategy": "priorityOrder", "priority": [0], "disabledGpus": [1] }
}
```

`AiModel` is already the catalogue and already carries `_metadata.contextLength`, so this
is the established home. SYSTEM rows are platform-owned and shared-read — no per-tenant
copy (`00-project-context.md` §"Content is cloned; configuration cascades"). This is
**configuration**, so it cascades; it is not content and must not be cloned.

**2b. Platform defaults** — a new `lmstudio-serving.descriptors.ts` in
`packages/applications/src/services/settings-registry/descriptors/`, carrying
`maxScope: 'system'`, `globalOnly: true`, `failMode: 'open-to-default'` for tuning knobs.
Covers the JIT defaults (D-4) and the fallback profile for models with no `serving` block.

> **Lockstep, inherited from TASK-995:** the served window and the declared
> `_metadata.contextLength` must agree. Over-claiming re-creates
> `exceed_context_size_error`; under-claiming is safe. Lower the served window first.

### Phase 3 — gateway control surface

New routes under the existing admin plane:

| Route | Notes |
|---|---|
| `GET  admin/inference-engines/lm-studio/runtime` | loaded instances, live config, VRAM |
| `POST admin/inference-engines/lm-studio/models/:key/load` | body = serving profile |
| `POST admin/inference-engines/lm-studio/models/:key/unload` | response states the JIT caveat |

- Class-level `@CanManage('AiModel')` + `@ForbidApiKey()` + `@RequiredSvcScopes(...)`, with
  the **real** gate imperative and super-admin-only — row-independent, so it may run first
  (the promotion-route precedent in `05-nestjs-api.md`). Carries an `// AUTH-NOTE:` marker.
- **Precheck before every load** (D-6): `--estimate-only` plus live `DCGM_FI_DEV_FB_USED`,
  refusing with a typed error when the estimate exceeds free VRAM. Compose with LM Studio's
  own `modelLoadingGuardrails`; do not disable it.
- Regenerate all five artifacts (`api:build`, `route-manifest`, `openapi`, `portal`,
  `vox-node gen:admin`) — `gen:admin` is not optional.

### Phase 4 — VRAM observability (R-5)

- **Per-process exporter.** Smallest correct option: a node-level textfile collector
  scraping `nvidia-smi --query-compute-apps=pid,used_gpu_memory,gpu_uuid` into
  node-exporter's textfile directory, joined to pods by PID namespace. Evaluate
  dcgm-exporter's process-metrics mode first — preferring an existing component to a new one.
- **Per-model** panel from `GET .../runtime`: weights from `lms ps`, KV **derived** from
  `context × parallel` and clearly labelled as an estimate, never as a measurement.
- Grafana row on the existing LM Studio dashboard: per-device FB, per-process FB,
  per-model residency, and headroom against the 16,380 MiB ceiling per card.

### Phase 5 — admin console

Extend `/ai-services/lm-studio` (tier 10-19, super-admin) with a **Serving Control** tab:

- Model table: state, identifier, weights, context, parallel, **assigned GPU(s)**, TTL.
- Per-model editor for the §2a profile, including a GPU picker bound to `gpuSplitConfig`.
- Load / unload actions behind a confirm dialog that names the disruption (D-2) and the
  JIT caveat (§2.5), with the precheck estimate shown *before* the button is armed.
- VRAM panel per card with headroom, fed by Phase 4.
- `Skeleton` loading states, `ScreenTemplate` regions, both themes, axe clean.

---

## 5. Verification Criteria

- [ ] Phase 0 baseline recorded here: tok/s, TTFT, and per-card VRAM **before and after**
- [ ] KV quantization demonstrably applied — `llama-server` cmdline shows `--cache-type-k`/`-v` ≠ `f16`
- [ ] `--flash-attn` shows `on`, with a before/after latency measurement
- [ ] A model pinned via `disabledGpus` is confirmed resident on **one** card by `nvidia-smi`
- [ ] Load precheck refuses an over-budget context length instead of OOMing the node
- [ ] Cross-tenant e2e: the new admin routes return 403 for a tenant admin, 404 for a foreign id
- [ ] `pnpm --filter @arcaai/admin-console build lint test` green; axe 0 violations
- [ ] `pnpm api:openapi:check`, `api:portal:check`, `vox-node gen:admin:check` green
- [ ] Per-process VRAM visible in Grafana and attributable to a pod

## 6. Implementation Summary

_Not started — awaiting D-1 … D-7._

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-21 | Ticket opened from a 6h text-generation performance review. Plan written; measured the LM Studio reachability wall (§2.3), confirmed per-model GPU assignment via `gpuSplitConfig` (§2.4), and established that per-thread VRAM is impossible (§2.6). Awaiting owner decisions. |
