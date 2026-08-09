# TASK-642 — Make Kokoro a built-in TTS provider so `hope-tts` can reach Ready

| Field | Value |
|---|---|
| **Status** | `In Progress` — Steps 1, 2, 2b, 5 done in `hope-v2`; Step 3 committed but UNPUSHED in `arca/hope-v2-deployment` (`0cf6a27`), held until a Kokoro image is published; Step 4 (Malayalam) blocked on TASK-643 |
| **Type** | `bugfix` + `infrastructure` |
| **Raised from** | 2026-08-09 `hope-v2-dev` outage triage ("3/6 services down") |
| **Owner decision on file** | "Let's review the tts service, you can open a new ticket for implementing kokoro as built-in solution" |
| **Related** | TASK-488 (TTS service), TASK-496 (per-tenant TTS config), TASK-577 (DB-sourced routing), TASK-602 (BYOK-only cloud credentials), TASK-616 (config split) |

---

## 1. Requirement Analysis

`hope-tts` has never passed its own readiness probe in `hope-v2-dev`. It runs, it
answers `/health/live` with 200, and it answers `/health/ready` with 503 forever —
so its Service carries no endpoints, `TTS_URL=http://hope-tts:8865` resolves to
nothing, and the admin console reports **Text to Speech — Down,
`connect ECONNREFUSED 10.43.239.171:8865`**.

The requirement is a TTS service that can become Ready and synthesise **without a
cloud credential**, using the Kokoro engine that the codebase already supports but
that no deployed image contains.

Out of scope: Malayalam. Kokoro is English-only. Malayalam stays on
`indic_parler` / a cloud provider and is not solved here — see §5 Open Decisions.

---

## 2. Current State Evaluation

This is not one bug. TTS is unconfigured at **four** independent layers, and each
one alone is sufficient to keep the service down. Verified against the running
cluster and the deployed image on 2026-08-09.

### 2.1 The readiness contract requires a platform key that policy forbids

`apps/tts/src/tts/api/endpoints/health.py:46` returns 503 unless at least one
registered provider's `health()` returns true:

```python
registry = getattr(request.app.state, "provider_registry", None)
if registry is None or not registry.list_providers():
    return JSONResponse(status_code=503, content={... "no providers registered"})
for name in registry.list_providers():
    if await registry.get(name).health():
        return {"status": "healthy"}
return JSONResponse(status_code=503, content={... "no healthy providers"})
```

`AzureSpeechProvider.health()` (`providers/azure_speech.py:75`) is
`return bool(self._key)`, and `self._key` comes from `AzureSpeechConfig.api_key`
— which TASK-602 deliberately severed from the environment:

```python
api_key: SecretStr = Field(
    default=SecretStr(""),
    validation_alias="TTS_AZURE_API_KEY__ENV_REMOVED_TASK_602",
)
```

`populate_by_name` is off and the alias is a dead name no env var matches, by
design: the key is BYOK and arrives per request as a `provider_override`.

**Consequence:** Azure can never be Ready in a keyless deployment. Readiness gates
on possession of a platform credential that the platform is no longer allowed to
hold. `SarvamConfig.api_key` carries the identical treatment.

⚠ This specifically invalidates the remediation suggested in
`deployment/k8s/base/tts-v2.yaml`: *"TTS_AZURE_ENABLED is the cheapest path
(AZURE_SPEECH_KEY is already in hope-secrets)"*. Flipping that flag registers the
provider and leaves readiness at 503. Anyone who tries it will conclude the flag
is broken.

### 2.2 The deployed image cannot run any local engine

`apps/tts/pyproject.toml` puts every local engine behind the `[local]` extra
(`torch`, `transformers`, `kokoro`, `soxr`, `sentencepiece`, `accelerate`,
`lameenc`), and `apps/tts/Dockerfile` builds base-only on purpose:

> *"This image installs the BASE deps only (cloud path — Azure Speech). Self-hosted
> local engines (Kokoro, Indic Parler-TTS) require the `[local]` extra + torch and
> a GPU node; build a separate GPU image variant…"*

