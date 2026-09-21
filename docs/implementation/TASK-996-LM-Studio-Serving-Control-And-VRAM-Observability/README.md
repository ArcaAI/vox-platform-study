# TASK-996 — LM Studio Serving Control & VRAM Observability

| Field | Value |
|---|---|
| **Status** | `In Progress` — D-1 … D-7 accepted; Phase 0 complete, Phases 1/2/4 in flight |
| **Type** | `feature` (spans infrastructure, database, services, API, console) |
| **Branch** | `dev-2.2` |
| **Raised** | 2026-09-21, from a 6h text-generation performance review |
| **Depends on** | TASK-995 (context 131072 → 65536) — **deployed 2026-09-21** as `hope-v2-deployment@c44fe16` |

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

#### Phase 0 RESULT — executed 2026-09-21, revision `c44fe16`

Deployed `LMS_CONTEXT` 131072 → 65536 and `LMS_PARALLEL` 10 → 4. Pod
`hope-lmstudio-86bdb6ff75-vvgjc` → `hope-lmstudio-7b69c877d8-7549p`.

| Measure | Before | After | Δ |
|---|---|---|---|
| `lms ps` CONTEXT / PARALLEL | 131072 / 10 | **65536 / 4** | applied |
| VRAM, GPU0 | 4,996 MiB | **2,668 MiB** | −47% |
| VRAM, GPU1 | 8,908 MiB | **4,814 MiB** | −46% |
| **VRAM total** | **13,904 MiB** | **7,482 MiB** | **−46%** |
| s3fs log rate | ~11,200 lines/min | **0 lines/min** | eliminated |

**The model is STILL SPLIT ACROSS BOTH GPUS.** GPU0 now has 13.7 GiB free and GPU1
11.5 GiB free — the whole 7.48 GiB working set would fit on *either* card with room to
spare, and llama.cpp split it anyway.

**This is the decisive evidence for D-3.** The split is not a consequence of VRAM
pressure; it is `gpuSplitConfig.strategy` defaulting to `"evenly"`. No amount of context
or parallel reduction will fix it, because capacity was never the binding constraint.
Only the SDK loader (Phase 1) can reach that field.

Still unchanged and still costing latency: `--flash-attn off` and
`--cache-type-k f16 --cache-type-v f16`. Both are Phase 1 deliverables.

**Throughput re-measurement is DEFERRED** — the window since the rollout carried no
generation traffic, so there is no post-change tok/s sample yet. Baseline to beat:
**6.42 tok/s** across 26 completed generations, 94.6 s average latency, 15.0 s TTFT.

### 2.7 Flash attention — measured 2026-09-21, and it is the single biggest lever

`llama-server`'s own default for `--flash-attn` is **`auto`**. LM Studio was passing
**`off` explicitly**, overriding that autodetect. Root cause is twofold: the SDK schema
declares `.field("flashAttention", "boolean", {}, false)` — default **false** — and a
PERSISTED per-model load config was pinning it.

Measured on the live pod, direct to LM Studio (no gateway, no guardrail, no judge),
identical model, `--ctx-size 65536`, `--parallel 4`:

| | `--flash-attn off` | `--flash-attn auto` | Δ |
|---|---|---|---|
| Decode, 200 tokens | 12,852 / 13,017 ms | **3,019 / 3,021 / 3,188 ms** | **4.3× faster** |
| Decode rate | ~15.5 tok/s | **~66 tok/s** | |
| Prefill, 6,016 tokens | — | **~1,400 ms (~4,300 tok/s)** | vs ~400 tok/s via the gateway baseline |
| VRAM (both cards) | 7,482 MiB | **5,034 MiB** | **−33%** |

Flash attention also *reduces* VRAM, by removing the O(n²) attention compute buffer — so
it is not a speed/memory trade, it is strictly better on both axes.

⚠️ **The live pod currently runs `--flash-attn auto` as UNDECLARED DRIFT.** It reverted to
`auto` after the REST load attempts below cleared the persisted per-model config. A pod
restart may silently return it to `off` and the 4.3× would vanish with no manifest change
to explain it. Making this deterministic is exactly what Phase 1 is for — it is now the
highest-value item in this ticket, ahead of KV quantization.

### 2.8 `POST /api/v1/models/load` cannot load this model at all

