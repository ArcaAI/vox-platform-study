# `hope-lmstudio` — LM Studio (`llmster`) headless GPU serving image

CI-built Docker image that wraps the proprietary LM Studio (`llmster`) CLI as a headless,
CUDA-accelerated model server. Engine choice (LM Studio + vLLM, not llama.cpp) is an owner
decision and is not open for re-litigation here.

> **CI IS THE ONLY BUILDER.** Owner directive, 2026-08-30. Do not run `docker build` for this
> image on a workstation — see How it works for why that is a correctness rule here, not a
> policy preference. Built by `.gitlab/ci/build.yml` -> `build-lmstudio`, gated by
> `verify-lmstudio-runtime`.
>
> **PRIVATE REGISTRY ONLY.** The image embeds a proprietary binary this project holds no
> redistribution right to. Never push it to a public registry or mirror.

## Layout

| File | What |
|---|---|
| `Dockerfile` | Single-stage. Pinned + SHA-512-verified `llmster` bundle on a CUDA runtime base (`nvidia/cuda:12.8.1-runtime-ubuntu24.04`), plus a pinned + SHA-256-verified Node runtime for the A-6 loader; build-time gates assert both a CPU and a CUDA engine are baked in, and that the loader's own unit tests pass inside the image |
| `entrypoint.sh` | The boot contract: seven ordered assertions (A-0, A-1, A-2, A-3, A-5, A-6, A-7 — there is no A-4), each fail-closed with exit 78, plus A-6b (start and supervise the residency agent) and `CUDA_DEVICE_ORDER=PCI_BUS_ID` before the daemon starts |
| `loader/` | The A-6 preloader. `kvconfig.mjs` (pure: env/plan -> kvConfig, key resolution, read-back diff) + `kvconfig.test.mjs`, `sdk-channel.mjs` (the `loadModel` channel + `getLoadConfig`, shared with the agent) + `sdk-channel.test.mjs`, `load.mjs` (boot I/O), and a lockfile-pinned `@lmstudio/sdk`. Replaces `lms load`, which cannot reach flash attention, KV-cache quantization or GPU placement |
| `agent/` | The residency agent (TASK-1055): `server.mjs` (entry, :8869), `http.mjs` (routes, auth, strict bodies), `residency.mjs` (report/load/unload/policy), `loadspec.mjs` (load_spec -> kvConfig via the loader's rules), `daemon.mjs` (REST + SDK adapter), `gpus.mjs` (nvidia-smi), `metrics.mjs` (Prometheus text, `/metrics`), `fixtures.mjs` + one `*.test.mjs` per module. No dependencies of its own |
| `.dockerignore` | Deny-all allow-list: only `Dockerfile`, `entrypoint.sh`, `loader/` and `agent/` (minus any local `node_modules`) reach the build context |

## How it works

### The silent-CPU trap, and the three places it is closed

`curl -fsSL https://lmstudio.ai/install.sh | bash` chooses its bundle by probing the **build
host**: it picks the CUDA bundle only if `nvidia-smi` and coreutils `timeout` are both present and
the driver is >= 550.54.14 — otherwise it silently falls back to the CPU bundle. A GPU-less CI
runner (or any laptop) hits this every time, and such an image *starts, serves and answers
requests*, just far slower. Hence: never pipe the installer. Three layers close it:

| Layer | Closes | Mechanism |
|---|---|---|
| **Dockerfile** | wrong bundle downloaded | Fetch one pinned URL; verify a pinned SHA-512. The CPU and CUDA bundles are provably different artifacts, so a CPU tarball cannot satisfy the check and the build aborts |
| **Dockerfile build gate** | bundle present but engines missing | After the daemon's first start (which materializes `~/.lmstudio/extensions/backends/`), the build asserts BOTH a CPU and a CUDA engine directory are on disk — an owner requirement, since a CPU-runnable image is not optional |
| **CI `verify-lmstudio-runtime`** | wrong bundle shipped | Runs the built image and asserts `lms runtime ls` lists a CUDA engine. Red pipeline -> never promoted |
| **`entrypoint.sh` A-2** | right image, wrong **node** | Selects the CUDA engine and asserts a GPU is actually present at runtime. Exit 78 |

The Dockerfile's own build-time engine check cannot use `lms runtime ls` — that command is
hardware-filtered and answers about the CI runner, not the image, so it correctly reports nothing
on a GPU-less builder even when the CUDA engine is on disk. It instead reads the filesystem
inventory under `~/.lmstudio/extensions/backends/` after starting the daemon once (which is what
actually materializes that directory — `llmster bootstrap` alone does not).

### Why the runtime layer is not redundant

A CPU-only deployment is **undetectable over HTTP**: `GET /api/v1/models` reports `format:
"gguf"` — a weights format, not an accelerator — and no `/api/v1/(runtime|engine|system|server)`
introspection path exists. So if a correctly built image lands on a node without
`runtimeClassName: nvidia`, without the `nvidia.com/gpu` resource, or below the driver floor,
**nothing downstream can ever tell**. `entrypoint.sh` A-2 is the only place it is catchable: it
selects the accelerated engine, then asserts a GPU is physically present via `lms runtime survey
--json` (`vramCapacity: 0` / `noDevicesFound` mean no GPU), failing closed unless
`HOPE_ACCEL_ENFORCE=strict` is deliberately relaxed.

### A-6 loads over the SDK websocket, not `lms load`

`lms load` and `POST /api/v1/models/load` between them cannot set three things the platform
needs (all measured — TASK-996 §2.3):

| kvConfig key | Why it matters |
|---|---|
| `llm.load.llama.flashAttention` | llama.cpp ran with `--flash-attn off`; it is the largest single latency lever, and V-cache quantization is impossible without it |
| `llm.load.llama.{k,v}CacheQuantizationType` | f16 KV across `context x parallel` slots accounted for ~10.5 GiB of the 13.9 GiB resident |
| `load.gpuSplitConfig` | The only per-model device selection there is. `nvidia.com/gpu: 4` on the Deployment is capacity bookkeeping, not a pin — placement is entirely LM Studio's decision |

The daemon supports all three; only the transport was missing. So A-6 runs `loader/load.mjs`,
which speaks the kvConfig websocket through `@lmstudio/sdk`. The `LMS_*` environment variables
are unchanged and remain the **bootstrap floor** — what the pod loads with before the database is
reachable. `--parallel` became `llm.load.numParallelSessions`, the same field the CLI itself
writes.

Three properties are worth knowing before changing this:

- **An unknown kvConfig key is IGNORED, not rejected.** That is the opposite of the REST API,
  which at least answered `unrecognized_keys`. So the loader reads the applied configuration back
  (`getLoadConfig`) and refuses to serve when a key it sent did not land, or landed with a
  different value. `HOPE_KVCONFIG_ENFORCE=warn` downgrades that to a warning, mirroring
  `HOPE_ACCEL_ENFORCE`.
- **The SDK's typed `LLMLoadModelConfig` is not enough.** Version 1.5.0 has no `parallel` field
  at all, and its `gpu` -> `gpuSplitConfig` converter can only ever emit a single-element
  `priority` (it tests `gpuSetting.mainGpu ?`, so GPU 0 drops out) and an empty `customRatio`.
  The loader therefore hand-assembles the field list; the key names come from running the SDK's
  own converter and from the shipping `lms` binary, not from documentation.
- **The SDK is a lockfile-pinned dependency, deliberately.** A copy already exists in the image
  at `~/.lmstudio/extensions/plugins/*/node_modules/@lmstudio/sdk`, but it is incidental to two
  bundled plugins, may vanish on an upgrade, and is not even the same artifact — it calls itself
  1.5.0 while declaring a `gpuSplitConfig.strategy` union npm's 1.5.0 does not have. Same reason
  the image installs its own Node instead of using `~/.lmstudio/.internal/utils/node`.

### A-6 loads a PLAN of models; A-7 never streams logs (TASK-1031)

- **Plan source, first usable wins:** the gateway's governed `lmStudioServing.preload`
  (`GET ${HOPE_API_URL}/api/v1/internal/effective-config?service=lmstudio`,
  `X-Service-Token: ${INTERNAL_ACCESS_TOKEN}`, retried for `HOPE_PLAN_FETCH_SECONDS`, default 60)
  → `LMS_PRELOAD_PLAN` (JSON array, same entry shape) → the legacy single-model `LMS_LOAD` +
  `LMS_CONTEXT`/`LMS_PARALLEL`/`LMS_GPU_*`. The loader logs which source won.
- **Every entry is required, pinned (no TTL) and verified**, loaded with its own context,
  `parallel` (`llm.load.numParallelSessions`), flash attention, K/V cache quantization and GPU.
  Identifier = slug. `gpu: n` becomes `priorityOrder [n]` with every other GPU disabled; the GPU
  count comes from `nvidia-smi` (override `LMS_GPU_COUNT`), and a pin with an unknown count fails
  closed. A KV quantization without `flashAttention: true` is refused, as on the env path.
- **A governed change applies on the next LM Studio restart** — parallel slots cannot change on a
  loaded model.
- **One retry per entry on a bad placement (TASK-1055 R2-F7).** A failed preload is no longer fatal
  at once: the entry is retried ONCE with only its placement (`load.gpuSplitConfig`) reset — to the
  `LMS_PRELOAD_PLAN` entry with the same slug, else to no split at all (the daemon's default) —
  and every other knob kept. The loader logs `WARNING loader.preload_fallback slug=…` with the
  failed and the fallback placement and the cause. It exists because an admin "make default"
  placement (OD-4) lands in the gateway plan, and a bad one used to crash-loop the pod and take
  all LLM traffic down. If the fallback also fails, or there is no DIFFERENT placement to try, the
  pod still dies (`node load.mjs || die`). A read-back drift is never retried — strict stays
  strict.
- **A-7 holds PID 1 on `lms daemon status`** (5 s poll, exit 1 after three consecutive misses).
  It used to `exec lms log stream`, which put every prompt and completion — PHI — into Loki.

### The residency agent on :8869 (TASK-1055)

The gateway's model-residency controller used to drive LM Studio over REST, which cannot set
parallel slots, KV-cache quantization, GPU split or the identifier, and needs the exact engine
key (`gemma-4-e2b-it-qat@q4_0`) the catalogue does not hold. A console reload therefore came back
degraded (E3) or refused (E2). The agent closes that: it runs **in this container** (owner
decision OD-1), started by `entrypoint.sh` stage A-6b after the boot plan is loaded and kept
alive by a supervisor loop (restart with a 1 → 30 s backoff), and loads over the SDK `loadModel`
channel on loopback — the same channel, kvConfig assembly (`assemblePlanRequest`) and read-back
the boot loader uses, so **a console load is a boot load** (AC-2).

| Route | Behaviour |
|---|---|
| `GET /health` | 200 `{status:"ok",daemon:"up"}` only when `/lmstudio-greeting` answers `{"lmstudio":true}`, else 503. No token. This is the pod's readiness (OD-6) — it names no model, so unloading one can no longer take the pod out of its Service (E1). Its status codes are honest, so an `httpGet` probe works here (unlike port 1234) |
| `GET /metrics` | Prometheus text (`text/plain; version=0.0.4`), no token — see *Metrics* below |
| `GET /internal/residency` | The python agent's report shape. `devices[]` = every card nvidia-smi lists (`cuda:<index>`, `index`, `name`, `uuid`, `total_bytes`, `free_bytes`, `process_bytes: null`). `models[]` = every loaded instance (llm + embedding): `model_ref` = identifier (a JIT instance's identifier is its engine key), `engine_key`, `instance_id`, `load_config` read back with `getLoadConfig`, `device` = `cuda:<n>` when the split enables one card else `multi`, `device_bytes` measured by this agent's own load, or — for boot-plan / JIT instances — the GGUF size split by the configured gpuSplit (`bytes_source: estimated`). 503 `DAEMON_UNAVAILABLE` if the daemon does not answer |
| `POST /internal/residency/load` | Optional `load_spec.expected_bytes` (R2-F10, a positive integer the gateway may send): before touching the daemon, each target card's share of it — the bytes divided by the effective split (`device` pin = one card; `gpu_split`; none = every card evenly) — is compared with nvidia-smi `memory.free`; short → 503 `INSUFFICIENT_MEMORY` `{device, needed_bytes, free_bytes}` (the first short card). Absent = no check; no nvidia-smi reading = skipped with a `residency.memory_check_skipped` warning. `model_ref` resolves to the exact key with the boot loader's `selectModelKey` (exact, else the unique `<ref>@<quant>`, never `@?`; several → 400 with `candidates`; none → 404 `MODEL_UNKNOWN`). `load_spec` (identifier, context_length, parallel, flash_attention, kv_cache_quant, gpu_split, ttl_seconds — any other key is refused) becomes the kvConfig; `device: cuda:<n>` overrides the split to `priorityOrder [n]` with every other card disabled (`cpu` / a card the pod lacks / an unknown card count → 400 `DEVICE_UNAVAILABLE`). One load at a time (a second → 409 `LOAD_IN_PROGRESS`). Per-card `memory.used` is read (settled) before and after; growth above 32 MiB is `device_bytes`. Strict read-back: drift → the instance is unloaded again and 500 `LOAD_FAILED` names the `fields` (`HOPE_KVCONFIG_ENFORCE=warn` keeps it). An identifier already loaded → `already_loaded`. A daemon failure → 500 `LOAD_FAILED` with the engine's message |
| `POST /internal/residency/unload` | By identifier, and by engine key / bare ref for JIT instances; `device` limits it to the copy on that card. Nothing matching (or a daemon "not found") → `not_loaded`. LM Studio has no in-flight count, so it is 0 and `force` never matters |
| `PUT /internal/residency/models/{ref}/policy` | `admin_pinned` / `ttl_seconds` kept **in the agent's memory** and reported; an absent field is unchanged, `ttl_seconds: null` resets. Not loaded → 404. LM Studio cannot change a TTL after load, so the daemon's TTL is the one sent at load (none when `pin: true`); a policy TTL applies at the next load. A restart of the agent forgets policies — the gateway re-asserts them |

Auth: `X-Service-Token` must equal `INTERNAL_ACCESS_TOKEN` (constant-time; `/health` and `/metrics` exempt); a
miss is 401. An empty token — or the `CHANGE_ME` placeholder, which counts as empty exactly as
`hope_env.real_secret` treats it — is the dev bypass ONLY on a developer machine. In a **deployed**
process it FAILS CLOSED (R2-F9): every `/internal` route answers 503 `AUTH_NOT_CONFIGURED`, the
agent logs `agent.auth_not_configured` at `error` when it starts, and `agent.gpus` reports
`auth: REFUSING …`. "Deployed" is the python services' rule (`apps/nlp/.../internal_auth.py`
`is_deployed`, TASK-892 C3): a non-blank `DEPLOYMENT_ENVIRONMENT` (base `production`, dev overlay
`dev`) or `NODE_ENV=production`; `NODE_ENV=test` overrides both; `CI` alone is not a deployment. Bodies are as strict as the python agent's pydantic models
(unknown field / wrong type → 422 `INVALID_REQUEST`, malformed JSON → 400, > 64 KiB → 413).
Logs are JSON lines on stdout (`{"ts","level","logger":"lmstudio-agent","event",…}`, SDK
console routed in); a failed load or unload is logged at `warn` with the engine's reason (E12).
The agent never carries model I/O.

