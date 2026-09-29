# asr-vllm — Whisper decode on vLLM continuous batching

**Status:** TASK-1010 spike. Port **8867**, package `asr_vllm`, settings prefix `ASR_VLLM_`.

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
| Mac (`arcaenv`) | `pnpm asr-vllm:dev` | the HTTP shell only — `/health/ready` is **503** "vllm is not installed". vLLM is Linux + CUDA only and must **never** be installed into `arcaenv`. |
| Linux + NVIDIA | `docker build -f apps/asr-vllm/Dockerfile -t asr-vllm .` then `docker run --gpus all -p 8867:8867 -e INTERNAL_ACCESS_TOKEN=… -v <models>:/mnt/models-bucket:ro asr-vllm` | the real engine |
| Bare GPU VM, no Docker | `cd apps/asr-vllm && uv sync --extra vllm` (Python 3.11, uses this service's own `uv.lock`), then `uvicorn --factory asr_vllm.main:create_app --port 8867` | the real engine |

Tests / gates (none needs a GPU — the vLLM adapter is exercised against a stand-in module):
`pnpm asr-vllm:test`, `asr-vllm:lint`, `asr-vllm:typecheck`, `asr-vllm:format:check`.

## API

All routes are under `/api/v1`. Non-probe routes need `X-Service-Token` (the shared
`INTERNAL_ACCESS_TOKEN`; empty token = dev bypass **only** when running locally, fail
closed when deployed) and **`X-Tenant-Id`** (400 `TENANT_ID_REQUIRED` when absent).

### `POST /transcriptions` — decode one window

```json
{
  "spec": {
    "runtimeKey": "<ASR Agent version id>",
    "slug": "arcaai-whisper-large-ml-en",
    "format": "SAFETENSOR",
    "sourceUri": "taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-fp16",
    "sourceRevision": "main",
    "localPath": "/mnt/models-bucket/hf/…/snapshots/<sha>",
    "computeType": "float16",
    "quantization": null,
    "maxModelLen": null
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
* **Envelope keys are snake_case; `spec` keeps the gateway's camelCase wire names**
  (`AsrSpecModel` / `AsrSpecCore.runtimeKey`), so STT forwards it without renaming.
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
| 422 | (pydantic) | spec drift (`extra='forbid'`), `format` ≠ `SAFETENSOR` (GGUF / CT2 rows cannot load in vLLM), non-16 kHz |
| 503 | `ENGINE_BACKEND_UNAVAILABLE` | vLLM not in this image |
| 503 | `ENGINE_LOAD_FAILED` | the engine failed to build (not cached — next request retries) |
| 503 + `Retry-After` | `ENGINE_CAPACITY` | every resident engine busy and the residency bound reached |

### `POST /engines/warm` — `{ "spec": … }` → `{ runtime_key, already_resident, load_seconds }`

Loads an engine before traffic arrives. This is the scale-out contract: a router warms a
new replica, then routes to it — the cold start is paid once, off the request path
(TASK-1007 F-5 was scale-out adding restarts instead of capacity).

### Health (HOPE four-route contract)

`/health` (always 200) · `/health/live` (reads nothing — never fails because the replica is
busy decoding or loading weights; TASK-1007 D-2) · `/health/ready` (503 only when the
backend is missing; no engine yet = `degraded` but ready) · `/health/startup`.
`/metrics` adds `asr_vllm_inflight_windows` and `asr_vllm_engine_queue_seconds` (the
two candidate autoscaling signals), `asr_vllm_engine_load_seconds` (cold start),
`asr_vllm_decode_seconds`, `asr_vllm_windows_total{outcome}`,
`asr_vllm_truncation_suspected_total{reason}`. Labels never carry a tenant or content.

## How model selection flows

The gateway resolves the tenant's ASR Agent → registry rows (`ResolvedAsrSpec`, TASK-861);
STT holds that spec per session and, in the STT-adapter follow-up, forwards the ASR model
slice + `runtimeKey` with every window. This service only **executes** it: the
`EnginePool` builds one vLLM engine per `runtimeKey` on first use (single-flight), keeps
at most `ASR_VLLM_MAX_RESIDENT_ENGINES`, evicts the least-recently-used **idle** engine at
the bound, and refuses a key reused for different weights. `localPath` (the published
models bucket) wins over `sourceUri`; an HF source loads at its pinned `sourceRevision`.
`quantization` and `maxModelLen` are NEW spec fields (not yet on `@arcaai/types`).

## Settings

| Variable | Default | Tier today | Note |
|---|---|---|---|
| `INTERNAL_ACCESS_TOKEN` | "" | vault-kv | shared inbound credential |
| `ASR_VLLM_GPU_MEMORY_UTILIZATION` | 0.5 | **spike env** | fraction of the WHOLE card per engine; on a time-sliced GPU this is the budget share |
| `ASR_VLLM_MAX_NUM_SEQS` | 64 | **spike env** | vLLM running-batch cap |
| `ASR_VLLM_ENFORCE_EAGER` | false | **spike env** | skip CUDA graphs (faster start, slower decode) |
| `ASR_VLLM_MAX_RESIDENT_ENGINES` | 1 | **spike env** | × gpu fraction must be ≤ 1 (validated at boot) |
| `ASR_VLLM_TRUNCATION_MIN_CHARS_PER_VOICED_SECOND` | 3.0 | **spike env** | vllm#53144 heuristic |
| `ASR_VLLM_TRUNCATION_VOICED_DBFS` | -40 | **spike env** | energy gate for "voiced" |
| `ASR_VLLM_LOG_LEVEL` / `LOG_LEVEL`, `OTEL_*` | — | env | read by `hope_obs` |
| `ASR_VLLM_PORT` | 8867 | launcher only | `scripts/dev-service.sh` |

The six **spike env** rows break the "tuning is control-plane, not env" rule on purpose
while the GPU run measures them; each must move to a descriptor or the agent/model row
before this leaves the spike (ticket README, deviations).

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
`fastapi>=0.141.1`. So `apps/asr-vllm` has its own `pyproject.toml` + `uv.lock` (path
sources for `hope-env` / `hope-obs`), and the root `uv.lock` is untouched. The image is
`vllm/vllm-openai:v0.30.0` (digest-pinned) with the service shell installed on top,
constrained to the image's own versions.

## Bench

```bash
export ASR_VLLM_BENCH_TOKEN=…   # never on argv
python apps/asr-vllm/scripts/bench_concurrency.py --base-url https://<replica> \
  --tenant-id <uuid> --spec-file spec.json --language ml --output results.json \
  --wav "/Users/taphuynh/Desktop/lab/Woodman-2/output_aligned/Probiotic_Foods_Dr_Manoj_Johnson/0001_0.86_12.58/audio.wav"
```

The WAV is a TASK-994 ml-en fixture: real clinician audio held **outside git**, read by
absolute path only. `--hop-s` < `--window-s` adds sliding partial decodes on top of finals.

## What the deployment repo will need (not edited here)

* A `hope-asr-vllm` Deployment on a GPU node: `nvidia.com/gpu` request (today 6/6 slices
  are allocated — OD-1), `ASR_VLLM_GPU_MEMORY_UTILIZATION` set to the budget share.
* Probes: liveness `/api/v1/health/live` (cheap, decode-independent); readiness
  `/api/v1/health/ready`; a startup probe with a long window for CUDA init.
* Models: the read-only models-bucket mount for `localPath` weights, and a PVC at
  `HF_HOME=/app/.cache/huggingface` for `sourceUri` pulls (+ vLLM compile cache under `$HOME`).
  A private HF repo needs an HF token — not wired (the registry-credential route STT uses).
* A ClusterIP Service on 8867; `INTERNAL_ACCESS_TOKEN` from Vault; HPA on
  `asr_vllm_inflight_windows` once the bench gives a per-replica ceiling.
* CI: an image build job and the build-info args (the Dockerfile already bakes `/app/build-info.json`).
