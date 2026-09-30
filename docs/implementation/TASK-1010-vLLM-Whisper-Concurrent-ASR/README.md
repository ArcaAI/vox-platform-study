# TASK-1010 — vLLM Whisper with continuous batching for 25 concurrent streams (spike)

**Status:** Completed — superseded by TASK-1021
**Type:** infrastructure (measurement spike → go/no-go)
**Branch:** `dev-2.2`
**Sibling:** TASK-1009 (faster-whisper arm). Pass bar and ladder are shared — see TASK-1009.

## Requirement Analysis

Same target and pass bar as TASK-1009: **≥ 25 concurrent realtime streams**, commit p99 ≤ 15 s,
ml-en accuracy no worse than the current whisper.cpp model, VRAM within the OD-1 budget, no STT
restarts. The current engine is serial per model (TASK-1007; `whisper_cpp_asr.py:133-136`).

This ticket evaluates **vLLM** serving the ml-en Whisper fine-tune, relying on vLLM's
**continuous batching across requests** — the only low-effort engine found with native
cross-stream batching.

### Scale target (owner, 2026-09-29)

**25 concurrent streams is milestone 1; the design target is 1,000 concurrent streams.** The
spike therefore judges an engine on how it scales out, not only on whether one GPU reaches 25:

| Question the spike must answer | Why it matters at 1,000 |
|---|---|
| **Streams per GPU** at the pass bar (fp16 and quantised) | sets the fleet size: 1,000 / streams-per-GPU = GPUs needed (e.g. 40/GPU → 25 GPUs, 100/GPU → 10) |
| **Cost per stream** (GPU-hours per stream-hour) | the number the owner decides hardware on |
| Can the decode tier run as a **separate, horizontally scaled service** (N replicas, any node) with the STT session tier routing windows to it? | the current single-process, single-node shape cannot reach 1,000 |
| Does throughput scale **linearly with replicas** (2 replicas ≈ 2×)? | verify with at least 2 replicas / 2 GPUs if hardware allows |
| **Autoscaling signal** (queue depth / batch wait) and cold-start time of a new replica (model load) | scale-out must add capacity, not restarts (TASK-1007 F-5) |

Out of scope here, but recorded so it is not lost — 1,000 streams also needs, independent of the
engine: a multi-node GPU cluster (today one k3s node, 6 time-sliced slices); STT session tier
horizontally scaled with sticky WS routing; Redis sized for ~2 blocking reads per stream
(TASK-1007 D-3 → ~2,000+ connections); gateway WS fan-in across replicas; the Cloudflare tunnel
burst limits (TASK-1007 F-6); liveness decoupled from decode (D-2); metering that survives
restarts (M-3). These belong to a separate scale-out architecture ticket after the engine choice.

## Current State Evaluation

Research findings (2026-09-29, docs/issues — not measured):

- Supported architecture `WhisperForConditionalGeneration` (whisper-small … large-v3-turbo);
  no LoRA, no pipeline parallelism.
- `/v1/audio/transcriptions` supports `language`, `prompt`, `verbose_json` segment timestamps;
  a realtime PCM16 16 kHz API is listed in the docs. Beam search is inefficient for enc-dec.