Env: `LMS_AGENT_HOST`/`LMS_AGENT_PORT` (0.0.0.0 / 8869), `INTERNAL_ACCESS_TOKEN`,
`DEPLOYMENT_ENVIRONMENT` / `NODE_ENV` (the deployed marker above),
`LMS_GPU_COUNT` (override the nvidia-smi count), `LMS_AGENT_LOAD_TIMEOUT_SECONDS` (600),
`HOPE_KVCONFIG_ENFORCE`, `HOPE_RESIDENCY_AGENT=0` (disable). The agent needs `nvidia-smi` in the
container (the NVIDIA runtime mounts it into a `runtimeClassName: nvidia` pod) for device lists
and measurement; without it devices are empty, bytes fall back to estimates, and a `device`
pin is refused unless `LMS_GPU_COUNT` is set.

#### Metrics (`GET :8869/metrics`)

LM Studio itself exports nothing, so the agent exports the **python residency contract**
(`packages/py-runtime-models/src/hope_runtime_models/metrics.py`) — same names, types and label
names — and the `hope-model-residency` dashboard reads lm-studio with the queries it uses for stt
and nlp. `service` is the residency service name, as stt (`"stt"`) and nlp (`"nlp"`) label it:
here **`lm-studio`** (the report's `service`). Scrape `hope-lmstudio:8869/metrics`, and keep the
exporter's `service` label (`honor_labels: true`, or no target label named `service`) — a
relabelled `service` would turn ours into `exported_service` and split the panel.

| Metric | Type | Labels | Value |
|---|---|---|---|
| `model_resident_bytes` | gauge | `service, model, device` | the report's `device_bytes`: one series per instance per card, measured or estimated; `0` (on the instance's own `device`) when the size is unknown |
| `model_resident` | gauge | `service, model, device, state` | `1` with `state="loaded"` per instance per card (LM Studio reports only loaded instances) |
| `model_running_instances` | gauge | `service, model` | `1` per loaded instance (LM Studio has no in-flight count, unlike stt/nlp where it is in-flight inferences) |
| `model_load_seconds` | histogram | `service, model` | one observation per load THIS agent performed (python buckets 0.5 … 300 s); boot-plan / JIT loads are not observed |
| `model_evictions_total` | counter | `service, reason` | instances unloaded through `/internal/residency/unload`, `reason` `admin` (default) or `policy` |

