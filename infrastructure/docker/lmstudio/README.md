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
| `entrypoint.sh` | The boot contract: seven ordered assertions (A-0, A-1, A-2, A-3, A-5, A-6, A-7 — there is no A-4), each fail-closed with exit 78 |
| `loader/` | The A-6 preloader. `kvconfig.mjs` (pure: env -> kvConfig) + `kvconfig.test.mjs`, `load.mjs` (websocket I/O + read-back), and a lockfile-pinned `@lmstudio/sdk`. Replaces `lms load`, which cannot reach flash attention, KV-cache quantization or GPU placement |
| `.dockerignore` | Deny-all allow-list: only `Dockerfile`, `entrypoint.sh` and `loader/` (minus any local `node_modules`) reach the build context |

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
- **A directory name for an embedding model must not already carry the `text-embedding-` prefix**
  — LM Studio prepends it itself, so a pre-prefixed directory doubles it.
- Deployment manifests for this image, and the fuller investigation ticket, are tracked outside
  this repository's active documentation (the originating ticket has since moved to the
  historical archive).

## Related

- [../README.md](../README.md) — the Docker Compose directory this image's build lives beside
- [../../../docs/operations/inference/README.md](../../../docs/operations/inference/README.md) — production inference engines runbook
- [../../../.claude/rules/09-infrastructure-devops.md](../../../.claude/rules/09-infrastructure-devops.md) — cluster GPU capacity and time-slicing