- Limits that matter to us:
  - 30 s max clip (vllm-project/vllm#15012) — our ~7 s windows fit.
  - **Silent audio drop when the decoder stops early inside a chunk (vllm-project/vllm#53144)** —
    must be tested explicitly on the ml-en fixtures.
- Quantisation: nothing Whisper-specific documented. Generic `--quantization fp8` (Ada has FP8)
  is untested for Whisper; treat as a stretch arm.
- Custom checkpoint: an HF-format fine-tune of the same architecture should load with
  `vllm serve <dir>` (inferred, verify).
- No published concurrent-stream numbers for vLLM Whisper.
- Integration shape to decide: STT keeps sessions/segmentation and calls vLLM as a decode
  backend (a new engine behind the agent spec), vs. vLLM's own realtime API.
- The cluster already runs a `vllm` workload profile (`base/vllm.yaml` in the deployment repo);
  GPU slices are fully allocated (6/6), so a vLLM ASR pod needs a slice given back or a card.

## Open Decisions (owner)

| # | Question |
|---|---|
| OD-1 | GPU budget: dedicated card, or a time-slice (shared with LM Studio)? (same as TASK-1009 OD-1) |
| OD-2 | Accept FP8 if WER holds, or fp16 only? |
| OD-3 | Integration: vLLM as a decode backend called by STT (keeps our session/metering/lexicon path), or vLLM's realtime API directly? |
| OD-4 | Spike deployment: local-only bench first, or a temporary cluster pod (deployment repo change)? |

### Facts established 2026-09-29 (orchestrator)

- The ml-en fine-tune is **Whisper large-v3-TURBO** based (4 decoder layers), not full large-v3.
  Three published forms (seed `packages/database/src/prisma/db_main/seed/ai-models/audio.ts`):
  HF safetensor fp16 `taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-fp16`
  (slug `arcaai-whisper-large-ml-en`), CTranslate2 `…-2607.29.1-ct2` (slug
  `arcaai-whisper-large-ml-en-ct2`), and the GGUF the cluster serves today. Private HF repos.
- `apps/stt/src/stt/streaming/faster_whisper_asr.py` + `models/faster_whisper_loader.py` already
  exist (per-window adapter over `WhisperModel` / `BatchedInferencePipeline`).
- No NVIDIA GPU is available locally (Mac, MPS). Lane work = code + unit tests + CPU functional
  checks; the GPU ladder waits for the GPU-budget decision (multi-GPU discussion deferred by owner).

**Decisions (owner go, 2026-09-29):** **OD-3 resolved — vLLM runs as a NEW service** (`apps/asr-vllm`, package `asr_vllm`, port 8867), called by STT as a decode backend; STT adapter comes after the direct bench. OD-1/OD-2/OD-4 stay open until the GPU run.

## Implementation Plan (draft — pending OD round)

1. Serve the ml-en HF checkpoint with vLLM (fp16) on the cluster GPU; smoke `/v1/audio/transcriptions`.
2. Offline accuracy on the TASK-994 fixtures vs whisper.cpp baseline; explicit check for #53144
   (truncated output on windows with early EOS).
3. Concurrency bench: 25 streams' windows submitted concurrently to vLLM directly (no STT) —
   per-window latency, throughput, VRAM, SM activity.
4. If step 3 passes: thin STT engine adapter (vLLM decode backend) and the full
   `stream_ladder.py` run 1…32.
5. Stretch: `--quantization fp8`, re-check WER.
6. Scale-out probe: 2 vLLM replicas behind a router if hardware allows; streams/GPU, linearity, cold start.
7. Go/no-go write-up against the pass bar AND the 1,000-stream projection (GPUs needed, cost/stream), side by side with TASK-1009.

## Phase B plan — OD-6 (platform configuration) + OD-7 (registry first) — 2026-09-29, IMPLEMENTED (see Implementation Summary)

Owner approved the OD-6 shape and asked for it to be planned together with OD-7. Nothing below is
implemented. Grounded in a code map of the current tree (paths:lines in the change history entry).

### What exists and is reused (no new internal routes)

| Need | Existing mechanism | Change |
|---|---|---|
| Model facts on the row | `AiModel._metadata.asr` = `AiModelAsrProfile` (`packages/types/src/asr-model-profile.ts:149`), admin-writable via `asrProfile` on create/update DTOs, merged by `aiModel.service.ts:333-360`, shape-only parser | add two optional keys (OD-8) |
| Facts reach the service | `toResolvedModel` (`agent/agent-resolver.service.ts:472-503`) → `toSpecModel` (`stt/agent-resolver/build-resolved-asr-spec.ts:187-206`) → `AsrSpecModel` (`packages/types/src/asr-spec.ts:93-127`), mirrored by `apps/stt/src/stt/pipeline/spec.py:274-296` (`extra="forbid"`), parity fixture `tests/contracts/resolved-asr-spec.fixture.json` | add two OPTIONAL, omit-when-absent spec fields (either deploy order is safe) |
| Platform knobs | settings registry, `global-kv`, `maxScope:'system'`, `globalOnly:true`, `failMode:'open-to-default'` (exemplar `stt-runtime.descriptors.ts:559-585`; bounds via `numberBetween` in `model-residency.descriptors.ts:48-56`) | new `asr-vllm.descriptors.ts` |
| Python reads knobs | generic `GET /api/v1/internal/effective-config?service=` (`internal/effective-config.controller.ts:29`, `InternalServiceTokenGuard`), TTL 60 s + `arca:config:invalidate`; TTS client is the template (`apps/tts/src/tts/core/effective_config.py`, `X-Service-Token`) | add `'asr-vllm'` to `CONSUMING_DEPLOYABLES` (`registry.types.ts:43`, also feeds `EFFECTIVE_CONFIG_SERVICES`) and to the guard's `SERVICE_SECRETS` → `INTERNAL_ACCESS_TOKEN` |
| Registry credential | generic `GET /api/v1/internal/model-registry-credential?service=&provider=&tenantId=` (`model-registry-internal.controller.ts:59-73`) → `resolveCredential('model-registry', provider, ownerTenant)`; four outcomes RESOLVED/ABSENT/DENIED/UNAVAILABLE | asr-vllm client copy (fixing the header defect below) |
| Publish to our store | `AiModelDownloadProcessor` → `hope-models` bucket, HF-cache layout for `transformers`; `derivedLocalPath` = `/mnt/models-bucket/<bucketPrefix>` | none — the vLLM row is published like any other |

### Design

**Registry (OD-6 facts, OD-7 identity)**
- `AiModelAsrProfile` gains `quantization?: 'none'|'fp8'|'awq'|'gptq'|'int8'` and `maxModelLen?: int (>=1)`; dtype stays the existing `computeType` column. Same DTO (`AsrProfileRequest`), same range constants, same shape-only parser (unknown / out-of-range dropped, never thrown).
- `AsrSpecModel` gains `quantization?` / `maxModelLen?` (top-level on the model, omit when absent). `spec.py` adds both to `OPTIONAL_FIELDS`. New parity fixture case `vllmServingFacts`.
- A quantised variant is its OWN row (`…-fp8`), never a toggle on an existing row — it is bound to an agent explicitly and evaluated on its own.
- `AI_MODEL_SERVED_BY` (`ai-model/constants.ts:93`) gains `'asr-vllm'`. Seed SYSTEM row `arcaai-whisper-large-ml-en-vllm` (servedBy `asr-vllm`, format `SAFETENSOR`, libraryName `transformers` so it publishes in HF-cache layout, `computeType float16`, `_metadata.asr.maxModelLen` set) pointing at the same private HF source (OD-9).

**Platform settings (OD-6 knobs)** — `asr-vllm.descriptors.ts`, all `global-kv` · `maxScope:'system'` · `globalOnly:true` (platform-only, owner-approved exception to tenant→platform: they size a shared GPU pool) · `failMode:'open-to-default'` · `consumedBy:['asr-vllm']`:

| Key | Type / bounds | Default (OD-10) | Applies |
|---|---|---|---|
| `asrVllm.engine.gpuMemoryUtilization` | number 0.05–0.95 | 0.20 (shared 16 GB card) | next engine build |
| `asrVllm.engine.maxNumSeqs` | int 1–1024 | 64 | next engine build |
| `asrVllm.engine.enforceEager` | bool | false | next engine build |
| `asrVllm.engine.maxResidentEngines` | int 1–4 | 1 | immediately (eviction) |
| `asrVllm.truncation.minCharsPerVoicedSecond` | number ≥0 | current code default | per request |
| `asrVllm.truncation.voicedDbfs` | number −90–0 | current code default | per request |

The six `ASR_VLLM_*` tuning env vars are closed with a dead alias (the STT `moved_alias` pattern) so a stale env value cannot silently win. Env keeps only bootstrap: port, `ASR_VLLM_API_GATEWAY_URL` (new), OTEL, log level; the service token comes from `INTERNAL_ACCESS_TOKEN` (vault-kv).

**Registry-first loading (OD-7)** — `apps/asr-vllm`:
1. vLLM is only ever handed a LOCAL DIRECTORY — never a repo id — so it can never pull on its own with an ambient token. Container sets `HF_HUB_DISABLE_IMPLICIT_TOKEN=1` and carries no `HF_TOKEN`.
2. `localPath` present and existing → load in place (published weights; preferred).
3. Otherwise HF `sourceUri` → token from the generic credential route for the MODEL OWNER (`spec.model.tenantId`, sent as `tenantId` + `X-Tenant-Id`, `service=asr-vllm`, `X-Service-Token`) → `snapshot_download` into the model-cache dir → load that dir. RESOLVED → use; ABSENT → anonymous (public repos only); DENIED/UNAVAILABLE → 503 fail-closed, never retried anonymously.
4. The request spec must carry the registry identity (`runtimeKey`, `tenantId`, `checksum`); a spec without them is 422. The service stays DB-less: registry enforcement is that specs are only ever built by the gateway resolver from registered rows, and only service-token holders can call the service.
5. Arch guard: `quantization: fp8` on a GPU below compute capability 8.9 → 503 with a named reason (OD-11). Dev (RTX 2000 Ada) is sm_89; production (RTX A6000) is sm_86.

### Pre-existing defect found while mapping (separate fix, not in this plan)
`apps/tts` and `apps/nlp` `core/model_credentials.py` call the generic credential route with
`X-Internal-Service-Key` and no `service=` query; `InternalServiceTokenGuard` requires `?service=` and
reads `X-Service-Token` for non-stt callers → those fetches should 401 → UNAVAILABLE → private
non-published model pulls in tts/nlp fail closed. Flagged as its own task; asr-vllm's client is
written correctly from the start.

### TDD test list (RED first)
1. `packages/types` — `parseAiModelAsrProfile` keeps valid `quantization`/`maxModelLen`, drops invalid.
2. `packages/applications` — `AsrProfileRequest` validation (enum, int ≥1); `toSpecModel` emits both fields when set, omits when absent; `asr-vllm.descriptors` shape test (tier, globalOnly, bounds); `CONSUMING_DEPLOYABLES` governance test green with `asr-vllm`; effective-config returns only `asrVllm.*` for `service=asr-vllm`.
3. `apps/api` — `InternalServiceTokenGuard` admits `service=asr-vllm` with `INTERNAL_ACCESS_TOKEN`, rejects a wrong token.
4. Contracts — fixture case `vllmServingFacts`; TS parity `MODEL_FIELDS`/`OPTIONAL_MODEL_FIELDS`; STT `test_resolved_spec_parity.py`.
5. Seed — new row present, servedBy `asr-vllm`, no duplicate slug.
6. `apps/asr-vllm` — spec mirror accepts the shared model shape; effective-config overlay (engine knobs read at build, truncation per request, env alias dead); credential client (four outcomes, headers, owner tenant); source resolution (localPath wins, HF path downloads then passes a directory, DENIED/UNAVAILABLE 503, never a repo id to vLLM); fp8 arch guard.

### Order and lanes (after go)
Layer order: types → seed/DB data (no migration: `_metadata` only) → applications → api → contracts → Python.

| Lane | Owns | Tier |
|---|---|---|
| L1 (TS + contract) | `packages/types`, `packages/applications` (ai-model DTO/constants, resolver, descriptors, registry types), `apps/api` guard, seed row, parity fixture + TS parity test, `apps/stt/src/stt/pipeline/spec.py` + its parity test | opus |
| L2 (Python) | `apps/asr-vllm/**` only; pinned contract = the field names above | opus |

Owner rule: lanes run only their own RED→GREEN files; one gate pass after both merge (as this round).
After merge: `pnpm api:route-manifest`/`openapi` are NOT affected (no route changes); `env:sync` + `env:python-surface` re-run for the closed env vars and the new `ASR_VLLM_API_GATEWAY_URL`.

### Decisions (all approved by the owner 2026-09-29, as recommended)

| # | Question | Recommendation |
|---|---|---|
| OD-8 | Where the two facts live on the row | Extend `_metadata.asr` (ASR profile): reuses the DTO, parser and merge; no migration. A generic slot can come when an LLM row needs the same facts |
| OD-9 | vLLM gets its own registry row, or reuses the `transformers` row | Own row `arcaai-whisper-large-ml-en-vllm` (servedBy `asr-vllm`): readiness/inventory stay per serving target, matches the gguf / ct2 / q8_0 rows; costs one more ~1.6 GB publish |
| OD-10 | Default `gpuMemoryUtilization` | 0.20 while ASR shares a 16 GB card; raise per environment in the SYSTEM row, not in code |
| OD-11 | fp8 on Ampere (production A6000) | Refuse below sm_89 until measured on the A6000; int8/fp16 rows work on both |
| OD-12 | Where the bench gets a registry-built spec from | Dev-only: `GET internal/agents/resolve` with the service token, so the bench exercises the same resolver as production |

## Implementation Summary

### Phase B — OD-6 + OD-7 (merged into `dev-2.2` 2026-09-29)

| Commit | What |
|---|---|
| `ea118678a` (L1 merge) | `AiModelAsrProfile` + `AsrSpecModel` carry `quantization` (`none/fp8/awq/gptq/int8`) and `maxModelLen` (omit when absent); admin `asrProfile` DTO; `servedBy: 'asr-vllm'`; `asr-vllm.descriptors.ts` (6 platform-only `global-kv` keys, defaults per OD-10); `CONSUMING_DEPLOYABLES` + `InternalServiceTokenGuard` know `asr-vllm` (`INTERNAL_ACCESS_TOKEN`); parity fixture case `vllmServingFacts` + STT mirror; seed row `arcaai-whisper-large-ml-en-vllm` (`…0001-000000000026`, `{quantization:'none', maxModelLen:448}`) and Global-only spike ASR agent `realtime-transcription-vllm-spike` (`9c000000-0000-0000-0006-000000000001`, published, never assigned, never cloned) |
| `53cfc9446` | `GET /api/v1/internal/agents/asr-spec` (OD-12): the `ResolvedAsrSpec` a live session would get for that agent, via `AsrAgentResolverService`; `.spec` only — `providerOverrides` never leave the gateway. Five API artifacts regenerated (they also carried L1's DTO fields, which L1 had judged artifact-neutral); console `SERVED_BY_OPTIONS` += `asr-vllm` |
| `ef4c4089b` (L2 merge) | asr-vllm: effective-config client + control-plane overlay (engine knobs at build, truncation per request, a decode request never waits on the pull); six `ASR_VLLM_*` tuning vars closed (`__MOVED_TO_CONTROL_PLANE`); request `spec` = the gateway `ResolvedAsrSpec` (`extra="ignore"`, strict on the fields it uses); registry-first loading — `localPath` in place, else HF via the owner-funded registry credential then a LOCAL dir to vLLM, `HF_HUB_DISABLE_IMPLICIT_TOKEN=1`, DENIED/UNAVAILABLE → 503; fp8 below sm_89 → 503; checksum verified where the published manifest names the file |
| `6ed647da4` | bench `--agent-slug` + `--gateway-url` resolve the spec through `internal/agents/asr-spec`; `--spec-file` kept for replay; exactly one required; no option names a model |
| `fbd510e0d` | asr-vllm own lock declares `redis` (push invalidation) + `huggingface-hub`; only redis 8.1.0 + async-timeout added |
| `c7c5c6a3c`, `5a39b9e67` | env surface regenerated; prettier on two L1 lines |

**Finding that amends OD-11:** vLLM has no `int8` quantization method, so asr-vllm refuses an `int8` row
with 503 `QUANTIZATION_UNSUPPORTED` before any download. `int8` on the registry stays meaningful for
CTranslate2 (faster-whisper `int8_float16`, TASK-1009); for vLLM the working variants are fp16 and
(on sm_89+) fp8.

**Gate pass on merged `dev-2.2` (2026-09-29):** asr-vllm 247 passed · ruff/mypy clean; STT unit 4,047
passed, mypy = the 4 pre-existing errors; contracts py 137 passed + 1 pre-existing skip, TS 124 passed;
`env:sync:check` + `env:python-surface:check` OK; `@arcaai/types` 102, `@arcaai/applications` 15,141 passed,
`@arcaai/database` 1,968 passed; api tsc clean, internal suite 116 passed, lint 0 errors; openapi /
portal / vox-node `gen:admin` checks green; admin-console typecheck clean.

**Still open (need the GPU run or later steps):** docker build; vLLM 0.30.0 platform calls, private-repo
pull with the registry token, loading the published HF-cache dir, fp8 on sm_89, cold-start cost of
hashing on the s3fs mount; readiness mapping for `servedBy: asr-vllm` (needs the gateway to know the
service URL — with the STT → asr-vllm adapter); CI image job, `.github/services.json`, deployment manifests.


### Lane 2026-09-29 — the `apps/asr-vllm` service (code + unit tests; no GPU run yet)

Branch `task-1010/asr-vllm-service` (from `dev-2.2` @ `4e9fbeb33`). Covers plan steps 1 and 3
as **code**; nothing here has run on a GPU. Service docs: `apps/asr-vllm/README.md`.

| Piece | Where | What it does |
|---|---|---|
| Decode endpoint | `api/endpoints/transcriptions.py` | `POST /api/v1/transcriptions`: one window (PCM16 LE mono 16 kHz, base64 in JSON), `language`, optional `prompt`, `temperature`, `max_tokens` → `{text, language, runtime_key, audio_seconds, finish_reason, timings{queue_ms, decode_ms, engine_queue_ms}, truncation{…}}`. `X-Tenant-Id` required (400). No lock/queue in front of the engine: every window joins vLLM's running batch. |
| Resolved spec | `spec.py` | camelCase slice of `AsrSpecModel` + `runtimeKey`, plus NEW `quantization` / `maxModelLen`; `extra='forbid'`; `format` must be `SAFETENSOR` (GGUF/CT2 rows fail closed). No model is ever named in env or code. |
| Engine pool | `engine/pool.py` | one engine per runtime key, lazy, single-flight (waiters shielded), ≤ `max_resident` with idle-LRU eviction, 503 + Retry-After when all busy, 409 on a key reused for other weights, failed loads not cached. |
| vLLM adapter | `engine/vllm_backend.py` | `vllm` imported lazily. `AsyncLLM.from_engine_args` in a worker thread; Whisper `ExplicitEncoderDecoderPrompt` (empty encoder text + `multi_modal_data.audio=(f32, 16000)`, decoder `<\|startoftranscript\|><\|lang\|><\|transcribe\|><\|notimestamps\|>`) — shape verified against the **v0.30.0** sources; explicit `max_tokens` = remaining decoder context (vLLM's default is 16); abort on client cancel. |
| Guards | `audio.py`, `truncation.py` | > 30 s windows refused (`WINDOW_TOO_LONG`, vllm#15012). vllm#53144 hook: `token_budget_exhausted` (finish_reason=length, certain) or `short_output_for_voiced_audio` (heuristic, uncalibrated). |
| Warm | `POST /api/v1/engines/warm` | loads an engine off the request path → the scale-out contract (router warms a new replica before routing to it) and the bench's cold-start number. |
| Health | `api/endpoints/health.py` | HOPE four-route contract; `/health/live` reads nothing (TASK-1007 D-2); ready = 503 only if the backend is absent, `degraded` while no engine is resident. |
| Metrics | `core/metrics.py` | `asr_vllm_inflight_windows`, `asr_vllm_engine_queue_seconds` (autoscaling candidates), `asr_vllm_engine_load_seconds` (cold start), decode/queue histograms, outcome + truncation counters. |
| Bench | `apps/asr-vllm/scripts/bench_concurrency.py` | standalone (stdlib + httpx). N realtime streams, ~7 s windows cut from a 16 kHz WAV, posted when their audio would exist; per N (default 1,2,4,8,12,16,20,25,32): request + commit latency p50/p95/p99, windows/s, audio-s/s, errors by status, keeps-up, commit-p99 ≤ 15 s bar; warm-up + cold start reported apart. Example WAV: `…/Probiotic_Foods_Dr_Manoj_Johnson/0001_0.86_12.58/audio.wav` (TASK-994, outside git). |
| Image | `apps/asr-vllm/Dockerfile` | authored, **not built**: digest-pinned `vllm/vllm-openai:v0.30.0`, service shell constrained to the image's installed versions, non-root, build-info baked. |
| Root wiring | `package.json`, `scripts/dev-service.sh` | `asr-vllm:{dev,dev:watch,test,test:unit,test:cov,lint,lint:fix,typecheck,format,format:check}`; launcher target on `ASR_VLLM_PORT` (8867). |

#### Dependency outcome — standalone, NOT a workspace member

Adding `apps/asr-vllm` (with `vllm==0.30.0; sys_platform=='linux'`) to the root workspace and
running `uv lock` failed outright:

```
Because asr-vllm[vllm] depends on vllm{sys_platform == 'linux'}==0.30.0
and vllm==0.30.0 depends on fastapi[standard]>=0.133.0,<0.137.0, ...
And because harness depends on fastapi>=0.141.1, we can conclude that
harness and asr-vllm[vllm] are incompatible.
```

Declaring the extra as conflicting with all six services still failed on the shared
`hope-obs[dev]` (`fastapi>=0.141.1`). vLLM also pins `torch==2.13.0` (lock: 2.8.0 / 2.12.1).
Root `pyproject.toml` reverted; root `uv.lock` byte-identical to `4e9fbeb33` (verified with
`cmp`). `apps/asr-vllm/uv.lock` resolves cleanly on its own (226 packages; Linux fork:
vllm 0.30.0, torch 2.13.0, fastapi 0.136.3, transformers 5.17.0).

#### Evidence (lane-owned files only, per the owner's gate rule)

- RED (before any implementation): `ModuleNotFoundError: No module named 'asr_vllm.core'`
  at `tests/conftest.py` — the worktree guard had already passed.
- GREEN: `pytest apps/asr-vllm/src/asr_vllm/tests` → `93 passed` (stable over 4 runs);
  the service commit alone → `82 passed`.
- `ruff check apps/asr-vllm/` → `All checks passed!`; `black --check` → `33 files would be
  left unchanged.`; `mypy --config-file apps/asr-vllm/pyproject.toml apps/asr-vllm/src/
  apps/asr-vllm/scripts/` → `Success: no issues found in 20 source files`.
- In-process boot with the REAL factory on the Mac: live 200, startup 200, ready 503
  "vllm is not installed in this image (Linux + CUDA only)", `vllm` never imported.

#### Deviations from the brief / house rules (spike)

| # | Deviation | Why |
|---|---|---|
| V-1 | Not a root uv workspace member; own `pyproject` + `uv.lock`; image based on `vllm/vllm-openai` | unsatisfiable shared lock (above) |
| V-2 | Six engine/heuristic knobs are `ASR_VLLM_*` env (`GPU_MEMORY_UTILIZATION`, `MAX_NUM_SEQS`, `ENFORCE_EAGER`, `MAX_RESIDENT_ENGINES`, `TRUNCATION_MIN_CHARS_PER_VOICED_SECOND`, `TRUNCATION_VOICED_DBFS`) | measured by the spike; must move to a descriptor or the agent/model row afterwards |
| V-3 | Inbound credential is the shared `INTERNAL_ACCESS_TOKEN`, not a per-service `service_token` | owner decision D-D retired per-service tokens fleet-wide (`apps/tts` exemplar) |
| V-4 | No gateway self-registration (`service_release_task = None`) | spike: no gateway URL, no peer calls; the startup marker still exists |
| V-5 | Image Python 3.12 vs house pin < 3.12; local packages installed `--ignore-requires-python` | vLLM's image is 3.12; verify on first build |
| V-6 | Previous-text prefix `<\|startofprev\|>` (Whisper's token), not vLLM 0.30.0's `<\|prev\|>` | `<\|prev\|>` is not a Whisper special token; callers should send no prompt for ml-en anyway (TASK-994) |
| V-7 | Extra route `POST /engines/warm` | cold-start measurement + warm-before-route scale-out |
| V-8 | `tests/contracts/test_observability_parity.py` / `test_health_contract_parity.py` NOT extended | both hard-list six services and derive `apps/<svc>/src/<svc>`; the hyphenated `asr-vllm` dir needs a package map. The service meets both contracts (hope_obs from the factory, four exempt health routes, build-info version, startup marker) |

#### Not verifiable without a GPU (the GPU run must check)

1. `docker build` of the Dockerfile (constraint conflicts, Python 3.12 install of `hope-*`).
2. That `AsyncLLM` accepts the exact prompt/`SamplingParams` objects (verified against source, run only against a stand-in); `engine.model_config.max_model_len` access; `RequestOutput.metrics` timestamps (else `engine_queue_ms` is null).
3. The ml-en HF fp16 checkpoint loading in vLLM (inferred, as the ticket already notes), `dtype`/`fp8`, and the private-HF credential path (only `localPath` is credential-free).
4. Continuous batching actually overlapping 25+ windows; streams-per-GPU, VRAM, cold-start seconds, linear scaling over replicas.
5. Truncation heuristic calibration (3 chars / voiced second, −40 dBFS) on the TASK-994 fixtures; the `<|startofprev|>` vs `<|prev|>` behaviour.
6. `to_thread` engine start keeping `/health/live` responsive during a real multi-second load.

#### Orchestrator follow-ups (outside this lane's file boundary)

- `turbo.json#globalEnv` (+ env samples via `pnpm env:sync`): `ASR_VLLM_GPU_MEMORY_UTILIZATION`,
  `ASR_VLLM_MAX_NUM_SEQS`, `ASR_VLLM_ENFORCE_EAGER`, `ASR_VLLM_MAX_RESIDENT_ENGINES`,
  `ASR_VLLM_TRUNCATION_MIN_CHARS_PER_VOICED_SECOND`, `ASR_VLLM_TRUNCATION_VOICED_DBFS`,
  `ASR_VLLM_LOG_LEVEL` (read by hope_obs), `ASR_VLLM_PORT` (launcher), `ASR_VLLM_BENCH_TOKEN`
  (bench client only). The generators list services by hand: `scripts/env-sync.mts`
  (`PYTHON_SERVICES`), `scripts/python-env-surface.py` (`ServiceSpec`),
  `scripts/env-consumer-inventory.py` (`PY_SERVICES`) — `apps/asr-vllm/.env.sample` does not
  exist until asr-vllm is added there.
- Parity gates (V-8) and `tests/contracts/dockerfile-build-info.test.ts` (Dockerfile list).
- CI image job; deployment-repo Deployment/Service/probes/PVC (service README §deployment).
- Port 8867 appears only as a placeholder `TTS_URL` in `apps/api/src/modules/health/__tests__/admin-health-services.controller.test.ts` — no real conflict.

#### New open decisions

| # | Question |
|---|---|
| OD-5 | **DECIDED (owner, 2026-09-29): accept** — `apps/asr-vllm` keeps its own lock and the pinned `vllm/vllm-openai` base image; it stays out of the root uv workspace. |
| OD-6 | **Owner direction (2026-09-29): platform configuration.** Proposed shape (awaiting confirmation): model-intrinsic facts (`quantization`, `maxModelLen`, dtype) on the `AiModel` registry row, a quantised variant = its own row; engine capacity knobs + truncation thresholds as platform-only `global-kv` descriptors `asrVllm.*` read through an effective-config client, applied at engine (re)build; env keeps bootstrap only. See Change History 2026-09-29. |
| OD-7 | **DECIDED (owner, 2026-09-29): registry first.** Every model the service loads must be registered in the HOPE model registry (`AiModel`) first — including HF-hosted ones — and weights are pulled with the registry credential (`AiProviderConnection` `model-registry:huggingface`, funded by the model row's owner, the same cascade STT uses via `GET internal/stt/model-registry-credential`). Raw `sourceUri` pulls with ambient credentials are not allowed. |

## Change History

- 2026-09-30 — Superseded by TASK-1021 Phase 1: `apps/asr-vllm` was renamed `apps/vllm` (OpenAI wire, model resolved from the `AiModel` row, pools via `vllm.pools`). This ticket's open items — the STT adapter (`stt` `vllm` engine), the CI image job, the deployment manifests (`vllm-pool` template, `hope-vllm-asr`) and the readiness mapping — were absorbed by TASK-1021 Phase 1; nothing remains open here.
- 2026-09-29 — Phase B merged (L1 `ea118678a`, L2 `ef4c4089b`) + orchestrator follow-ups (`internal/agents/asr-spec`, bench `--agent-slug`, redis/hf-hub deps, env regen); one gate pass green; worktrees removed. OD-11 amended: vLLM has no int8.
- 2026-09-29 — Owner: OD-8..OD-12 approved as recommended; go for lanes L1 (TS + contract) and L2 (asr-vllm). Owner reminder: v1-compat is gone — selection is agent/workflow only; the vLLM model is reached through an ASR Agent, never a model slug.
- 2026-09-29 — Phase B plan (OD-6 + OD-7) written, awaiting go; OD-8..OD-12 opened; tts/nlp credential-header defect found and split out.
- 2026-09-29 — Owner OD round: OD-5 accepted (own lock + vLLM image); OD-7 registry-first (AiModel row + `model-registry:huggingface` credential, no ambient pulls); OD-6 directed to platform configuration, shape proposed. Lanes merged into `dev-2.2` (`cd56ccdba` TASK-1009, `e5337ed9b` TASK-1010).
- 2026-09-29 — Lane `task-1010/asr-vllm-service`: `apps/asr-vllm` service (decode endpoint, engine pool, lazy vLLM 0.30.0 adapter, warm route, health/metrics), concurrency bench, CUDA Dockerfile (not built), root scripts + launcher target. Workspace lock unsatisfiable with vLLM → standalone lock (V-1). 93 unit tests green on the Mac; no GPU run. Added OD-5..OD-7.
- 2026-09-29 — Owner: 25 streams is milestone 1, design target 1,000; added scale-out criteria.
- 2026-09-29 — Ticket opened from the TASK-1007 follow-up research (whisper.cpp batching limits,
  faster-whisper/vLLM survey).