`model` is the report's `model_ref` (the instance identifier). The gauges are rebuilt from a fresh
report at every scrape — the same bounded daemon reads `GET /internal/residency` makes, no extra
call — so an instance the daemon dropped on its own TTL leaves the panel at the next scrape. A
daemon that does not answer leaves the per-model gauges empty and the scrape still 200. The
counter and the histogram live in the agent process and restart at zero with it (`rate()` /
`increase()` handle that).

#### Timeouts: the agent answers before the gateway gives up (R1-F5)

`LMS_AGENT_LOAD_TIMEOUT_SECONDS` (default **600**) bounds the daemon's `loadModel` channel for one
load. The gateway's timeout for one agent load is **≥ 900 s** (`GATEWAY_AGENT_LOAD_TIMEOUT_SECONDS`
in `agent/server.mjs` mirrors the floor). The agent's ceiling must stay **strictly below** the
gateway's, with margin for what surrounds the channel — the settled nvidia-smi reads before and
after (up to 15 s each) and the read-back — so a slow load ends as a clean 500 `LOAD_FAILED` from
the agent, never as a gateway abort while the daemon is still loading (a model that then lands
unreported). Raising one means raising the other; the agent warns
`agent.load_timeout_not_below_gateway` at startup if it is configured at or above 900 s.

