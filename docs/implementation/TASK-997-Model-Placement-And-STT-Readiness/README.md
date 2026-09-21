# TASK-997 — Model Placement Control & STT Model-Aware Readiness

| Field | Value |
|---|---|
| **Status** | `Pending` — plan written, **awaiting owner decisions D-1 … D-8** |
| **Type** | `feature` (spans infrastructure, python services, applications, API, console) |
| **Branch** | `dev-2.2` |
| **Raised** | 2026-09-21, from the TASK-996 review |
| **Depends on** | **TASK-996** — specifically its blocked `load` path (§2 below). Track A cannot ship without it |

---

## 1. Requirement Analysis

Owner request, 2026-09-21:

> * for LM Studio, we need to allow platform admin to align/allocate model to each
>   available GPUs or CPU. For example, there are 2 GPUs (0, and 1) available for
>   lm-studio service: it should allow the platform admin to load, control the model
>   load hyper parameter, TTL, including which GPU will be used for handing model.
> * for stt and stt health check endpoint, we need it fit to k8s, the service MUST BE
>   healthy and ready for handing any models. and we will allow platform admin to
>   configure TTL when loading a model based on request/transcription agent/workflow.
>   A dashboard for platform admin to see loaded models, memory consuming by each
>   model, any task is handing...

Two tracks, one theme: **a platform admin should decide where a model runs, how long it
stays, and be able to see both.**

| # | Ask | Track | State after TASK-996 |
|---|---|---|---|
| R-1 | Allocate an LM Studio model to a specific GPU | A | Mechanism proven, **not reachable from the console** (§2.1) |
| R-2 | Allocate an LM Studio model to **CPU** | A | **Already reachable** — `LMS_GPU=off` → `offloadRatio: 0` (§2.2) |
| R-3 | Control load hyper-parameters per model | A | Modelled and validated; same reachability wall as R-1 |
| R-4 | Per-model TTL on LM Studio | A | `LMS_TTL` exists at the bootstrap floor only; not per model, not governed |
| R-5 | STT readiness that means "can handle models" | B | **Deliberately the opposite today** (§2.3) — needs an owner reversal |
| R-6 | STT TTL per request / agent / workflow | B | One global env knob, clamped 60–3600s (§2.4) |
| R-7 | Platform dashboard: loaded models, memory each, in-flight work | B + A | Partly available; no single surface (§2.5) |

---

## 2. Current State Evaluation

### 2.1 Track A is blocked on exactly one thing, and it is TASK-996's

TASK-996 proved every mechanism R-1/R-3 need. `gpuSplitConfig` works — measured on the
live pod 2026-09-21, pinning gemma to GPU 0 moved it from `2,668 MiB GPU0 + 4,814 MiB
GPU1` to **`2,078 MiB on GPU 0 alone, GPU 1 at 4 MiB`**, and the effective engine args
became `--main-gpu 0 --tensor-split 1`.

What does NOT work is applying it **from the console**:

- `POST /api/v1/models/load` (LM Studio REST) **cannot load this model at all** — every
  payload fails, including a no-new-keys control (TASK-996 §2.8).
- The `@lmstudio/sdk` kvConfig websocket is **loopback-only inside the pod**.
- So the gateway route TASK-996 built answers **501 `ENGINE_LOAD_UNSUPPORTED`**.

Today the only working path is the **bootstrap floor** — `LMS_*` env on the Deployment,
which means a manifest edit and a pod restart for every placement change. That is
precisely the `env`-tier violation `00-project-context.md` §Configuration Principles
exists to prevent, and it is why R-1/R-3/R-4 are a ticket rather than a config edit.

**Track A is therefore one decision wide** (D-1): how does the gateway reach the
daemon's load channel? Everything else in Track A is downstream of that answer.

### 2.2 CPU placement is already reachable, and is NOT the same as "no GPU"