Confirmed inside the running pod (`registry.taphuynh.dev/arca/hope-v2/tts:dev-715ac46b`):

| module | present |
|---|---|
| `azure.cognitiveservices.speech` | ✅ |
| `kokoro` | ❌ |
| `torch` | ❌ |
| `transformers` | ❌ |
| `soundfile` | ❌ |

The **separate GPU image variant the Dockerfile refers to was never built.** There
is no second TTS image in the registry and no CI job that produces one.

### 2.3 The deployment disables all five providers

`deployment/k8s/base/tts-v2.yaml` sets `TTS_AZURE_ENABLED`, `TTS_SARVAM_ENABLED`,
`TTS_KOKORO_ENABLED`, `TTS_PARLER_ENABLED`, `TTS_INDICF5_ENABLED` all to `"false"`.
Startup logs the result plainly:

```json
{"providers": [], "event": "tts.started", "logger": "tts.main"}
```

The manifest's own header comment documents this as a deliberate open owner
decision, so it is a known state — but see §2.1 for why its proposed fix does not work.

### 2.4 The database routes to engines that are not in the image

`core."TenantTtsConfig"`, the SYSTEM row that TASK-577 made authoritative for
per-locale provider SELECTION:

| tenantId | routingEn | routingMl | allowedProviders |
|---|---|---|---|
| `00000000-…-000000000000` (SYSTEM) | `{kokoro}` | `{indic_parler}` | `{kokoro,indic_parler,azure,sarvam}` |

Both routing targets are local engines absent from the image (§2.2). And both TTS
rows in `core."AiProviderConnection"` are unusable:

| tenantId | service | provider | enabled | has key |
|---|---|---|---|---|
| SYSTEM | tts | azure | `false` | no |
| SYSTEM | tts | sarvam | `false` | no |

So even if readiness were fixed and Azure enabled, the router would fail closed
(`TtsRoutingUnconfiguredError`) because the SYSTEM chain does not name `azure`.

### 2.5 Why this is the right shape of fix

The DB already says the intended English path is **Kokoro**. Kokoro is Apache-2.0,
needs no credential, and `KokoroProvider.health()` returns `True` unconditionally.
Making it built-in aligns the image with the routing the platform already declares,
and gives TTS a provider that is Ready with zero cost and zero credential
management — which is exactly what the other five services already have.

`IndicF5` must stay off regardless: its weights are a fine-tune of the CC-BY-NC
SWivid F5-TTS base, and `apps/tts/src/tts/core/config.py:96` marks commercial
enablement NO-GO pending the owner's license review.

---

## 3. Implementation Plan

TDD per `.claude/rules/01-development-workflow.md` — failing test first in every step.

### Step 1 — Readiness contract (`apps/tts`)

- **Test (RED):** `/health/ready` returns 200 when the registry holds one
  registered provider whose `health()` is `False` solely because it is keyless-BYOK
  (`is_configured is False`); still 503 when the registry is empty.
- **Change:** distinguish *"registered but awaiting a per-request credential"* from
  *"registered and broken"*. A provider exposing `is_configured is False` is
  serviceable — the gateway injects its key per request — and must not hold the
  whole service out of the Service endpoints.
- **Verify:** `pnpm tts:test`.
- This step is worth doing even if Kokoro lands, because it is the defect that makes
  a pure-cloud TTS deployment permanently unschedulable.

### Step 2 — Build Kokoro into the default image

- **Change:** `apps/tts/Dockerfile` — `uv sync --frozen --package tts --extra local`.
  Pin the CPU-only torch wheel index (`--extra-index-url https://download.pytorch.org/whl/cpu`)
  so the default image does not pull the ~2.5 GB CUDA build. Kokoro is 82M params
  and runs acceptably on CPU; `KokoroConfig.device` already defaults to `"cpu"`.