#### Agent state is memory-only (R2-F11)

`admin_pinned`, a policy `ttl_seconds` and the `measured` per-card bytes live in the agent
PROCESS. An agent restart (the supervisor's, or the pod's) forgets them: pins read
`admin_pinned: false`, instances the agent had measured fall back to `bytes_source: estimated`.
That is by design — the **gateway is the source of truth** and re-asserts its pins/TTLs on the
agent (policy PUT) when it next reconciles; the agent never persists them. The daemon's own TTL is
unaffected (it was fixed at load).

#### GPU numbering (E13)

nvidia-smi, DCGM and the agent's `cuda:<n>` use **NVML order = PCI bus order**. llama.cpp — and
therefore LM Studio's `gpuSplitConfig` `priority` / `disabledGpus` indices — numbers cards with
the **CUDA runtime**, whose default order is `CUDA_DEVICE_ORDER=FASTEST_FIRST`. On two identical
RTX 2000 Ada cards "fastest first" is a tie that CUDA does not promise to break in PCI order, so
the boot plan's "GPU 1" was not guaranteed to be DCGM's `gpu1` — consistent with the observed
"plan says GPU 1, DCGM shows the memory on GPU 0". `entrypoint.sh` now exports
`CUDA_DEVICE_ORDER=PCI_BUS_ID` **before `lms daemon up`**, so the daemon and the engine it spawns
inherit it and all three vocabularies name the same card. Not verifiable from the repo — llmster
is a closed binary — so two checks are built in: the agent logs `agent.gpus` (the nvidia-smi card
list and the order in force) at startup and warns if the order is not `PCI_BUS_ID`, and after
every single-card load it warns `residency.device_order_mismatch` when the measured growth lands
on another card. On the pod: `cat /proc/$(pgrep -f llmster | head -1)/environ | tr '\0' '\n' |
grep CUDA_DEVICE_ORDER` confirms the daemon inherited it.

