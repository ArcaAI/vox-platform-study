# vllm — HOPE inference shell on vLLM

**Status:** TASK-1021 Phase 1 — Whisper ASR only (D-7). Renamed from the TASK-1010 spike
`apps/asr-vllm`. Port **8867**, package `hope_vllm` (a package named `vllm` would shadow
the engine), settings prefix `VLLM_`.

An OpenAI-compatible, pool-managed inference tier. A client names a registered model
(`model=<slug>`); the shell resolves the slug through the gateway **for the calling tenant**
(tenant row first, then SYSTEM — never another customer), builds one vLLM engine per
resolved row, and serves every request through vLLM's continuous batching. STT keeps
sessions, segmentation, lexicon and metering and sends each ~7 s window here.

Nothing ties a request to a replica: a pool scales out as N identical replicas behind one
k8s Service.

## Run

| Where | How | What you get |
|---|---|---|
| Mac (`arcaenv`) | `pnpm vllm:dev` | the HTTP shell only — `/health/ready` is **503** "vllm is not installed". vLLM is Linux + CUDA only and must **never** be installed into `arcaenv`. |
| Linux + NVIDIA | `docker build -f apps/vllm/Dockerfile -t hope-vllm .` then `docker run --gpus all -p 8867:8867 -e INTERNAL_ACCESS_TOKEN=… -e VLLM_API_GATEWAY_URL=http://<gateway>:8868/api/v1 -e VLLM_POOL=default -v <models>:/mnt/models-bucket:ro hope-vllm` | the real engine |
| Bare GPU VM, no Docker | `cd apps/vllm && uv sync --extra vllm` (Python 3.11, this service's own `uv.lock`), then `uvicorn --factory hope_vllm.main:create_app --port 8867` | the real engine |

Tests / gates (none needs a GPU — the vLLM adapter is exercised against a stand-in module):
`pnpm vllm:test`, `vllm:lint`, `vllm:typecheck`, `vllm:format:check`. The launcher's port
override is `HOPE_VLLM_PORT` — never `VLLM_PORT`, which vLLM itself reads.

## API (C-3)

Every non-probe route needs the shared `INTERNAL_ACCESS_TOKEN` as `X-Service-Token` **or**
`Authorization: Bearer <token>` (what a stock OpenAI client sends as its `api_key`). Empty
token = dev bypass only when running locally; fail closed when deployed. `/v1/*` also needs
**`X-Tenant-Id`** (400 `tenant_id_required`).

### `POST /v1/audio/transcriptions` — multipart

| Field | |
|---|---|
| `file` | WAV, PCM16, mono, any rate (resampled to 16 kHz), ≤ 30 s |
| `model` | registered slug, required |
| `language` | ISO-639-1, **required** (deviates from OpenAI: Whisper-on-vLLM needs the language token) |
| `prompt` | optional previous text → `<|startofprev|>` (TASK-994: omit it for the ml-en fine-tune) |
| `temperature` | 0–1, default 0 |
| `response_format` | `json` (default) · `text` · `verbose_json` |

```jsonc
// json
{"text":"..."}
// verbose_json
{"task":"transcribe","language":"ml","duration":12.48,"text":"...","segments":[],
 "x_hope":{"finish_reason":"stop","decode_ms":812.4,"engine_queue_ms":3.1,
           "truncation":{"suspected":false,"reason":null,"voiced_seconds":9.7,"chars":142}}}
```

This is a THIN HOPE implementation of the OpenAI schema over this service's own
`VllmWhisperEngine`, **not** vLLM's upstream transcription handler (D-8): vLLM 0.30.0's
handler prefixes prior text with `<|prev|>` (not a Whisper token) and leaves
`SamplingParams.max_tokens` at 16. Here the budget is always the whole remaining decoder
context. A stock `openai.AsyncOpenAI(base_url=…/v1, api_key=<token>,
default_headers={"X-Tenant-Id": …}).audio.transcriptions.create(...)` works unchanged
(pinned by `tests/unit/test_openai_sdk_contract.py`).

A client that disconnects mid-decode is noticed; the request is aborted inside vLLM and its
lease released.

Errors are OpenAI-shaped — `{"error":{"message","type","param","code"}}`:

| Status | `type` | `code` |
|---|---|---|
| 400 | `invalid_request_error` | `audio_too_long` · `unsupported_audio` · `language_required` · `tenant_id_required` · `invalid_value` · `missing_required_parameter` · `prompt_too_long` |
| 401 | `authentication_error` | `invalid_service_token` |
| 404 | `invalid_request_error` | `model_not_found` |
| 409 | `invalid_request_error` | `model_not_servable` (reason in the message: `FORMAT_UNSUPPORTED` · `SERVING_FACTS_MISSING` · `DISABLED` · `KIND_NOT_ACCEPTED` · `RUNTIME_KEY_SPEC_MISMATCH`) |
| 429 + `Retry-After` | `rate_limit_error` | `engine_saturated` — more than `maxNumSeqs × inflightFactor` leases on one engine |
| 503 | `server_error` | `engine_capacity` (+ `Retry-After`) · `engine_load_failed` · a named build refusal (`MODEL_NOT_PUBLISHED`, `VRAM_BUDGET_EXCEEDED`, `QUANTIZATION_UNSUPPORTED[_ON_GPU]`, `MODEL_CHECKSUM_MISMATCH`, `MODEL_CREDENTIAL_*`, `MODEL_DOWNLOAD_FAILED`, …) · `ENGINE_BACKEND_UNAVAILABLE` · `serving_spec_unavailable` (+ `Retry-After`) · `draining` (+ `Retry-After`) |

Build failures are never cached — the next request re-evaluates.

### `GET /v1/models`

`{"object":"list","data":[{"id":<slug>,"object":"model","owned_by":"hope","x_hope":{"kind":"asr","resident":true,"pinned":false}}]}`
— resident engines and the pool's pins (a pin still loading shows `resident: false`). A
resident engine owned by ANOTHER tenant (a BYO row) is never listed.

### House routes (house error shape `{"detail":{"code","message"}}`)

* `POST /api/v1/engines/warm` — `{"model": <slug>}` + `X-Tenant-Id` → `{runtime_key, already_resident, load_seconds}`.
  The scale-out contract: warm a new replica, then route to it.
* `GET /api/v1/engines` — the pool snapshot (budget, resident GiB, engines, loading).
* Health (HOPE four-route contract): `/api/v1/health` (always 200) · `/health/live` (reads
  nothing — never fails because the replica is busy or loading) · `/health/ready` (503 when
  vLLM is absent or while draining; no engine yet = `degraded` but ready) ·
  `/health/startup` (503 until every pin is resident).
* `/metrics` — see below.

## Model selection — the `AiModel` row

The gateway route `GET /api/v1/internal/models/:slug/serving-spec?service=vllm` (C-2;
`X-Service-Token` + `X-Tenant-Id`) returns a `ResolvedServingSpec`
(`packages/types/src/serving-spec.ts`; the pydantic mirror is `hope_vllm/spec.py`, strict,
pinned to `tests/contracts/resolved-serving-spec.fixture.json`). 404 → `model_not_found`,
409 → `model_not_servable`. `core/serving_spec_client.py` caches it per `(tenant, slug)` —
the tenant is always in the key, so tenant A's BYO row is never served to tenant B under
the same slug — 60 s positive, 10 s negative, single-flight; a gateway fault is never cached.

`runtimeKey = "<aiModel.id>:<checksum ?? v<version>>"` (D-13) is the engine's identity.
One runtime key must mean one set of weights (path, source, checksum, format, dtype,
quantization, context length, owner); a sizing-only edit that keeps the key is served by
the resident engine until it is evicted.

## Pools and admission (C-4)

This process serves ONE entry of the platform setting `vllm.pools`, named by `VLLM_POOL`
(default `default`); an undeclared name refuses to start. Default:
`{"default":{"acceptedKinds":["asr"],"pins":[],"vramBudgetGiB":6,"maxResidentEngines":1,"inflightFactor":2}}`.

* **Kinds** — a model whose kind the pool does not accept → 409 `KIND_NOT_ACCEPTED`, before any load.
* **GiB admission** — `Σ vramGiB (resident + loading) + new ≤ vramBudgetGiB` and the count
  ≤ `maxResidentEngines`; otherwise the least-recently-used idle, unpinned engines are
  evicted, and only if that makes room; else 503 `engine_capacity`. A model bigger than the
  whole budget → 503 `VRAM_BUDGET_EXCEEDED`.
* **Pins** — resolved against the SYSTEM tenant and loaded in the background at startup;
  never evicted; `/health/startup` stays 503 until they are resident.
* **Engine sizing** comes from the MODEL ROW (`AiModel._metadata.serving`, D-11):
  `gpu_memory_utilization = round(vramGiB / device total GiB, 3)` (device total from NVML,
  no CUDA context), `max_num_seqs = maxNumSeqs ?? 64`, `enforce_eager = enforceEager ?? false`.
  Serving facts `computeType` → `dtype`, `quantization` (fp8 refused below sm_89 — OD-5 /
  TASK-1010 OD-11; `int8` refused by name), `maxModelLen` → `max_model_len`.

## Loading — registry first

vLLM is only ever handed a **local directory**, never a repo id.

1. `localPath` set and existing → loaded in place (the published models bucket). A file is refused.
2. **`HF_HUB_OFFLINE=1` (every cluster pod)**: anything not on the mount is a named 503
   `MODEL_NOT_PUBLISHED` — never an HF call. Publish the model to the bucket.
3. Otherwise an HF `sourceUri` is pulled with the **model owner's** `model-registry:huggingface`
   credential (`GET {gateway}/internal/model-registry-credential?service=vllm&…`); `ABSENT` →
   anonymous (`token=False`), `DENIED` / `UNAVAILABLE` → 503, never retried anonymously.
4. Any other scheme is refused by name.

`HF_HUB_DISABLE_IMPLICIT_TOKEN=1` is forced; `HF_TOKEN` is never read. The row's `checksum`
is verified against the published manifest's primary object where one exists.

## Configuration

**Env is the bootstrap floor only:**

| Variable | Default | Note |
|---|---|---|
| `INTERNAL_ACCESS_TOKEN` | "" | vault-kv; inbound credential AND the token presented to the gateway |
| `VLLM_API_GATEWAY_URL` | `http://localhost:8868/api/v1` | blank ⇒ no control plane, every `model=` is 503 `serving_spec_unavailable` |
| `VLLM_POOL` | `default` | which entry of `vllm.pools` this pod is |
| `HF_HUB_OFFLINE` | unset | `1` on the cluster: bucket-only loading |
| `REDIS_URL` | "" | `arca:config:invalidate` push; blank ⇒ TTL-only |
| `VLLM_WEIGHTS_CACHE_DIR` | unset ⇒ `$HF_HOME/hub` | where an HF pull lands |
| `HOPE_VLLM_PORT` | 8867 | `scripts/dev-service.sh` only |

vLLM itself warns about any unknown `VLLM_*` variable in its environment (`VLLM_POOL`,
`VLLM_API_GATEWAY_URL`, …) — harmless. A k8s **Service named `vllm`** would inject
`VLLM_PORT=tcp://…` into pods of the namespace, which vLLM reads as its own port and
fails on; name the Services otherwise.

**Platform settings** (`global-kv`, platform-only, `failMode: 'open-to-default'`, pulled from
`GET /internal/effective-config?service=vllm`, TTL 60 s ± 10 %, negative-cached, evicted by
`arca:config:invalidate`): `vllm.pools` (read at every admission; a malformed map, or one
that drops this pod's pool, is refused whole), `vllm.truncation.minCharsPerVoicedSecond`
(3.0) and `vllm.truncation.voicedDbfs` (−40), read per request. A build awaits the pull; a
request never does.

## Metrics

`hope_vllm_requests_total{route,kind,model,status}`, `hope_vllm_request_seconds{route,kind}`,
`hope_vllm_asr_rtf{model}`, `hope_vllm_inflight{model}`, `hope_vllm_queue_depth{model}`,
`hope_vllm_rejections_total{reason}`, `hope_vllm_engine_loads_total{result}`,
`hope_vllm_engine_evictions_total`, `hope_vllm_resident_gib`, `hope_vllm_vram_budget_gib`,
`hope_vllm_engine_queue_seconds`, `hope_vllm_truncation_suspected_total{reason}`; the
model-residency contract `model_resident_bytes{service="vllm",model,device}` and
`model_load_seconds{service="vllm",model}`; and vLLM's own `vllm:*` series
(`disable_log_stats=False`, default registry). `model` is always a gateway-resolved slug;
no series carries a tenant. vLLM request logging is off — no transcript is ever logged.

## Drain

SIGTERM → `draining`: new `/v1/*` requests get 503 `draining` + `Retry-After`,
`/health/ready` 503; uvicorn's graceful window (`--timeout-graceful-shutdown 20` in the
image) lets in-flight decodes finish, then the lifespan waits for every lease before
closing the pool.

## Limits

* **30 s per request** — Whisper's encoder input; vLLM does not split for the engine API
  (vllm-project/vllm#15012). Refused by name, never cut.
* **Early-EOS audio drop** (vllm-project/vllm#53144) — `x_hope.truncation` flags
  `token_budget_exhausted` (certain) or `short_output_for_voiced_audio` (heuristic —
  calibrate on the TASK-994 fixtures before acting on it).
* Greedy/temperature only; no beam search, no segments.

## Dependency isolation

vLLM 0.30.0 pins `torch==2.13.0`, `fastapi<0.137` and `transformers>=5.10.4`; the root uv
workspace cannot hold that (every member needs `fastapi>=0.141.1`). So `apps/vllm` has its
own `pyproject.toml` + `uv.lock` (path sources for `hope-env` / `hope-obs`); the image is
`vllm/vllm-openai:v0.30.0` (digest-pinned) with the shell installed on top, constrained to
the image's versions. Lazily imported and undeclared on purpose: `huggingface_hub` (the HF
pull), `redis` (push invalidation — absent from the image, TTL only) and `pynvml` (vLLM's
`nvidia-ml-py`; the image build asserts it).

## Bench

```bash
export VLLM_BENCH_TOKEN=…   # never on argv
python apps/vllm/scripts/bench_concurrency.py --base-url https://<replica> \
  --tenant-id <uuid> --model arcaai-whisper-large-ml-en-vllm --language ml --output results.json \
  --wav "/Users/taphuynh/Desktop/lab/Woodman-2/output_aligned/Probiotic_Foods_Dr_Manoj_Johnson/0001_0.86_12.58/audio.wav"
```

Posts each window as a WAV to `/v1/audio/transcriptions`; the slug is resolved by the shell
for `--tenant-id`. The WAV is a TASK-994 ml-en fixture held **outside git**.
`--hop-s` < `--window-s` adds sliding partial decodes on top of finals.