- **Change:** `apps/tts/pyproject.toml` — split the extra so `kokoro` (+ `torch`,
  `soxr`, `numpy`) is separable from `indic_parler`'s heavier `transformers` /
  `sentencepiece` / `accelerate` tail. `parler-tts` installs from git and must stay
  out of the shared `uv.lock`.
- **Verify:** image builds; `python -c "import kokoro"` succeeds in the built image;
  record the image size delta in §4.
- **Watch:** the model weights. Kokoro pulls from HF at first synth. Decide now
  whether to bake them into the image or mirror them internally — a first-request
  network fetch to `hf.co` from a PHI-adjacent pod is not acceptable in prod, and
  `HF_HUB_OFFLINE` is already the established pattern for `indic_parler`.

### Step 3 — Enable Kokoro in the deployment

- **Change:** `arca/hope-v2-deployment` `deployment/k8s/base/tts-v2.yaml` —
  `TTS_KOKORO_ENABLED: "true"`. Leave Parler and IndicF5 `false`.
- **Change:** correct the manifest's header comment, which currently sends the
  reader down the dead `TTS_AZURE_ENABLED` path (§2.1).
- **Change:** raise the TTS memory request/limit — torch + an 82M model is a
  different footprint from an HTTP client. Size it from an observed run, not a guess.
- **Verify:** pod reaches `1/1`; `hope-tts` Service has an endpoint;
  `GET /api/v1/health` from the `hope-api` pod returns 200.

### Step 4 — Align the SYSTEM routing row

- `routingEn={kokoro}` is already correct and becomes true for the first time.
- Decide `routingMl`. `{indic_parler}` stays a dangling reference unless Parler is
  also built in (heavy) or Malayalam moves to a cloud provider with a real key.
  Leaving it dangling means Malayalam synthesis fails closed at request time while
  the service reports Ready — acceptable only if that is a conscious choice.
- **Verify:** a real `POST` synth request for `en` returns audio; the Malayalam
  path returns a clear, attributable error rather than a generic 503.

### Step 5 — Regression gate

- An e2e assertion that `hope-tts` reports Ready with **no cloud credential
  present at all**. This is the condition that has been silently false since the
  service was first deployed, and nothing currently detects it.

---

## 4. Implementation Summary

### Step 1 — Readiness contract ✅ (2026-08-09)

Files changed (2):

| File | Change |
|---|---|
| `apps/tts/src/tts/api/endpoints/health.py` | `/health/ready` gains a third state: `degraded` (HTTP 200) |
| `apps/tts/src/tts/tests/unit/test_health.py` | +4 tests (1 for the new behaviour, 3 pinning what must NOT change) |

**The contract chosen — three states, not two:**

| Registry state | Status code | Body `status` |
|---|---|---|
| empty / no registry | 503 | `unhealthy` — `"no providers registered"` |
| ≥1 provider with `health()` true | 200 | `healthy` (byte-identical to before) |
| ≥1 provider unhealthy **solely** because `is_configured is False`, none healthy | **200** | `degraded` + `awaiting_credentials: [names]` |
| provider unhealthy while `is_configured is True`, or `health()` raises | 503 | `unhealthy` — `"no healthy providers"` |

**Why this contract and not "any registered provider ⇒ ready".** The readiness
semantics had to match what `TTSRouter.candidates()` (`routing/router.py:216`)
actually does at request time, and it is more specific than "registered":

```python
registered = name in self._registry and self._registry.get(name).is_configured
overridden = override_providers is not None and name in override_providers
if not registered and not overridden:
    continue
```

So a keyless-BYOK provider is serviceable **if and only if** the request carries a
`provider_override` — the gateway decrypts the tenant key and injects it, and the
router builds a keyed engine via `_build_override_engine`. That is a real, working
service path, so the pod belongs in the Service endpoints; but it is *not* the
same as "can synthesize anything asked of it", because a request arriving without
an override is still refused. `degraded` + the explicit `awaiting_credentials`
list is the honest name for that, and it is why the endpoint does not simply
return `healthy`. Kubernetes reads only the status code, so the distinction costs
nothing operationally and buys an operator a legible answer.