TASK-995 established which KEYS that endpoint accepts. Measured 2026-09-21, the endpoint
nonetheless **fails to load `gemma-4-e2b-it-qat` under every payload tried**:

| Payload | Result |
|---|---|
| `{model, context_length, parallel, flash_attention}` | `model_load_failed` |
| `{model, context_length, flash_attention}` | `model_load_failed` |
| `{model, context_length}` — control, no new keys | `model_load_failed` |

The control failing is decisive: this is **not** about flash attention or `parallel`. The
REST load path is unusable for this deployment's `hope/`-published symlinked GGUFs, and
`lms load` (CLI) is the only working load path today. Any design that assumed REST could
load or reload a model is wrong — which removes the last alternative to Phase 1's SDK
transport.

### 2.9 GPU serving layout — measured 2026-09-21, and it is worse than §2.1 implied

`nvidia-smi --query-compute-apps` on the live pod, with BOTH LM Studio models resident:

| Process | GPU0 | GPU1 | total |
|---|---|---|---|
| `llama-server` PID 549 — `gemma-4-e2b-it-qat@q4_0` | 2,668 MiB | 4,814 MiB | 7,482 MiB |
| `llama-server` PID 2649 — `granite-guardian-4.1-8b` | 3,618 MiB | 3,078 MiB | 6,696 MiB |
| **free** | 9,654 MiB | 8,048 MiB | |

**Both models are layer-split across both cards.** §2.1 described this for gemma
alone; the guardrail model does it too. So every token of *both* models pays a
cross-device hop, and the two models contend for the SMs of *both* GPUs instead
of owning one each.

Each fits comfortably on a single 16 GiB card:

| Model | weights | KV at its own ctx x parallel | total | fits |
|---|---|---|---|---|
| gemma-4-e2b-it-qat | 3.35 GB | 65536 x 4 | ~7.5 GB | ✅ either card |
| granite-guardian-4.1-8b | 5.12 GB | 8192 x 4 | ~6.7 GB | ✅ either card |

The target layout is therefore **one model per card** — gemma pinned to GPU0,
guardian to GPU1 — which removes the interconnect traffic AND the mutual SM
contention in one change. It is reachable only through `gpuSplitConfig`
(§2.4), i.e. only after Phase 1.

**This is a hypothesis with a mechanism, not a measurement.** The interconnect
cost of `--split-mode layer` on this board is not yet isolated from flash
attention (§2.7) or from time-slicing contention. The matrix below is what
settles it, and no default should be changed on the strength of the reasoning
alone — that mistake already cost one outage today.

#### RESULT — Phase 1 live, matrix run 2026-09-21