### Measured facts about the vendor CLI (`llmster` 0.0.23-1)

Observed by running the vendor's own binary in a container. Several correct claims a prior
investigation ticket got wrong, and are the reason the entrypoint is written the way it is:

| Fact | Detail |
|---|---|
| `lms` exits 0 regardless of truth | `lms server status`, `lms daemon status`, and even `lms runtime select <cuda>` on a GPU-less machine all exit 0. **Every gate must match output text, never `$?`.** |
| The bundle ships BOTH engines, CPU selected by default | A fresh container's default selection is the CPU engine even in a CUDA bundle. Shipping the right bundle is necessary but not sufficient — an explicit `lms runtime select` is required |
| GPU presence is only readable via `lms runtime survey --json` | `gpuSurveyResult.result.code: "noDevicesFound"` / `memoryInfo.vramCapacity: 0` on a GPU-less host |
| Directory-based model discovery works, there is no rescan verb | A GGUF dropped under `<models>/<publisher>/<model>/x.gguf` is indexed within seconds while the daemon runs; there is no rescan API because the daemon watches the directory (bug #844 keeps `lms import` as the entrypoint's repair path) |
| `lms import` needs `-L`/`-c`/`-l`, or it crashes | Without one of these flags the CLI opens a TTY prompt and dies (`BadResource: ENOTTY`) in a container. `-L` (hard link) requires staging and the models tree on the same filesystem |
| The model key comes from the `--user-repo` directory, not the filename | The `<model>` segment must equal the seed row's `sourceUri`, since that value rides the wire as the OpenAI `model` field. Embedding models additionally get a `text-embedding-` prefix from LM Studio itself |
| Server port has no default; `--port`/`--bind` are mandatory | Omitting `--port` does not fall back to 1234 — a fresh container has no "last time it was started" to fall back to |
| Every unknown HTTP path returns 200 | `/health`, `/metrics`, and any bogus path all answer `200 {"error":"Unexpected endpoint..."}` — no k8s `httpGet` probe can ever fail here, so every probe must be an `exec` that greps the response body |
| Readiness cannot use `/v1/models` | With JIT on there is no way to turn it off via the CLI, and `/v1/models` lists every model on disk regardless of load state. The working readiness signal is `GET /api/v1/models` -> `loaded_instances[]` |
| `$HOME` is respected as non-root | Not reproduced: bug #2093's claim that `llmster` hardcodes `/root/.lmstudio` did not hold under uid 10001 with `HOME=/home/llmster` |

These measurements were taken on the `linux-arm64` bundle in locally-built containers, before the
CI-only directive took effect; they are retained because they are facts about the vendor's CLI and
server, not about this repo's build. The production artifact is `linux-x64` +
`full+cuda12` on a different base — CI's `verify-lmstudio-runtime` job is what confirms the
production bundle behaves the same way.

## Gotchas

- **Never pipe the LM Studio installer** (`curl | bash`) to build this image — see How it works.
- **`lms server status` exiting 0 does not mean the daemon is ready.** Wait on `lms daemon status`
  printing `is running`, never on exit code.
- **A k8s `httpGet` probe can never fail against this server** — every probe in the deployment
  manifest must be an `exec` that greps the response body, not a status-code check.
- **`lms import` without `-L`/`-c`/`-l` crashes in a container** rather than silently failing —
  one of those flags is mandatory, and `-L` (hard link) requires staging and the models directory
  to share a filesystem.
- **Do not put `lms load` back in A-6.** It cannot set flash attention, KV-cache quantization or
  GPU placement, and neither can the REST load endpoint — see A-6 loads over the SDK websocket.
- **Do not import `@lmstudio/sdk` from a bundled plugin's `node_modules`**, and do not run the
  loader on `~/.lmstudio/.internal/utils/node`. Both are internals of a proprietary bundle.
- **Do not point the gateway's residency control back at LM Studio REST** (`/api/v1/models/load`).
  It cannot apply the serving profile; the agent on :8869 is the control path.
- **The agent's tests:** `node --test 'agent/*.test.mjs' loader/kvconfig.test.mjs
  loader/sdk-channel.test.mjs` from this directory (Node 24 treats a bare `agent/` as a module
  path, so pass the glob). `agent/contract.test.mjs` pins the in-tree copies in `fixtures.mjs` to
  `tests/contracts/model-residency-task1055.fixture.json`, and skips inside the image where that
  file is not in the build context.
- **A directory name for an embedding model must not already carry the `text-embedding-` prefix**
  — LM Studio prepends it itself, so a pre-prefixed directory doubles it.
- Deployment manifests for this image, and the fuller investigation ticket, are tracked outside
  this repository's active documentation (the originating ticket has since moved to the
  historical archive).

## Related

- [../README.md](../README.md) — the Docker Compose directory this image's build lives beside
- [../../../docs/operations/inference/README.md](../../../docs/operations/inference/README.md) — production inference engines runbook
- [../../../.claude/rules/09-infrastructure-devops.md](../../../.claude/rules/09-infrastructure-devops.md) — cluster GPU capacity and time-slicing