**Keylessness excuses a `False` probe, never a raising one.** A provider whose
`health()` throws is evidence of a broken provider, not of a missing credential,
so it is skipped entirely and cannot contribute to the degraded set — pinned by
`test_readiness_503_when_keyless_provider_health_raises`. Likewise a provider that
*has* its credential and still reports unhealthy is broken and cannot alone
produce a 200 (`test_readiness_503_with_configured_but_unhealthy_provider`).

`is_configured` is read with `getattr(provider, "is_configured", True)` — the
attribute is part of the `TTSEngine` protocol (`providers/base.py:79`) and every
in-tree engine sets it, so the default only guards a hypothetical third-party
engine, which is treated as credentialled (i.e. conservatively, as *not* excused).

No change was needed to `providers/base.py` — the protocol already carries
`is_configured`, added by TASK-602 for exactly this distinction; readiness simply
never consulted it.

**Note on §2.1's cross-reference.** The `tts-v2.yaml` comment recommending
`TTS_AZURE_ENABLED=true` as "the cheapest path" is *still* wrong after this step,
for a second reason the ticket did not state: even with readiness fixed, Azure
only serves requests that carry a per-tenant BYOK override, and the SYSTEM
`TenantTtsConfig` chain does not name `azure` (§2.4). Step 1 makes the pod
schedulable; it does not make a keyless Azure deployment able to synthesize.

**Verification** (all run 2026-08-09, conda `arcaenv` was in fact working):

```
$ pnpm tts:test:unit          # RED — before the change
apps/tts/.../test_health.py::TestHealth::test_readiness_200_with_keyless_byok_provider FAILED
============ 1 failed, 224 passed, 2 deselected, 1 warning in 1.69s ============

$ pnpm tts:test               # GREEN — after the change
apps/tts/.../test_readiness_200_with_keyless_byok_provider PASSED
apps/tts/.../test_readiness_prefers_healthy_over_degraded PASSED
apps/tts/.../test_readiness_503_with_configured_but_unhealthy_provider PASSED
apps/tts/.../test_readiness_503_when_keyless_provider_health_raises PASSED
================ 247 passed, 2 deselected, 6 warnings in 1.80s =================

$ pnpm tts:lint
All checks passed!

$ pnpm tts:typecheck
Success: no issues found in 34 source files
```

### Step 2b — Streaming synthesis + a bounded memory peak ✅ (2026-08-09)

Owner-raised from a measurement inside the built image: 59 MB baseline → 1227 MB
after the first synth → **2275 MB after one ~840-char utterance**. The suspected
cause was `KokoroProvider.synthesize()` materializing every segment of the whole
utterance into a list before yielding a single chunk:

```python
segments = await asyncio.to_thread(lambda: [seg[2] for seg in pipeline(req.text, voice=voice)])
```

Files changed (2): `apps/tts/src/tts/providers/kokoro.py`,
`apps/tts/src/tts/tests/unit/test_kokoro_provider.py` (+7 tests, 4 → 11).

#### ⚠ The diagnosis was half right, and measurement says which half

Reproduced on `tts-kokoro:arm64`, one container per case so `ru_maxrss` is that
case's own peak (it is a high-water mark; several utterances in one process only
ever report the largest):

| case | chars | segments | PCM out | audio | **peak RSS (before)** |
|---|---|---|---|---|---|
| import only | — | — | — | — | 59 MB |
| short (warm) | 12 | 1 | 0.07 MB | 1.5 s | 1242 MB |
| long | 840 | 2 | 2.45 MB | 51 s | **2341 MB** |
| max (`max_input_chars`) | 4096 | 9 | 11.84 MB | 247 s | 2432 MB |
| many (`\n`-split) | 5567 | **24** | 17.14 MB | **357 s** | **1848 MB** |