Phase 1 deployed (`hope-v2` pipeline #1286, image `b8e375a1`) and verified from
the pod log BEFORE inferring anything from readiness:

```
lms-loader: resolved 'gemma-4-e2b-it-qat' to 'gemma-4-e2b-it-qat@q4_0'
lms-loader: loaded gemma-4-e2b-it-qat@q4_0 as "gemma-4-e2b-it-qat"
lms-loader: verified — all 3 requested kvConfig field(s) are in force
```

Then `LMS_FLASH_ATTENTION=true` + `LMS_GPU_SPLIT_STRATEGY=priorityOrder` /
`LMS_GPU_PRIORITY=0` / `LMS_GPU_DISABLED=1` (`hope-v2-deployment@4e7c93a`).
Effective args became `--flash-attn auto --main-gpu 0 --tensor-split 1`.

| Cell | flashAttn | split | decode, 200 tok | tok/s | VRAM |
|---|---|---|---|---|---|
| **A** control | off | evenly | 12,852–13,017 ms | **15.5** | 7,482 MiB over 2 cards |
| **B** | **on** | evenly | 3,019–3,188 ms | **66** | 5,034 MiB over 2 cards |
| **C** | on | **GPU 0 only** | 2,744–2,896 ms | **72** | **2,044 MiB on GPU 0** |

Prefill at C: **6,616 tokens in ~1,540 ms ≈ 4,300 tok/s**.

**The decomposition, isolated at last.** Flash attention is worth **4.26×**
(15.5 → 66); the GPU pin adds a further **~9%** (66 → 72). So §2.9's hypothesis
was directionally right but the *magnitude* was wrong — the cross-device hop was
never the dominant cost, flash attention was. Had the pin shipped alone it would
have looked like a rounding error and the real win would have been missed.

**End to end, against the original 6h-window baseline:**

| | before | after | |
|---|---|---|---|
| decode | 6.42 tok/s | **~72 tok/s** | **11.2×** |
| prefill | ~400 tok/s | **~4,300 tok/s** | **~10.8×** |
| VRAM | 13,904 MiB over 2 cards | **2,078 MiB on 1 card** | **−85%** |
| GPU 1 | 8,908 MiB held | **4 MiB — 15,946 free** | released |

Cell D (KV quantization) was **not run**: the owner directed KV stay
unquantized (f16), and at 2,078 MiB there is no residency pressure to relieve.

#### The measurement matrix, to run once Phase 1 is live

| # | flashAttention | gpuSplit | KV cache | measures |
|---|---|---|---|---|
| A | off | evenly (today) | f16 | the control — reproduces 15.5 tok/s |
| B | **on** | evenly | f16 | flash attention alone (expect ~66 tok/s, §2.7) |
| C | on | **disabledGpus:[1]** | f16 | the cross-GPU split cost, isolated |
| D | on | disabledGpus:[1] | **q8_0** | KV quantization on top |

Each cell: decode = 200 tokens at `temperature: 0`; prefill = a ~6k-token prompt
that is UNIQUE per run (LM Studio caches prompts — a repeated prompt measured
176 ms against a true 1,400 ms and would silently flatter every result).

#### Structural limits that no config reaches

- **Time-slicing, not MPS.** `base/gpu-time-slicing.yaml` sets `replicas: 3`,
  6 slices, 6/6 allocated. Time-slicing CONTEXT-SWITCHES the GPU between
  processes and gives no memory isolation; MPS runs kernels from several
  processes concurrently and generally suits multi-process inference better.
  Changing it is a GPU-operator change on a `system-node-critical` DaemonSet —
  an owner decision, and out of scope here.
- **70 W cards.** `power.limit` is 70.00 W on both RTX 2000 Ada. These are
  power-constrained by design; at idle they sit at 210 MHz against a 3,105 MHz
  max. No serving config raises that ceiling.
- **Speculative decoding is available and unexplored.** `lms load` exposes
  `--speculative-draft-mtp` / `--speculative-draft-simple` /
  `--speculative-draft-model`. For a 4.6B target a suitable draft model can pay
  for itself, but it needs a compatible small model in the bucket and its own
  measurement. Not attempted.

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

#### Phase 3 RESULT — shipped 2026-09-21, and one deliverable came back NEGATIVE

`/admin/inference-engines/lm-studio/*`, super-admin only (`LmStudioServingService`,
`InferenceEnginesController`). Two of the three routes do what the plan said. The third
cannot, and the reason is a measurement rather than a shortfall:

| Route | Verdict |
|---|---|
| `GET .../runtime` | **Works.** Engine reachability, per-device VRAM from DCGM, every loaded instance with the config the ENGINE applied, and the `lmStudio.serving.*` platform default |
| `POST .../models/:identifier/unload` | **Works.** `POST /api/v1/models/unload {instance_id}` is reachable over HTTP and answers `404 model_not_found` for an instance that is not loaded — both verified against the live pod. Still ADVISORY: JIT reloads on the next request, on the JIT defaults |
| `POST .../models/:modelKey/load` | **Cannot dispatch. 501 `ENGINE_LOAD_UNSUPPORTED`** after the full gate chain |

**A remote reload is NOT achievable on this build.** Three paths, all closed to the gateway:

1. `POST /api/v1/models/load` — the route exists (`{}` answers `400 missing_required_parameter: model`, so it is not a 404), but §2.8 measured it failing `model_load_failed` for every payload including the control. It also carries no field for KV-cache quantization or GPU placement, so even a working version could not deliver R-3 or R-6. **The service never calls it** — calling it is what left the engine with no model loaded during the §2.8 measurement.
2. `lms load` — CLI, inside the pod.
3. The `@lmstudio/sdk` kvConfig websocket — the one thing that works, and `loader/load.mjs` dials it on **loopback** at pod boot (`ws://127.0.0.1:1234`). Reaching it from the gateway would mean adding `@lmstudio/sdk` as an `apps/api` runtime dependency and exposing the daemon's load channel across the cluster; that is an owner decision, not a Phase 3 detail.

So `load` runs privilege → existence → profile coherence → live VRAM budget and then refuses
honestly. The 501 body carries the same `applied` / `sources` / `estimateBytes` the 202 would,
which is what Phase 5's "show the precheck before the button is armed" actually reads, plus a
`remedy` naming the working path (write the profile, restart the workload).

Other facts worth recording, all measured on `hope-lmstudio-7b69c877d8-7549p`:

- **No version endpoint.** `/api/v1/version` and every sibling 404; only `lms version` in-pod answers. `engine.version` is therefore optional and absent rather than invented.
- **No busy/idle over HTTP.** `lms ps` shows `IDLE`/`ACTIVE`; `GET /api/v1/models` reports only that an instance exists. A loaded instance always reads `IDLE`.
- **No `DCGM_FI_DEV_FB_TOTAL`** on this exporter, so the ceiling is reconstructed as used + free + reserved (1,445 + 14,504 + 430 = 16,379 MiB, i.e. the card).
- **The 409 budgets against the BEST SINGLE CARD**, matching the dashboard's own "best single-card headroom" panel. `force: true` bypasses that gate and nothing else.
- **`kvCacheEstimateBytes` is arithmetic, not observation.** One calibrated constant (7.25 KiB per KV slot at f16, from used-minus-weights over `context × parallel` on the live pod), scaled by the K/V element types. Stated as an estimate in the DTO, the Swagger text and the code.

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
| 2026-09-21 | Ticket opened from a 6h text-generation performance review. Plan written; measured the LM Studio reachability wall (§2.3), confirmed per-model GPU assignment via `gpuSplitConfig` (§2.4), and established that per-thread VRAM is impossible (§2.6). |
| 2026-09-21 | **Phase 1 deployed, CrashLoopBackOffed, rolled back.** First diagnosis — a model-index race — was WRONG, and the fix written for it would have failed the same way. Real cause: `gemma-4-e2b-it-qat` is not a model key. The daemon carries `gemma-4-e2b-it-qat@?` (CLIP mmproj, typed `llm`) and `gemma-4-e2b-it-qat@q4_0`; the bare string is the loaded INSTANCE's `id`. `lms load` succeeded by prefix-matching ("the first matching model"); the raw SDK `loadModel` channel demands the exact key. **The s3fs mount was never implicated** — `lms ls` reported all 7 models / 15.96 GB throughout. Fixed with `selectModelKey` (pure, unit-tested against the live `/api/v1/models` payload), which refuses on ambiguity rather than guessing between a projector and a model. A second bug in my own fix was caught the same way: the endpoint answers `{models:[…]}`, not `{data:[…]}`. |
| 2026-09-21 | **Flash attention measured: 4.3× decode (15.5 → 66 tok/s), ~4,300 tok/s prefill, −33% VRAM** (§2.7). `llama-server` defaults to `auto`; LM Studio was overriding it to `off`. Also established that `POST /api/v1/models/load` cannot load this model under ANY payload, control included (§2.8) — `lms load` is the only working path, so Phase 1's SDK transport has no alternative. During this measurement the REST attempts left LM Studio with no model loaded; restored via CLI. |
| 2026-09-21 | Owner accepted D-1 … D-7 as recommended. **Phase 0 executed** (deployment revision `c44fe16`): VRAM 13,904 → 7,482 MiB (−46%), s3fs logging ~11,200 → 0 lines/min. The cross-GPU split PERSISTED with ~12 GiB free on each card, confirming it is `gpuSplitConfig.strategy: "evenly"` and not VRAM pressure — D-3 is now evidence-backed, not merely recommended. Phases 1, 2 and 4 running in parallel lanes. |
| 2026-09-21 | **Phase 3 shipped** — `/admin/inference-engines/lm-studio/*`, super-admin only. `runtime` and `unload` work against the live engine (`POST /api/v1/models/unload {instance_id}` verified reachable, 404 `model_not_found` for an unloaded instance). `load` came back NEGATIVE: no gateway-reachable loader exists on this build, so it runs the full gate chain (403 → 404 → 400 → 409) and then refuses 501 `ENGINE_LOAD_UNSUPPORTED` rather than calling the endpoint §2.8 measured as broken. Also measured: no version endpoint, no busy/idle over HTTP, no `DCGM_FI_DEV_FB_TOTAL`. |