`LMS_GPU` maps to `llm.load.llama.acceleration.offloadRatio`, canonicalised
`max → 1`, `off → 0`, or any 0–1 ratio (pinned by the loader's unit tests). So:

| Intent | Setting |
|---|---|
| Full GPU | `offloadRatio: 1` |
| **CPU only** | `offloadRatio: 0` |
| Partial offload | `0 < ratio < 1` |

R-2 needs no new mechanism — only the same console reach as R-1, plus modelling
`offloadRatio` on the serving profile (TASK-996's `AiModelServingProfile` does not carry
it yet; it is env-only).

⚠️ **A CPU-placed model is not free.** The container's limits are `cpu: 8` /
`memory: 20Gi`; a 3.35 GB q4_0 model on CPU will contend with the node's 48 vCPU shared
with six Python services, and decode will be an order of magnitude slower than the
~72 tok/s measured on GPU 0. CPU placement is a fallback for capacity exhaustion, not a
tier to schedule onto casually. The console must show that, not hide it behind a toggle.

### 2.3 STT readiness today is the DELIBERATE OPPOSITE of the ask

`apps/stt/src/stt/health/api/routes.py`:

| Probe | What it checks |
|---|---|
| `/health/startup` | only that `app.state.service_release_task` exists |
| `/health/ready` | `_check_database`, `_check_minio`, `_check_redis`, then **draining state** |
| `/health/live` | process liveness |

`/health/ready` **never looks at model residency**, and `/health/startup` says so in
terms:

> Deliberately NOT gated on model residency or on any dependency. Those are
> `/health/ready`'s job; re-checking them here would make a slow dependency or a lazy
> model load look like a failed START and restart a healthy pod.

That rationale is sound and must be answered, not ignored. Three real hazards if
readiness starts gating on models:

1. **Which models?** STT resolves ASR per agent (`ResolvedAsrSpec`, TASK-861). "Any
   model" is an open set — gating on all of them is unbounded; gating on a default set
   is a policy someone must author.
2. **TTL eviction would flap the pod.** `model_cache_ttl_seconds` evicts idle models
   (60–3600s). If readiness requires residency, a quiet period evicts the model, the pod
   goes NotReady, k8s pulls it from Endpoints — and the only thing that would reload it
   is the traffic that was just removed. **This is a deadlock, not a race.**
3. **Draining already uses readiness** as its mechanism — a draining pod fails `/ready`
   so k8s removes it from Endpoints. A second, unrelated reason to fail the same probe
   makes "why is this pod out of rotation?" ambiguous at exactly the wrong moment.

The honest reading of the ask is **"a pod in Endpoints must be able to serve a
transcription without a cold-start stall"** — which is a *warmth* guarantee, and warmth
is not the same signal as readiness. D-4 chooses between them.

### 2.4 STT TTL is one global env knob

`model_cache_ttl_seconds` (`core/config/settings.py:270`), product-clamped 60–3600s,
with "active sessions pin models so TTL applies" to idle ones. It is:

- **env-tier**, so it cannot change without a restart — the same violation as §2.1;
- **global**, so a 20-minute clinic workflow and a one-off batch job share one number.

R-6 wants it per **request / agent / workflow**. The natural home is the existing
per-request contract: `ResolvedAsrSpec` already carries the gateway-resolved model
selection into STT for both streaming and batch, so a TTL field there rides an
established path rather than inventing one. The per-agent default belongs on the agent,
the platform floor in the settings registry.

### 2.5 The dashboard is half-built and scattered

| Signal | Today |
|---|---|
| LM Studio loaded models + config | `lms ps` / `GET /api/v1/models` — TASK-996's `/runtime` route surfaces it |
| STT loaded models | a model-cache stats endpoint exists in `health/api/routes.py` |
| **VRAM per device** | ✅ DCGM, in Prometheus |
| **VRAM per model** | ⚠️ LM Studio: weights measured, KV **estimated**. STT: not exposed |
| **VRAM per process** | ❌ needs the GPU-operator upgrade (TASK-996 Lane C) |
| **In-flight work** | STT: session manager knows; LM Studio: `lms ps` shows IDLE/ACTIVE only |
| **One admin surface** | ❌ does not exist |

⚠️ Two traps carried over from TASK-996, both measured:
- **Never aggregate DCGM by `pod`.** There is exactly one series per device carrying a
  single arbitrary, churning pod label. `rate()` breaks across every rollout.
- **Per-thread VRAM is impossible.** CUDA attributes memory to a process/context.

---

## 3. Owner Decisions Required

| # | Decision | Recommendation | Cost of the alternative |
|---|---|---|---|
| **D-1** | How does the gateway reach LM Studio's load channel? (a) add `@lmstudio/sdk` to `apps/api` and expose the daemon websocket cluster-wide; (b) a small sidecar/control endpoint in the LM Studio pod that the gateway calls; (c) leave it at the bootstrap floor | **(b)** — keeps the websocket loopback, keeps `apps/api` dependency-free, and gives one authenticated seam to guard. (a) widens the blast radius of a channel that can OOM both cards | (c) means every placement change stays a manifest edit + restart, and R-1/R-3/R-4 do not ship |
| **D-2** | Model `offloadRatio` (CPU placement) on the serving profile | **Yes** — add to `AiModelServingProfile`; it is already reachable at the floor | R-2 stays env-only |
| **D-3** | Per-model TTL on LM Studio | **Yes**, on the serving profile, platform default in the registry | TTL stays one global number |
| **D-4** | STT: reverse §2.3, or add a separate warmth signal? | **Add a separate signal.** Keep `/health/ready` as dependencies + draining; add `/health/warm` (informational, never a probe) plus an optional **startup preload** of the tenant's default ASR model so a fresh pod is warm before it takes traffic | Gating `/ready` on residency risks the TTL/NotReady **deadlock** in §2.3(2) and muddies the draining signal |
| **D-5** | If D-4 picks warmth: what must be warm? | The **department/tenant default ASR agent's** model, resolved at startup — a bounded set, not "any model" | "Any model" is unbounded and cannot be satisfied |
| **D-6** | STT TTL per request/agent/workflow | **Yes** — field on `ResolvedAsrSpec` (gateway-resolved), per-agent default on the agent, platform floor in the registry, keeping the 60–3600s clamp | One global knob keeps clinic and batch on the same number |
| **D-7** | Dashboard scope | **One screen**, `/ai-services/…`, covering BOTH engines: loaded models, per-model memory (weights measured / KV **labelled estimate**), placement, TTL remaining, in-flight work | Two half-dashboards is how the DCGM `pod`-label trap gets re-learned |
| **D-8** | Does the dashboard need per-**process** VRAM (⇒ the GPU-operator upgrade)? | **Not for v1** — ship per-device + per-model, revisit after | Couples this ticket to a `system-node-critical` Helm upgrade that changes `DCGM_FI_DEV_FB_USED` semantics |

---

## 4. Implementation Plan

Layer order per `01-development-workflow.md`. Track A starts only after D-1.

### Track A — LM Studio placement (R-1 … R-4)

- **A1.** Implement D-1's transport. Whatever the shape, it keeps TASK-996's
  guards: super-admin imperative gate, `@ForbidApiKey()`, `--estimate-only` precheck,
  the live-VRAM budget refusal, and the `AUTH-NOTE` marker.
- **A2.** Extend `AiModelServingProfile` with `offloadRatio` (0–1) and `ttlSeconds`;
  extend the platform defaults. Validation must refuse `offloadRatio > 0` combined with
  `gpuSplit.disabledGpus` covering every device — that is a contradiction, not a split.
- **A3.** Turn TASK-996's `load` 501 into a working 202, and drop the placement editor's
  read-only caveat in the console.
- **A4.** Pin `granite-guardian` to GPU 1 for real — TASK-996 committed the seed row but
  it is **inert** until A1/A3 land, so today the one-model-per-card layout is still half
  applied.

### Track B — STT readiness, TTL and dashboard (R-5 … R-7)

- **B1.** Per D-4: `/health/warm` reporting resident models, and a startup preload of the
  D-5 model set. **`/health/ready` keeps its current contract** — the draining mechanism
  depends on it and must not acquire a second meaning.
- **B2.** Revisit the k8s probe budget only if B1 changes start-up time: today
  `startupProbe` allows `180 × 5s = 900s`, which already absorbs a cold model load.
- **B3.** TTL per D-6: field on `ResolvedAsrSpec` (mirrored in
  `packages/types/src/asr-spec.ts` and the pydantic mirror, both parity-pinned against
  `tests/contracts/resolved-asr-spec.fixture.json`), per-agent default, registry floor.
- **B4.** STT model-cache metrics to Prometheus: resident models, bytes each, TTL
  remaining, in-flight sessions.
- **B5.** The dashboard (D-7), extending TASK-996's `/runtime` rather than forking it.

### Verification

- [ ] A model pinned from the CONSOLE is confirmed on one card by `nvidia-smi` — the
      check TASK-996 could not make, because `loaded[]` has no per-device residency
- [ ] A CPU-placed model serves, and its measured slowdown is recorded here
- [ ] TTL from an agent is observed evicting on time, and an active session still pins
- [ ] A cold STT pod reports `/health/warm` false → true, while `/health/ready` and the
      draining behaviour are **unchanged** (regression-pinned)
- [ ] Dashboard queries aggregate DCGM by `gpu`, never by `pod` — asserted in a test
- [ ] Cross-tenant e2e on every new admin route; axe 0 violations

## 5. Implementation Summary

_Not started — awaiting D-1 … D-8._

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-21 | Ticket opened from the TASK-996 review. Established that Track A is blocked on one decision (the load transport, D-1) and that CPU placement is already reachable via `offloadRatio: 0`. Recorded that the STT ask **reverses a documented deliberate decision**, and that gating `/health/ready` on model residency would create a TTL-eviction/NotReady deadlock — hence the warmth-vs-readiness split in D-4. |