**Peak RSS does not scale with output length.** The `many` case produces 7× the
audio of `long` across 24 segments and peaks *lower*. Peak is dominated by the
torch forward pass of the single largest **segment** (~1.2 GB on top of the
resident model), and `KPipeline`'s default `split_pattern` is `\n+`, so a wall of
prose without newlines becomes a few very large segments. The accumulated list is
≤ ~35 MB of float32 even at `max_input_chars` — about 1 % of the 2.4 GB peak. The
4096-char number nobody had measured is **2432 MB**, only ~90 MB above the
840-char case.

**What does scale is CONCURRENCY**, and that is the defect worth fixing. Every
request ran its inference on the loop's shared thread pool, so N concurrent
requests paid the peak N times (3 × 840-char utterances, same image):

| concurrent 840-char synths | peak RSS before | peak RSS after | wall |
|---|---|---|---|
| 1 | 2505 MB | 2426 MB | 13.6 s → 15.3 s |
| 3 | 4314 MB | **2660 MB** (−38 %) | 36.8 s → 45.3 s |
| 5 | **7228 MB** | **2458 MB** (−66 %) | 58.3 s → 76.2 s |

Before: linear in concurrency. After: flat. A 4 GB TTS pod that survived one
request and OOM-killed on three now has a peak that does not move.

#### The change

1. **It actually streams now.** `_aiter_segment_audio()` pumps the synchronous
   `KPipeline` generator one `next()` at a time and yields each segment's audio
   immediately; nothing accumulates on the PCM path. First audio for a 4096-char
   input arrives in ~7 s instead of after the whole 65 s synthesis — which is
   what `native_streaming = True` had been claiming all along.
