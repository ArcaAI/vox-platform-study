# vllm — Whisper decode on vLLM continuous batching

**Status:** TASK-1010 spike (phase B: platform configuration + registry-first loading).
Port **8867**, package `hope_vllm`, settings prefix `VLLM_`.

A stateless decode tier: STT keeps sessions, segmentation, lexicon and metering, and
sends each ~7 s window here. Concurrency comes from vLLM's **continuous batching across
simultaneous requests** — the service adds no lock or queue in front of the engine, so
25 streams' windows ride one batch instead of queueing behind one decoder (the
TASK-1007 ceiling: one serial whisper.cpp decoder, commit p99 past 15 s from N≈10).

Nothing ties a stream to a replica, so the tier scales out as N identical replicas behind
one k8s Service (1,000-stream design target ⇒ 1,000 ÷ streams-per-GPU replicas).

## Run

| Where | How | What you get |
|---|---|---|
| Mac (`arcaenv`) | `pnpm vllm:dev` | the HTTP shell only — `/health/ready` is **503** "vllm is not installed". vLLM is Linux + CUDA only and must **never** be installed into `arcaenv`. |
| Linux + NVIDIA | `docker build -f apps/vllm/Dockerfile -t vllm .` then `docker run --gpus all -p 8867:8867 -e INTERNAL_ACCESS_TOKEN=… -e VLLM_API_GATEWAY_URL=http://<gateway>:8868/api/v1 -v <models>:/mnt/models-bucket:ro vllm` | the real engine |
| Bare GPU VM, no Docker | `cd apps/vllm && uv sync --extra vllm` (Python 3.11, uses this service's own `uv.lock`), then `uvicorn --factory hope_vllm.main:create_app --port 8867` | the real engine |

Tests / gates (none needs a GPU — the vLLM adapter is exercised against a stand-in module):
`pnpm vllm:test`, `vllm:lint`, `vllm:typecheck`, `vllm:format:check`.

## API

All routes are under `/api/v1`. Non-probe routes need `X-Service-Token` (the shared
`INTERNAL_ACCESS_TOKEN`; empty token = dev bypass **only** when running locally, fail
closed when deployed) and **`X-Tenant-Id`** (400 `TENANT_ID_REQUIRED` when absent).

### `POST /transcriptions` — decode one window

```json
{
  "spec": {
    "schemaVersion": 1,
    "runtimeKey": "<ASR Agent version id>",
    "agent": { "…": "ignored here" },
    "models": {
      "asr": {
        "role": "asr",
        "slug": "arcaai-whisper-large-ml-en-vllm",
        "taskType": "AUTOMATIC_SPEECH_RECOGNITION",
        "format": "SAFETENSOR",
        "libraryName": "transformers",
        "sourceUri": "taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-fp16",
        "sourceRevision": "main",
        "localPath": "/mnt/models-bucket/hf/hub/models--taphuynh--…/snapshots/<sha>/",
        "checksum": "<sha256 of the published primary object, or null>",
        "computeType": "float16",
        "provider": null,
        "tenantId": "00000000-0000-0000-0000-000000000000",
        "quantization": "none",
        "maxModelLen": 448
      }
    },
    "audioFrontEnd": { "…": "ignored here" },
    "fallback": { "…": "ignored here" }
  },
  "audio_b64": "<PCM16 LE, mono, 16 kHz, ≤ 30 s, base64>",
  "sample_rate": 16000,
  "language": "ml",
  "prompt": null,
  "temperature": 0.0,
  "max_tokens": null
}
```

```json
{
  "text": "…",
  "language": "ml",
  "runtime_key": "<ASR Agent version id>",
  "audio_seconds": 7.0,
  "finish_reason": "stop",
  "timings": { "queue_ms": 0.4, "decode_ms": 612.0, "engine_queue_ms": 35.2 },
  "truncation": { "suspected": false, "reason": null, "voiced_seconds": 6.4, "chars": 91 }
}
```

* **Body encoding: JSON with base64 audio.** The request carries a nested spec that must
  validate strictly; one self-describing body is one atomic unit to validate, log (without
  the audio) and replay. Cost: a 7 s window is 224 KB raw → ~299 KB base64, decoded in
  under a millisecond — noise next to a decode, on an in-cluster hop.
* **`spec` IS the gateway's `ResolvedAsrSpec`** (`packages/types/src/asr-spec.ts`),
  camelCase, forwarded by STT unchanged (a fallback-chain `AsrSpecCore` works too). The
  service parses `runtimeKey` + `models.asr` — `slug`, `format` (must be `SAFETENSOR`),
  `tenantId` (the row's OWNER), `checksum`, `sourceUri`, `sourceRevision`, `localPath`,
  `computeType`, and the optional `quantization` / `maxModelLen` — and **ignores every
  other key** (`extra='ignore'`): the shared spec evolves and `apps/stt/…/pipeline/spec.py`
  is its strict mirror, so a contract change elsewhere never 422s the decode tier.
  `runtimeKey`, `models.asr.tenantId` and the `models.asr.checksum` key (`null` allowed)
  are the registry identity and are required. Envelope keys are snake_case.
* `timings.queue_ms` — wait at this replica for a ready engine (load / single-flight).
  `decode_ms` — engine submit → final output, including vLLM's own batching.
  `engine_queue_ms` — vLLM's scheduler wait when the engine reports request stats.
* `max_tokens` absent ⇒ the whole remaining decoder context (`maxModelLen −` prompt tokens).
  vLLM's own default is **16**, a silent truncation for ASR, so a budget is always sent.
* `prompt` becomes `<|startofprev|>…` (Whisper's real token; vLLM 0.30.0's server writes
  `<|prev|>`, which is not one). **TASK-994: omit it for the ml-en fine-tune** — any prior
  text degraded it.

| Status | `detail.code` | When |
|---|---|---|
| 400 | `TENANT_ID_REQUIRED` | no `X-Tenant-Id` |
| 401 | — | bad / missing `X-Service-Token` |
| 409 | `RUNTIME_KEY_SPEC_MISMATCH` | a runtime key already bound to different weights |
| 422 | `WINDOW_TOO_LONG` · `AUDIO_NOT_BASE64` · `AUDIO_EMPTY` · `AUDIO_ODD_BYTE_LENGTH` · `PROMPT_EXCEEDS_DECODER_CONTEXT` | bad window / prompt |
| 422 | (pydantic) | not a resolver's spec: `runtimeKey` / `models.asr.tenantId` / `models.asr.checksum` missing, `format` ≠ `SAFETENSOR` (GGUF / CT2 rows cannot load in vLLM), an unknown `quantization`, non-16 kHz |
| 503 | `ENGINE_BACKEND_UNAVAILABLE` | vLLM not in this image |
| 503 | `MODEL_CREDENTIAL_DENIED` | the owner vetoed `model-registry:huggingface` (never retried anonymously) |
| 503 | `MODEL_CREDENTIAL_UNAVAILABLE` | the gateway could not resolve the credential (or none is configured) |
| 503 | `MODEL_DOWNLOAD_FAILED` · `MODEL_SOURCE_UNSUPPORTED` · `MODEL_SOURCE_NOT_A_DIRECTORY` | the weights could not be materialised as a local directory |
| 503 | `MODEL_CHECKSUM_MISMATCH` | the published primary object does not match the row's `checksum` |
| 503 | `QUANTIZATION_UNSUPPORTED` | a `quantization` vLLM has no method for (`int8`) |
| 503 | `QUANTIZATION_UNSUPPORTED_ON_GPU` | `fp8` on a GPU below compute capability 8.9 (OD-11) |
| 503 | `ENGINE_LOAD_FAILED` | any other build failure |
| 503 + `Retry-After` | `ENGINE_CAPACITY` | every resident engine busy and the residency bound reached |

Build failures are never cached — the next request re-evaluates, so a fixed credential or
row takes effect without a restart.

### `POST /engines/warm` — `{ "spec": … }` → `{ runtime_key, already_resident, load_seconds }`

Loads an engine before traffic arrives. This is the scale-out contract: a router warms a
new replica, then routes to it — the cold start is paid once, off the request path
(TASK-1007 F-5 was scale-out adding restarts instead of capacity).

### Health (HOPE four-route contract)

`/health` (always 200) · `/health/live` (reads nothing — never fails because the replica is
busy decoding or loading weights; TASK-1007 D-2) · `/health/ready` (503 only when the
backend is missing; no engine yet = `degraded` but ready) · `/health/startup`.
`/metrics` adds `hope_vllm_inflight_windows` and `hope_vllm_engine_queue_seconds` (the
two candidate autoscaling signals), `hope_vllm_engine_load_seconds` (cold start),
`hope_vllm_decode_seconds`, `hope_vllm_windows_total{outcome}`,
`hope_vllm_truncation_suspected_total{reason}`. Labels never carry a tenant or content.

## Model selection — an Agent, never a model

The service **never chooses a model**, and nothing in its API, settings or bench names one
(no slug, engine, path or pipeline selector). The gateway resolves the tenant's ASR
**Agent** to registry rows and builds the `ResolvedAsrSpec` (TASK-861; one producer,
`buildResolvedAsrSpec`); STT holds it per session and forwards it with every window. This
service only **executes** it: the `EnginePool` builds one vLLM engine per `runtimeKey` on
first use (single-flight), keeps at most `asrVllm.engine.maxResidentEngines`, evicts the
least-recently-used **idle** engine at the bound, and refuses a key reused for different
weights. It stays DB-less: registry enforcement is that only the gateway resolver builds
specs from registered rows, and only service-token holders can call this service.

## Loading — registry first (OD-7)

vLLM is only ever handed a **local directory**, never a repo id, so it can never pull on
its own with an ambient token.

1. `models.asr.localPath` set and existing → loaded **in place** (the published models
   bucket; preferred). A file instead of a directory is refused. Set-but-missing falls
   through with a warning.
2. Otherwise an HF `sourceUri` (`org/repo`, `hf:`, `hf://`, `huggingface://`) is pulled
   with the **model owner's** registry credential — `GET {gateway}/internal/model-registry-
   credential?service=vllm&provider=huggingface&tenantId=<models.asr.tenantId>`,
   headers `X-Service-Token` (`INTERNAL_ACCESS_TOKEN`) + `X-Tenant-Id`. `RESOLVED` → pull
   with the token; `ABSENT` → pull anonymously (`token=False`, public repos only);
   `DENIED` / `UNAVAILABLE` → 503, never retried anonymously. `huggingface_hub.
   snapshot_download(repo, revision, token, cache_dir)` lands in the pod's weights cache
   and the snapshot directory it returns is what vLLM (and its tokenizer) load.
3. Any other scheme (`s3://`, `file://`, a cloud engine) is refused by name.

`HF_HUB_DISABLE_IMPLICIT_TOKEN=1` is forced at app build and in the image; `HF_TOKEN` is
never read. **Checksum:** `AiModel.checksum` is the SHA256 of the publication's primary
weights object, so it is verified where the published `manifest.json` names that object
(hash compared; a mismatch, a missing object or a manifest pointing outside its directory
refuses the weights). A directory with no manifest — an HF snapshot — cannot say which file
the digest describes and is left to the Hub's own per-file verification, with a warning
(STT's multi-file rule).

**Serving facts** ride the registry row (`AiModel._metadata.asr`, OD-8) into the spec:
`computeType` → vLLM `dtype`; `maxModelLen` → `max_model_len`; `quantization` →
`none`/absent = the checkpoint's own precision, `fp8`/`awq`/`gptq` passed through, `int8`
refused (vLLM has no method of that name). **fp8 needs compute capability ≥ 8.9**: refused
below it by name (OD-11 — the production RTX A6000 is sm_86, dev's RTX 2000 Ada is sm_89),
probed through vLLM's NVML-backed platform layer. A quantised variant is its own registry
row, bound to an agent explicitly — never a toggle here.

## Configuration

**Env is the bootstrap floor only** — what the process needs to reach its control plane
and be reached:

| Variable | Default | Tier | Note |
|---|---|---|---|
| `INTERNAL_ACCESS_TOKEN` | "" | vault-kv | shared inbound credential AND the token presented to the gateway's `/internal/*` |
| `VLLM_API_GATEWAY_URL` | `http://localhost:8868/api/v1` | env (transport) | blank ⇒ no control plane: platform settings stay at defaults, HF pulls fail closed |
| `REDIS_URL` | "" | env (shared transport) | `arca:config:invalidate` push; blank ⇒ TTL-only (see below) |
| `VLLM_WEIGHTS_CACHE_DIR` | unset ⇒ `$HF_HOME/hub` | env (pod topology) | where an HF pull lands — mount a PVC |
| `VLLM_LOG_LEVEL` / `LOG_LEVEL`, `OTEL_*` | — | env | read by `hope_obs` |
| `HOPE_VLLM_PORT` | 8867 | launcher only | `scripts/dev-service.sh` |

**Platform settings (OD-6)** — `global-kv` descriptors, `maxScope:'system'`,
`globalOnly:true` (platform-only: they size a shared GPU pool), `failMode:
'open-to-default'`, pulled from `GET /internal/effective-config?service=vllm`:

| Key | Type / bounds | Default | Applies |
|---|---|---|---|
| `asrVllm.engine.gpuMemoryUtilization` | number 0.05–0.95 | 0.20 | next engine build |
| `asrVllm.engine.maxNumSeqs` | int 1–1024 | 64 | next engine build |
| `asrVllm.engine.enforceEager` | bool | false | next engine build |
| `asrVllm.engine.maxResidentEngines` | int 1–4 | 1 | next eviction check |
| `asrVllm.truncation.minCharsPerVoicedSecond` | number ≥ 0 | 3.0 | per request |
| `asrVllm.truncation.voicedDbfs` | number −90–0 | −40 | per request |

A served value outside the bounds or of the wrong type is refused (the value in force
stays); `gpuMemoryUtilization × maxResidentEngines` must fit one card and a pair that does
not is refused as a pair. The pull is TTL-cached (60 s ± 10 %), negative-cached on failure
(open-to-default, a warning, never a crash), single-flight, and evicted by
`arca:config:invalidate`. A **build awaits** the pull; a **request never does** — it
starts a background refresh when stale, so a decode window never waits on the gateway.
The six former spike env vars (`VLLM_GPU_MEMORY_UTILIZATION`, `…_MAX_NUM_SEQS`,
`…_ENFORCE_EAGER`, `…_MAX_RESIDENT_ENGINES`, `…_TRUNCATION_MIN_CHARS_PER_VOICED_SECOND`,
`…_TRUNCATION_VOICED_DBFS`) are CLOSED (`…__MOVED_TO_CONTROL_PLANE` dead alias): a stale
value in a ConfigMap no longer does anything.

Push invalidation needs the `redis` package, which is not in this service's lock or the
vLLM image today — until it is added, the listener logs once and the TTL is the only path.

## Limits

* **30 s per window** — Whisper's encoder input; vLLM does not split for the engine API
  (vllm-project/vllm#15012). Refused by name, never cut silently.
* **Early-EOS audio drop** (vllm-project/vllm#53144) — undetectable from the response, so
  `truncation` flags `token_budget_exhausted` (certain) or `short_output_for_voiced_audio`
  (heuristic — calibrate on the TASK-994 fixtures before acting on it).
* Beam search is not offered (inefficient for encoder-decoder in vLLM); greedy/temperature.

## Dependency isolation

vLLM 0.30.0 pins `torch==2.13.0`, `fastapi<0.137` and `transformers>=5.10.4`. Adding this
service to the root uv workspace was tried (2026-09-29) and is **unsatisfiable**:
`harness` (and `hope-obs[dev]`, even with the vLLM extra declared conflicting) require
`fastapi>=0.141.1`. So `apps/vllm` has its own `pyproject.toml` + `uv.lock` (path
sources for `hope-env` / `hope-obs`), and the root `uv.lock` is untouched. The image is
`vllm/vllm-openai:v0.30.0` (digest-pinned) with the service shell installed on top,
constrained to the image's own versions.

Two imports are deliberately LAZY and undeclared: `huggingface_hub` (the HF pull; the
image gets it from vLLM's `transformers`) and `redis` (push invalidation; absent from
the image today, so the TTL is the only propagation path until it is declared in this
service's `pyproject.toml` and its own lock regenerated).

## Bench

```bash
export VLLM_BENCH_TOKEN=…   # never on argv
python apps/vllm/scripts/bench_concurrency.py --base-url https://<replica> \
  --tenant-id <uuid> --spec-file spec.json --language ml --output results.json \
  --wav "/Users/taphuynh/Desktop/lab/Woodman-2/output_aligned/Probiotic_Foods_Dr_Manoj_Johnson/0001_0.86_12.58/audio.wav"
```

`spec.json` is the gateway's `ResolvedAsrSpec` for the ASR Agent under test (refused up
front without `runtimeKey` + `models.asr`); the bench has no option that names a model.
OD-12 planned `--agent-slug` via `GET /internal/agents/resolve`, but that route returns a
`ResolvedAgent`, not a `ResolvedAsrSpec` (`buildResolvedAsrSpec` runs only inside STT's
session / batch paths), so `--spec-file` stays until a route returns the built spec —
capture the `resolved_spec` the gateway sends STT for a real session.

The WAV is a TASK-994 ml-en fixture: real clinician audio held **outside git**, read by
absolute path only. `--hop-s` < `--window-s` adds sliding partial decodes on top of finals.

## What the deployment repo will need (not edited here)

* A `hope-vllm` Deployment on a GPU node: `nvidia.com/gpu` request (today 6/6 slices
  are allocated — OD-1). The GPU budget share is the platform setting
  `asrVllm.engine.gpuMemoryUtilization` on the SYSTEM row, not a manifest value.
* Probes: liveness `/api/v1/health/live` (cheap, decode-independent); readiness
  `/api/v1/health/ready`; a startup probe with a long window for CUDA init.
* Models: the read-only models-bucket mount for `localPath` weights, and a PVC at
  `HF_HOME=/app/.cache/huggingface` for `sourceUri` pulls (+ vLLM compile cache under `$HOME`).
  A private HF repo is pulled with the owner's `model-registry:huggingface` connection
  through the gateway — no HF token in the manifest.
* Env: `VLLM_API_GATEWAY_URL` (the in-cluster gateway Service), `REDIS_URL`.
* A ClusterIP Service on 8867; `INTERNAL_ACCESS_TOKEN` from Vault; HPA on
  `hope_vllm_inflight_windows` once the bench gives a per-replica ceiling.
* CI: an image build job and the build-info args (the Dockerfile already bakes `/app/build-info.json`).