2. **All inference runs on the provider's ONE worker thread**
   (`KokoroProvider._get_worker`, a lazily-created `max_workers=1`
   `ThreadPoolExecutor` reused for the process's lifetime). This is what bounds
   the peak. Two rejected alternatives, both measured:
   - `asyncio.to_thread` (the loop's shared default executor) — spread one
     utterance over 3 pool threads and cost 2745 MB vs 2475 MB, because torch's
     per-thread state and glibc's per-thread malloc arenas are paid per thread
     that touches inference; it also leaves synthesis queueing behind unrelated
     blocking work.
   - a fresh executor per utterance — fresh arenas every request: **1527 MB for a
     12-char synthesis** against 1242 MB when the thread is reused.
   Trade-off accepted: synthesis serialises per provider. On a CPU-only pod
   parallel torch inference buys little throughput (N=5 wall time +31 %) and
   costs 3× the memory.
3. **WAV/MP3 cannot stream and are not pretended to.** The RIFF header carries
   the total byte count and `pcm16_to_mp3` encodes-and-flushes one buffer, so both
   still accumulate — but as PCM16 **bytes** (~48 KB per second of audio) with
   each float32 segment released as it is encoded, not as a list of live arrays.
   `ModelCache` / TTL / `_get_pipeline_async` are untouched.

#### Residual, honestly stated

At **N=1** the streaming version is ~5–10 % above the old peak (long: 2588 vs
2341; max: 2687 vs 2432) — interleaving encode with inference raises the
high-water mark slightly, and run-to-run variance on this workload is ±400 MB
(five `max` runs on the unchanged image spanned 2358–2827 MB). The win is at
N>1, where it is decisive. If single-request peak ever matters more than
first-byte latency and concurrency, the buffering version is the trade.

`ru_maxrss` never decreases and neither glibc nor torch return freed memory, so
steady-state RSS after a run is ~1.2–1.4 GB in every configuration. Sizing the
Step 3 memory limit off the **peak** column, not that one.

### Step 5 — Regression gate ✅ (2026-08-09)

New file `apps/tts/src/tts/tests/unit/test_keyless_readiness_task642.py` (5 tests).
`test_health.py` proves the readiness *logic* against hand-built fakes; this
proves the *wiring* — the real `create_app()` running the real lifespan, provider
set derived from `Settings` read out of the environment exactly as in the
container, with every `TTS_*` / `AZURE_*` / `SARVAM_*` variable deleted and
`CI=true` so `hope_env` reads no `.env.dev`.

| Test | Pins |
|---|---|
| `test_ready_with_no_cloud_credential_present_at_all` | keyless boot → `list_providers() == ["kokoro"]` → `/health/ready` 200 **`healthy`** (not `degraded`: Kokoro is self-hosted, so it can synthesize *now*) |
| `test_reaching_ready_opens_no_network_connection` | every `socket.connect` raises during boot + probe. Registration is lazy — the `kokoro` import and the ~327 MB weight pull happen in `_load_pipeline` on first synth — so readiness must be reachable with zero egress. Without this the gate would hit huggingface.co on every CI run |
| `test_azure_alone_cannot_make_the_service_synthesizable` | §2.1's correction of the `tts-v2.yaml` header: `TTS_AZURE_ENABLED=true` yields 200 **`degraded`**, `awaiting_credentials: ["azure"]` — schedulable, serves nothing without a BYOK override |
| `test_kokoro_is_a_dependency_of_the_default_image` | §2.2 — the `kokoro` extra exists and every non-comment `uv sync` in the Dockerfile passes `--extra kokoro`. A deterministic proxy for "is it in the image" that needs no Docker and no `kokoro` install |
| `test_kokoro_engine_imports` | the lazy `from kokoro import KPipeline` resolves (skipped where the extra is not installed; the row above is the deterministic gate) |

**Verified to fail on each layer's regression** — not assumed. Reverting one file
at a time and re-running:

```
control (all layers present) ................................. 5 passed
git stash apps/tts/src/tts/api/endpoints/health.py (§2.1) .... 1 failed  test_azure_alone_cannot_make_the_service_synthesizable
git stash apps/tts/Dockerfile (§2.2) ......................... 1 failed  test_kokoro_is_a_dependency_of_the_default_image
git stash apps/tts/pyproject.toml (§2.2) ..................... 1 failed  test_kokoro_is_a_dependency_of_the_default_image
main.py: kokoro registration disabled (§2.3/§2.4) ............ 2 failed  test_ready_with_no_cloud_credential_present_at_all
                                                                        test_reaching_ready_opens_no_network_connection
```

§2.3's live manifest value and §2.4's DB row live outside this repo, so the gate
covers them only through the name `kokoro` it requires to be registered and healthy.

### Verification (2026-08-09)

```
$ pnpm tts:test        # RED, Step 2b, before the change
apps/tts/.../test_pcm_first_chunk_arrives_before_all_segments_are_produced FAILED
  AssertionError: synthesize() must yield each segment as the pipeline produces it;
                  the pipeline had already produced 4 segments
apps/tts/.../test_pcm_keeps_at_most_one_segment_resident FAILED
  AssertionError: 6 segment arrays were resident at once
apps/tts/.../test_wav_does_not_retain_every_segment_array FAILED
  AssertionError: every segment array must be released as it is encoded
========================= 3 failed, 5 passed in 0.39s ==========================

$ pnpm tts:test        # RED, dedicated-worker step (added after the first
                       # rebuild measured WORSE than baseline)
apps/tts/.../test_synthesis_does_not_queue_behind_a_busy_default_executor FAILED
  TimeoutError                                    # to_thread queued behind the pool
========================= 1 failed, 9 deselected in 5.09s ======================

$ pnpm tts:test        # GREEN
================ 259 passed, 2 deselected, 6 warnings in 9.71s =================
                       # 247 before + 7 (kokoro provider) + 5 (keyless gate)

$ pnpm tts:lint
All checks passed!

$ pnpm tts:typecheck
Success: no issues found in 34 source files
```

`pnpm tts:format:check` reports 4 files needing reformat — `test_metrics.py`,
`api/endpoints/speech.py`, `api/endpoints/stream_ws.py`, `test_stream_ws.py`. All
**pre-existing** (identical with these changes stashed) and none touched here.

Memory numbers above were produced by rebuilding `tts-kokoro:arm64` from
`apps/tts/Dockerfile` and running, per case, in a fresh container:

```
docker run -i --rm -e CASE=<case> -v ttshf642:/app/.cache/huggingface \
    --entrypoint /app/.venv/bin/python tts-kokoro:arm64 - < measure_case.py
# resource.getrusage(RUSAGE_SELF).ru_maxrss / 1024  → MB (ru_maxrss is KB on Linux)
```

Steps 3–4: _not started_ (both need the deployment repo / the SYSTEM DB row).

---

## 5. Open Decisions (owner)

| # | Decision | Why it cannot be defaulted |
|---|---|---|
| OD-1 | Malayalam path — build in `indic_parler`, buy a cloud key, or accept en-only | Parler adds `transformers`/`accelerate` and HF-gated weights; the alternative is a real credential and recurring cost |
| OD-2 | Kokoro weights — bake into the image vs. internal mirror vs. HF pull at runtime | A runtime `hf.co` fetch from a PHI-adjacent pod is a network-egress and availability decision, not an engineering one |
| OD-3 | Whether Azure/Sarvam stay registered-but-keyless once Kokoro is Ready | Registering them is harmless after Step 1 and keeps per-tenant BYOK working; the alternative is fewer moving parts |
| OD-4 | CPU vs. GPU for Kokoro | CPU keeps the default image deployable on the single dev node; GPU needs a second image variant and node selectors |
| OD-5 | Whether serialising synthesis per pod is acceptable | Step 2b routes all Kokoro inference through one worker thread, which is what caps peak RSS (7228 MB → 2458 MB at 5 concurrent requests) but costs ~31 % wall time at that concurrency. The alternative — parallel inference — needs a memory limit sized for `concurrency × ~1.2 GB`, i.e. horizontal scaling instead. A throughput SLO would decide it; there isn't one |
| OD-6 | Whether `max_input_chars = 4096` is the right ceiling | Now measured: 4096 chars is 247 s of audio in a single request, ~65 s of CPU synthesis, 2.4–2.7 GB peak. That is a long time to hold a worker on a serialising pod. Splitting long inputs client-side, or lowering the cap, is a product decision |

---

## 6. Change History

| Date | Change |
|---|---|
| 2026-08-09 | **Steps 2b + 5 implemented** (TDD, RED→GREEN). `KokoroProvider.synthesize()` now streams per segment and runs all inference on the provider's single worker thread; new keyless-readiness gate, verified to fail on each of §2.1/§2.2/§2.3 in turn. **Correction on file:** the premise that peak RSS scales with output length is wrong — 24 segments and 357 s of audio peak *lower* (1848 MB) than 2 segments and 51 s (2341 MB). Peak is set by the largest single segment's torch forward pass; what actually scaled was CONCURRENCY (2505/4314/7228 MB at 1/3/5 parallel requests → 2426/2660/2458 MB after). The 4096-char case, never previously measured, is 2432 MB before / 2687 MB after. At N=1 the change is ~5–10 % *worse* on peak and much better on first-byte latency (65 s → ~7 s); at N>1 it is decisively better. |
| 2026-08-09 | **Step 1 implemented** (TDD, RED→GREEN). `/health/ready` now distinguishes *awaiting a per-request BYOK credential* (200 `degraded`) from *broken* (503). A keyless cloud TTS deployment can reach Ready for the first time. Contract chosen to match `TTSRouter.candidates()` rather than a looser "registered ⇒ ready". |
| 2026-08-09 | Ticket created from the `hope-v2-dev` outage triage. Four-layer current-state evaluation recorded; no code written. Correction on file: the existing `tts-v2.yaml` comment recommending `TTS_AZURE_ENABLED=true` as "the cheapest path" does not work — TASK-602 removed the env path for the key that `health()` gates on. |
