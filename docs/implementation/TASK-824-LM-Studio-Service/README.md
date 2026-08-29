# TASK-824 — LM Studio headless as a containerized service

| | |
|---|---|
| **Status** | Pending |
| **Type** | infrastructure |
| **Branch** | `dev-2.2` |
| **Depends on** | MinIO model-artifact bucket (this ticket creates it) |
| **Feeds** | TASK-818 (router) — LM Studio is provider priority #2 |
| **Related** | TASK-823 (vLLM, priority #1), TASK-822 (MLflow) |

## 1. Requirement Analysis

Deploy **LM Studio as a containerized service** serving the OpenAI-compatible API to `apps/text`, with GGUF model weights **fetched from and published to MinIO/S3**. Priority #2 backend, behind vLLM.

**Owner decision (2026-08-29):** build **our own headless GPU image from `llmster`**, LM Studio's server-native core (shipped in 0.4.0, 2026-01-28). This supersedes the earlier direction toward `linuxserver/docker-lm-studio`, and it is the better call for a serving role — see §2.

**Licensing note, recorded once and not re-argued:** the LM Studio App ToS (effective 2026-08-23) grants use "solely for Your personal and / or internal business purposes" and restricts "service bureau use, as an application service provider, or a software-as-a-service." The owner has directed that LM Studio be deployed in the serving path. This is an **accepted risk under explicit owner direction**. Practical consequence for this ticket: **the image we build is private — push to the internal registry only, never a public one**, since it embeds a proprietary binary we have no redistribution right to.

**What exists today:** nothing containerized. `apps/text` reaches LM Studio purely via `openai_compat.py` against a `baseUrl` — `_LM_STUDIO_PROVIDER_NAMES = {"lm-studio", "openai_compat"}` (`apps/text/src/text/providers/openai_compat.py:35`). **A containerized LM Studio therefore needs no router code at all — only an `AiProviderConnection` row.** The nearest existing precedent is the `llama-cpp` service in the dev compose `inference` profile (`infrastructure/docker/docker-compose.dev.yml:509-533`), which reads a **pre-staged GGUF from a host bind-mount** at `${LLAMA_CPP_MODELS_DIR:-./models/llama-cpp}:/models:ro` — the same shape this ticket replaces with a MinIO-sourced volume.

## 2. Why our own image, not `linuxserver/docker-lm-studio`

The linuxserver image is a **GUI desktop container**, not a server: it runs the LM Studio GUI over a Selkies/KasmVNC web desktop on ports **3000 (HTTP, "must be proxied") / 3001 (HTTPS)**. Port 1234 — the OpenAI-compatible API — is not in its documented port list. Its own documentation states:

> "This container provides privileged access to the host system. Do not expose it to the Internet unless you have secured it properly."
>
> "The web interface includes a terminal with passwordless `sudo` access. Any user with access can gain root control."

It also requires NVIDIA driver **580+** *and* host bootloader kernel parameters (`nvidia-drm.modeset=1 nvidia_drm.fbdev=1`), plus `--device /dev/nvidia-modeset --runtime nvidia --gpus all` and `AUTO_GPU=true`; it is **x86-64 only**; and it exposes a single `/config` volume as the container's home.

A purpose-built `llmster` image removes all of it: no desktop, no VNC, no root-shell web terminal, no host-privilege requirement, a far smaller attack surface and image, and a real process to health-check. The official `lmstudio/llmster-preview` image proves the headless shape is supported — it is only unusable here because it is **CPU-only on x86**, which is precisely the gap our image closes.

*(If the custom image proves troublesome, the fallback is `ghcr.io/ggml-org/llama.cpp:server-cuda` — same llama.cpp engine underneath, MIT-licensed, official GPU images, `GET /health` returns **503 while the model is still loading** which is the ideal readiness gate, plus `/metrics` and `/slots`. It is already in the compose inference profile. Keep it as the documented escape hatch, not the plan of record.)*

## 3. The MinIO model-artifact plane

This is new: **no bucket holds model weights today.** vLLM pulls from HuggingFace Hub into a `vllm-cache` volume; llama.cpp reads a host bind-mount; the `mlflow` bucket created at `infrastructure/docker/docker-compose.yml:145` is empty and orphaned.

### 3.1 Layout

```
s3://hope-models/<publisher>/<model>/<quant>/model.gguf
s3://hope-models/<publisher>/<model>/<quant>/manifest.json   # sha256 per object, bytes, n_ctx hint, engine min-version
s3://hope-models/<publisher>/<model>/<quant>/SHA256SUMS
```

The `<publisher>/<model>/` two-level shape is **not cosmetic** — LM Studio resolves models from a directory tree of exactly that form and the directory names populate its catalogue. A flat dump will not be seen. Extend the **existing** MinIO init entrypoint (`docker-compose.yml:144-152`) with `mc mb minio/hope-models --ignore-existing` and a scoped policy; do not add a second init container.

### 3.1b Two sources: HuggingFace is native, MLflow is not

Per TASK-822 §5B the platform uses both registries, and LM Studio treats them very differently:

- **HuggingFace — native.** `POST /api/v1/models/download` accepts a catalog id **or a full HF URL**
  with a `quantization` parameter, and `lms get <hf-repo>` does the same from the CLI. No sync job,
  no `lms import`, no PVC layout to reproduce. This is by far the simplest path.
- **MLflow — no awareness at all.** Resolve the alias to a concrete artifact, sync it to the volume,
  then **`lms import`** (§4.10). This is the path §3.3 describes.

**But the HF path egresses to `huggingface.co` from a PHI namespace**, which contradicts §5 L-3's
default-deny policy. TASK-822 §5B.3's recommendation applies here too: mirror HF GGUFs into
`hope-models` once and treat them as an `S3` source, so the serving pod never reaches the internet
and the artifact is checksum-pinned. Choose deliberately and record the choice.

### 3.2 Prefer single-file GGUF

If a model must be sharded, the server must be pointed at **shard 1** (`model-00001-of-000NN.gguf`); pointing at any other yields `illegal split file idx`. **A partial sync that lands shard 2 first is a silent failure mode** — which is why the manifest records shard 1's key explicitly and the sync verifies checksums before flipping the ready sentinel. `gguf-split` splits at tensor boundaries, so shards are individually valid objects and are safe to store as separate MinIO objects with per-object checksums.

### 3.3 Sync mechanics

**Warm a PVC with a one-shot Job, not a per-pod init container.** Serving pods mount it `ReadOnlyMany`; nothing re-pulls per pod.

1. Job runs `s5cmd cp` (or `mc`) MinIO → a **staging path** on the PVC.
2. Verify sha256 against `manifest.json`, **and** run `gguf-dump.py --no-tensors --json` to assert
   `general.file_type` and `<arch>.context_length` match the manifest. GGUF self-describes, so this
   costs nothing and catches a swapped quantization — which in a clinical setting is a
   patient-safety issue, not config drift.
3. **`lms import <file> --user-repo <publisher>/<model> -y -L` inside the container** — do not just
   drop the file into place. See §4.10: **there is no rescan API or CLI**, and `lms import` **moves**
   the file by default, so `-L` (hard-link) or `-c` (copy) is mandatory.
4. Confirm with `lms ls`, then write a `.ready` sentinel. Serving pods gate on it.

Tool choice: **s5cmd or `mc`, not rclone** — s5cmd is the fastest general option (vendor claims 4.3 GB/s; independent tests report ~1.6 GB/s at 80 workers — treat vendor figures as ceilings), `mc` is reported ~33% faster than rclone on *single large* uploads, and rclone's advantage is many-file syncs, which this is not.

**Cold start is storage-bandwidth-bound, not CPU-bound**: NVMe 3–4 GB/s vs network-attached 400–600 MB/s; models taking 4–6 min from cloud NFS load in ~40s at 3.5 GB/s. **Do not bake weights into the image** — an 8B image pull + extract measures ~11 min.

## 4. Image build

### 4.1 The trap that decides everything

**`curl -fsSL https://lmstudio.ai/install.sh | bash` selects the CUDA bundle by probing the BUILD
host.** The script (fetched 2026-08-29) computes its release name as
`${APP_VERSION}-linux-x64.full${SUFFIX}` where `SUFFIX="+cuda12"` **only if `nvidia-smi` reports
driver ≥ 550.54.14**, and empty otherwise.

**Consequence: building on a GPU-less CI runner silently produces a CPU-only image.** It will
start, serve, and answer requests — on CPU, at a fraction of the throughput — with no error.
This is the highest-probability failure in this ticket.

**Therefore: never pipe the installer in the Dockerfile.** Download the pinned `+cuda12` tarball
by URL, verify its SHA-512, extract, and run the extracted `llmster bootstrap` — which is exactly
what `install.sh` does after extraction. This also buys reproducibility and checksum integrity.

Verified 2026-08-29 (both return HTTP 200, `application/octet-stream`):
- `https://llmster.lmstudio.ai/download/0.0.23-1-linux-x64.full+cuda12.tar.gz`
- `…full+cuda12.tar.gz.sha512` → `145d84440b8797614edb39b1019085c90fbc215ccf2d73e74bce645a15513b092997c604e3a4ab86092e40b28601eaf85b627393169345f2a0c2a3df8f464367`

`0.0.23-1` is the installer/bundle version; the daemon reports its own. **Mirror the tarball into
our own artifact store** — there is no guarantee that version stays fetchable.

Unattended flags verified in the script: `--quiet|-q`, `--verbose|-v`, `--no-modify-path`; env
equivalents `LMS_PRINT_QUIET`, `LMS_PRINT_VERBOSE`, `LMS_NO_MODIFY_PATH`. **There is no version
env var** — the version is a literal in the script, which is the other reason to fetch by URL.

Runtime deps the installer checks for: `libatomic1`, `libgomp1`. Documented driver floor:
**550.54.14** (CUDA 12.4).

### 4.2 `lms daemon up` forks and exits — the image needs a wrapper

There is **no foreground/no-detach flag** on `lms daemon up` (verified in the `lms` source); it
starts a detached daemon, prints a PID and returns. Nothing in `lms` blocks by design. So the
container needs an entrypoint script plus a blocking hold — `exec lms log stream` is the only
long-running foreground command, and it doubles as container log output.

Startup order: `lms daemon up` → poll `lms server status` until the control socket answers →
optionally `lms runtime select` → `lms server start --bind 0.0.0.0 --port 1234` → optional
`lms load` → hold.

**`--bind` is mandatory. The default is `127.0.0.1`,** which makes the k8s Service and any
published port silently dead. Precedence: CLI flag > `LMS_SERVER_HOST` > persisted
`http-server-config.json` > default.

**Do not call `lms bootstrap` at runtime** — it is an interactive PATH helper and has been
reported to spin at 99% CPU forever waiting on a TTY that never arrives. Bake `PATH` instead.

### 4.3 Health and readiness

**There is an undocumented but source-verified health endpoint**: `GET /lmstudio-greeting`
returns 200 with `{"lmstudio": true}`. It is what `lms` itself probes.

It proves **server up**, not **model loaded**. For readiness: **turn JIT loading off**, preload
in the entrypoint, and gate on `GET /v1/models` returning the expected key — with JIT off it
lists only in-memory models. **With JIT on, `/v1/models` lists everything on disk and is
useless as a readiness signal.** Alternative: `exec: lms ps`.

*(Contrast with llama.cpp's `llama-server`, whose `GET /health` returns 503 while loading and
200 when ready — a single endpoint that answers both questions. Noted in §2 as the escape hatch.)*

### 4.4 Models directory

Default `~/.lmstudio/models`, layout `models/<publisher>/<repo>/<file>.gguf`.

**There is no env var to change it.** `resolveModelsFolderPath()` reads
`<lmstudio-home>/settings.json` → field **`downloadsFolder`**, falling back to the default if
absent or unparseable. The LM Studio home itself is relocatable via a `$HOME/.lmstudio-home-pointer`
file whose contents are the home path.

**Use a symlink** — `~/.lmstudio/models` → `/data/models` — as the primary mechanism; it is the
safer of the two, since whether `settings.json{downloadsFolder}` is honoured *before first daemon
start* is unverified.

**`~/.lmstudio/.internal/` must stay in the image, never on a volume.** It holds
`llmster-install-location.json`, without which `lms daemon up` fails with "no valid installation
could be found" — and the daemon's unix socket breaks on NFS/SMB volumes.

### 4.5 Concurrency knobs — a real split

- **`lms load --parallel <n>`** sets Max Concurrent Predictions headlessly. **Source-verified but
  absent from the published docs.** Default 4; llama.cpp engine only (MLX "coming soon").
- Context length: `lms load -c <n>` **or** `POST /api/v1/models/load {context_length}`.
- KV-cache/batching knobs — `eval_batch_size`, `flash_attention`, `offload_kv_cache_to_gpu` —
  are **REST-only** (`POST /api/v1/models/load`), not `lms load` flags.
- **`POST /api/v1/models/load` accepts only six fields** — `model`, `context_length`,
  `eval_batch_size`, `flash_attention`, `num_experts`, `offload_kv_cache_to_gpu` (+ `echo_load_config`).
  **`gpu`, `ttl`, `parallel` and `identifier` are NOT in the REST body at all** — they are CLI/SDK
  only. The asymmetry is sharp: `parallel` is *readable* over HTTP
  (`loaded_instances[].config.parallel`) but not *writable*.
- Consequence: the entrypoint must use `lms load --gpu --parallel --ttl --identifier` for the
  fields that matter operationally, and REST `/models/load` only when the KV-cache knobs are needed.
  Plan for both, not one.

### 4.6 Dockerfile

```dockerfile
# CUDA 12.x runtime base. The +cuda12 bundle ships its own llama.cpp CUDA libs, so a
# plain ubuntu:24.04 + toolkit MAY suffice — UNVERIFIED. Start with the CUDA base.
FROM nvidia/cuda:12.8.1-runtime-ubuntu24.04

ARG LLMSTER_VERSION=0.0.23-1
ARG LLMSTER_ARTIFACT=${LLMSTER_VERSION}-linux-x64.full+cuda12.tar.gz
# VERIFIED 2026-08-29 against llmster.lmstudio.ai/download/<artifact>.sha512
ARG LLMSTER_SHA512=145d84440b8797614edb39b1019085c90fbc215ccf2d73e74bce645a15513b092997c604e3a4ab86092e40b28601eaf85b627393169345f2a0c2a3df8f464367

ENV DEBIAN_FRONTEND=noninteractive
# libatomic1 + libgomp1 are checked for by the upstream installer.
# tini for PID-1 signal handling and zombie reaping.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl libatomic1 libgomp1 tini \
 && rm -rf /var/lib/apt/lists/*

# Fixed-UID non-root user with a REAL home. See bug #2093 (open, 2026-06-25):
# llmster has been reported to hardcode /root/.lmstudio and ignore $HOME in
# containers. TEST NON-ROOT FIRST; fall back to root only with a recorded reason.
RUN useradd -u 10001 -m -d /home/llmster -s /usr/sbin/nologin llmster
USER llmster
ENV HOME=/home/llmster \
    PATH=/home/llmster/.lmstudio/bin:/usr/local/bin:/usr/bin:/bin

# Pinned + checksummed. Deliberately NOT `curl install.sh | bash` — see §4.1.
RUN set -eu; cd /tmp; \
    curl -fsSL -o llmster.tar.gz \
      "https://llmster.lmstudio.ai/download/${LLMSTER_ARTIFACT}"; \
    echo "${LLMSTER_SHA512}  llmster.tar.gz" | sha512sum -c -; \
    mkdir -p x && tar xf llmster.tar.gz -C x; \
    LMS_BOOTSTRAP_INSTALL_SH=1 LMS_NO_MODIFY_PATH=1 ./x/llmster bootstrap; \
    rm -rf /tmp/llmster.tar.gz /tmp/x; \
    lms --version

# Weights on a mounted volume; ~/.lmstudio (especially .internal/) stays in the image.
RUN rm -rf /home/llmster/.lmstudio/models \
 && ln -s /data/models /home/llmster/.lmstudio/models

ENV LMS_PORT=1234 LMS_SERVER_HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 1234
COPY --chown=llmster:llmster entrypoint.sh /usr/local/bin/entrypoint.sh
# Undocumented but source-verified liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${LMS_PORT}/lmstudio-greeting" | grep -q '"lmstudio":true' || exit 1
ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/entrypoint.sh"]
```

**Single-stage on purpose.** Multi-stage buys little here: `llmster bootstrap` writes
`~/.lmstudio/.internal/llmster-install-location.json` with **absolute paths**, so copying the tree
between stages requires an identical `$HOME` in both.

### 4.7 Entrypoint

```bash
#!/usr/bin/env bash
set -euo pipefail
PORT="${LMS_PORT:-1234}"; BIND="${LMS_SERVER_HOST:-0.0.0.0}"
trap 'lms server stop >/dev/null 2>&1 || true; lms daemon down >/dev/null 2>&1 || true' TERM INT

mkdir -p /data/models            # dangling symlink otherwise -> writes fail

# 1. Daemon owns the engine. `lms daemon up` FORKS AND EXITS (no --foreground flag
#    exists) — which is the entire reason this wrapper script is needed. Idempotent.
lms daemon up

# 2. Wait for the control socket before any other lms command.
for _ in $(seq 1 60); do lms server status >/dev/null 2>&1 && break; sleep 1; done

# 3. Pin the CUDA llama.cpp runtime BEFORE loading a model.
[ -n "${LMS_RUNTIME:-}" ] && lms runtime select "${LMS_RUNTIME}" --latest || true

# 4. HTTP layer. --bind is mandatory: default 127.0.0.1 makes the Service silently dead.
lms server start --port "${PORT}" --bind "${BIND}"

# 5. Preload AFTER the server, so /lmstudio-greeting goes healthy early and the
#    readiness gate is what waits on the weights. --parallel is the headless
#    Max Concurrent Predictions knob (default 4).
if [ -n "${LMS_LOAD:-}" ]; then
  lms load "${LMS_LOAD}" -y \
    --gpu "${LMS_GPU:-max}" \
    ${LMS_CONTEXT:+--context-length "${LMS_CONTEXT}"} \
    ${LMS_PARALLEL:+--parallel "${LMS_PARALLEL}"} \
    ${LMS_IDENTIFIER:+--identifier "${LMS_IDENTIFIER}"}
fi

# 6. Hold PID 1.
exec lms log stream
```

### 4.8 Community reference

[`LucaTheHacker/LMStudio-Container`](https://github.com/LucaTheHacker/LMStudio-Container) is sound
on: tini as PID 1, the `libatomic1`/`libgomp1` deps, keeping `.internal` in-image, symlinking
models to `/data`, `LMS_SERVER_HOST=0.0.0.0`, `exec lms log stream` as the hold, and explicitly
not calling `lms bootstrap` at runtime. **Weak on**: runs as root, uses `curl | sh` at build time
(so CPU-only on a GPU-less builder — §4.1), and healthchecks `/v1/models`, which is meaningless
under JIT (§4.3). Copy the good parts; fix those three.

### 4.9 UNVERIFIED — prove these before building on them

Ranked by risk. **Item 1 is a design dependency, not a detail.**

1. ~~Whether a GGUF dropped on disk is picked up automatically.~~ **ANSWERED — see §4.10. It is
   not safe to assume. The sync design changed accordingly.**
2. Whether `settings.json{downloadsFolder}` is honoured when written before first daemon start.
3. **Whether llmster resolves `$HOME` correctly as non-root in Docker** — bug #2093 is open,
   reported under Apptainer, no published workaround. Also whether `.lmstudio-home-pointer`
   overrides it.
4. Whether the `+cuda12` bundle runs on plain `ubuntu:24.04`, and which CUDA minor it links.
5. Whether `--gpus all` alone suffices or `NVIDIA_DRIVER_CAPABILITIES=compute,utility` / extra
   device nodes are needed.
6. The exact `lms runtime ls` alias for the CUDA llama.cpp pack (`llama.cpp:cuda` is the
   documented *query* syntax, not necessarily the select alias).
7. Any headless path to mint an API token / enable "Require Authentication" (docs describe GUI
   only) — **this is why §5 L-1 network isolation is load-bearing, not defence in depth.**
8. Setting `--parallel` and the REST-only load knobs in one operation (§4.5).
9. First-run EULA/telemetry prompt or machine-id check under `llmster bootstrap` **with egress
   blocked** — verify an offline cold start before committing.
10. Graceful drain of in-flight generations on SIGTERM.
11. Final image size (the official CPU preview is ~370 MB; CUDA base + bundle will be far larger).
12. Whether `0.0.23-1` stays fetchable — mirror it.

### 4.10 There is no rescan — the sync must import, not drop

**Definitive negative, established three independent ways:**

1. **CLI**: the complete subcommand tree in `lms/src/subcommands/` is `bootstrap, chat, clone,
   create, get, importCmd, list, load, loadSpeculativeDecoding, log, login, logout, push, server,
   status, unload, version, whoami` plus `daemon/*`, `runtime/*`, `link/*`, `dev/*`. There is no
   `rescan`, `reindex`, `refresh`, `scan` — or `rm`.
2. **The app's own internal RPC surface** (`lms-external-backend-interfaces/src/`): `systemBackendInterface`
   exposes `listDownloadedModels`, `listDownloadedModelVariants`, `info`, `version`,
   `startHttpServer`, `stopHttpServer`, `requestShutdown` — **no rescan**. Tellingly, a
   `reindexPlugins` RPC *does* exist (`pluginsBackendInterface.ts:201`): LM Studio ships
   reindexing for plugins and deliberately not for models.
3. **Docs**: no rescan or refresh concept anywhere.

Whether the closed-source indexer watches the directory is **unverified and the evidence is
discouraging** — bug-tracker **#844, "Downloaded models are missing until the application is
restarted", is open**, with #834 and #1019 reporting the same class of failure.

**Therefore the sync design in §3.3 changes.** Do not drop files and hope:

| | Design |
|---|---|
| **Preferred** | Sync to a **staging path** on the volume, then run `lms import <file> --user-repo <publisher>/<model> -y -L` **inside the container**. This registers the model through LM Studio's own code path instead of relying on discovery. **Pass `-L` (hard-link) or `-c` (copy) — `lms import` MOVES the file by default**, which would silently empty your staging area. |
| **Alternative** | For weights available in the catalog or on HF, skip the volume entirely and use `POST /api/v1/models/download`. |
| **Fallback** | Restarting the pod re-indexes. Treat as a real but out-of-scope escape hatch, not the design. |

Layout remains mandatory: `<models-dir>/<publisher>/<model>/<file>.gguf`. **A GGUF at the models
root is not discovered** — a filed defect (`lmstudio-js` #387).

### 4.11 A generic path probe cannot detect liveness

**LM Studio returns HTTP 200 for unknown paths** (bug-tracker #1323). A probe on an arbitrary path
therefore always passes, including against a broken server. `/lmstudio-greeting` must be checked
for **both** `status === 200` **and** `json.lmstudio === true` — which is exactly what `lms` itself
does (`createClient.ts:21`, and `LMStudioClient.ts:214` for port discovery). The §4.6 healthcheck
already greps for `"lmstudio":true`; do not "simplify" it to a status-code check.

## 5. Kubernetes and security posture

| # | Control | Detail |
|---|---|---|
| L-1 | **NetworkPolicy: ingress on the API port from `apps/text` and the gateway only** | **This is the ONLY enforcement point, not defence in depth.** LM Studio auth is off by default and **there is no headless way to mint a token** — grepping `lms/src` for `apiToken\|requireAuth\|createToken\|bearer` returns zero hits, and `lms` issue #489 confirms it. `LM_API_TOKEN` is consumption-side only. The alternative — minting a token on a GUI machine and baking the config dir into the image — creates an unrotatable, GUI-minted secret; for a healthcare platform, running unauthenticated on a pod-internal bind with a strict NetworkPolicy is the more honest posture. Note the docs flag any bind other than `127.0.0.1` as requiring auth. |
| L-2 | **Private registry only** | The image embeds a proprietary binary; no redistribution right (§1). |
| L-3 | Block telemetry egress | Egress allow-list: DNS, MinIO. A PHI environment must not phone home. Verify no first-run analytics call. |
| L-4 | Readiness gates on **model loaded**, not process up | JIT off + preload + `GET /v1/models`; liveness on `/lmstudio-greeting` checking `{"lmstudio":true}` (§4.11 — a path probe alone always passes). |
| L-5 | `terminationGracePeriodSeconds` ≫ longest generation; `preStop` sleep so the Service drops the endpoint first | Same discipline as vLLM (TASK-823 §8). |
| L-6 | Memory request ≥ model bytes + KV (`n_parallel × n_ctx`) | Plus a `startupProbe` with a generous `failureThreshold` covering model load. |
| L-7 | Non-root where the runtime permits | Verify what breaks; document if it cannot be non-root. |

## 6. Throughput expectations — set them honestly

LM Studio 0.4.0 added **continuous batching** for parallel requests to the same model, but `n_parallel` ("Max Concurrent Predictions") **defaults to 4**, it requires the llama.cpp runtime (MLX "coming soon"), and the ceiling is llama.cpp's, not LM Studio's. Raising `--parallel` without raising batch size *"just spreads the same throughput across more queues; latency goes up, aggregate tokens per second does not."*

Comparative 2026 benchmarks consistently put **vLLM 7–12× ahead above ~8 concurrent users** (≈10× aggregate throughput at 32 concurrent requests). Treat magnitudes, not exact figures, as reliable.

**Therefore: one LM Studio instance sustains single-digit-to-low-teens concurrent generations before p95 degrades.** Against the platform's 20–40 in-flight target, LM Studio is a **secondary/eval tier behind vLLM**, exactly as the priority order already states. Size expectations and the routing policy accordingly — do not let it become the primary candidate for clinical traffic under a `LEAST_BUSY` strategy.

---

## 7. Admin console — LM Studio server + model management

### 7.1 Two assumptions corrected by the codebase

**(a) "Is the server up" already exists in substance.** `/ai-models` ships a `DiscoveryDrawer`
(`apps/admin-console/src/features/ai-models/components/discovery-drawer.tsx`) driven by
`useModelDiscovery(provider, enabled=open)` — probes are **lazy** (`enabled: open`, never on page
load), `staleTime: 30_000`, `retry: false`. It renders a "Server probes" section per provider with
reachable/timeout/error plus latency, and a model list tagged
`registered | discovered | registered-missing-on-server`.

The chain already runs end to end: `GET /admin/ai-models/discovery?provider=`
(`apps/api/src/modules/ai-model/ai-model-discovery.controller.ts:38`) → `AiModelDiscoveryService.discover()`
(`ai-model-discovery.service.ts:155-211`) resolves connections **tenant → SYSTEM** and POSTs
`{connections}` to TEXT's `POST /api/v1/providers/probe` (`probeText`, `:334-362`, 15s timeout,
`X-Service-Token`) → `apps/text/src/text/api/endpoints/providers.py:142` fans out with a
**per-provider 5s cap** so one hung engine never 500s the listing, degrading to
`_unavailable(name)` with `probe_status` / `probe_latency_ms` / `probe_error`.

`SERVER_MANAGED_PROVIDERS = DISCOVERABLE_AI_MODEL_PROVIDERS = ['ollama','lm-studio','vllm','llama-cpp']`
— **LM Studio is already in it.** And `openai_compat.py:371` already enriches LM Studio listings
via its **native `/api/v0/models`** API, returning `state`, `quantization` and `max_context_length`
per model (best-effort, 3s timeout, any failure → `{}`).

**So availability/up-status is an EXTENSION of a working feature, not new construction.**

**(b) MinIO management in the console already exists too.** `apps/admin-console/src/features/storage-browser/`
(object browser) and `features/storage/` (bucket configs, access keys) are live at `/tenants/storage`.
The established pattern is **proxy multipart upload through the BFF**, not browser-direct presigned
PUT: `uploadFile()` builds `FormData` and POSTs through the same catch-all proxy, and the gateway
reads it with `FileInterceptor('file')` + `ParseFilePipe`/`MaxFileSizeValidator`/`FileTypeValidator`
(`apps/api/src/modules/storage/storage.controller.ts`). Download is a **presigned GET**
(`PRESIGNED_GET_EXPIRY_SECONDS = 3600`), never raw bytes through the proxy.

**Reuse that shape verbatim.** Do not invent a browser-direct presigned-PUT flow for model
artifacts.

### 7.2 What to build

A new screen at **`/ai-services/lm-studio`** (domain `ai-platform`, tier `10-19`,
`required: [['manage','all']]`), composed as `ScreenTemplate` with `contentMode="fill"`:

| Region | Content |
|---|---|
| `header` | Title + actions: "Probe now" (invalidates `aiModelKeys.discovery('lm-studio')`), "Upload model" |
| `stats` | Server status badge (from `probeStatus`), latency, loaded-model count, and the active runtime — **the CPU-fallback tell from §4.1. Backed by an exec of `lms runtime survey --json`, not HTTP; see §8.4.** |
| `statusBanner` | Rendered only when `probeStatus !== 'ok'`, carrying `probe_error` verbatim |
| `tabs` | **Server** (probe detail, base URL, `AiProviderConnection` row state) · **Models on server** (from `/api/v0/models`: id, state, quantization, max_context_length) · **Artifacts in MinIO** (the `hope-models` bucket, reusing the storage-browser components) |
| `children` | `AdminDataGrid` per tab |
| `footer` | `StatusFooter` |

Follow the `ai-models` feature end-to-end as the template: `page.tsx` → `features/lm-studio/components/*`
→ `api/{hooks,client,keys,types}.ts` → BFF → gateway controller. **No zod** — this layer uses
hand-written TS interfaces validated server-side by class-validator DTOs. Detail/edit uses
`DetailDrawer` (`size="lg"`), OCC via `patchWithEtag(path, {...patch, expectedVersion: versionFromEtag(etag)}, etag)`
with `OccConflictAlert` on 412/428.

**Query keys**: `lmStudioKeys.root = ['lm-studio']`, `.status()`, `.models()`, `.artifacts(prefix)`.

## 8. New gateway endpoints

`@Controller('admin/lm-studio')`, `@Authorize(['manage','all'])`, `@ForbidApiKey()`,
`@RequiredSvcScopes('svc:admin:lm-studio:manage')` — mirroring `AiModelAdminController`'s guard trio
exactly. SUPER_ADMIN-only via `manage:all`, not tenant-scoped.

### 8.1 What LM Studio actually exposes

Verified against the docs repo and the `lms` / `lmstudio-js` sources at HEAD (2026-08-29). **Build
on `/api/v1` only** — `/api/v0` is superseded and offers nothing v1 lacks except a
`compatibility_type` label.

| Method | Path | Purpose | Body / notes |
|---|---|---|---|
| `GET` | `/api/v1/models` | **List all on-disk models**; loaded ones carry a non-empty `loaded_instances[]` | No query params. One call answers both "what exists" and "what is loaded" |
| `POST` | `/api/v1/models/load` | Load into memory | `model` (req), `context_length`, `eval_batch_size`, `flash_attention`, `num_experts`, `offload_kv_cache_to_gpu`, `echo_load_config` |
| `POST` | `/api/v1/models/unload` | Evict an instance | `instance_id` |
| `POST` | `/api/v1/models/download` | Start a background download | `model` (catalog id **or** full HF URL), `quantization` (HF links only) |
| `GET` | `/api/v1/models/download/status/:job_id` | Poll a download | Returns `status`, `downloaded_bytes`, `total_size_bytes`, `bytes_per_second`, `estimated_completion`. **Poll only — no stream, and no cancel endpoint exists** |
| `GET` | `/lmstudio-greeting` | Liveness | Undocumented but source-verified. Check status **and** `{"lmstudio":true}` (§4.11) |

Per-model response fields worth surfacing: `key`, `publisher`, `display_name`, `architecture`,
`quantization{name,bits_per_weight}`, `size_bytes`, `params_string`, `max_context_length`, `format`,
`capabilities{vision,trained_for_tool_use,reasoning}`, `variants[]`, and
`loaded_instances[{id, config{context_length, eval_batch_size, parallel, flash_attention, num_experts, offload_kv_cache_to_gpu}}]`.

### 8.2 The gaps, and the escape hatch

Four capabilities a platform admin will expect have **no HTTP API**:

| Capability | Reality |
|---|---|
| `gpu`, `ttl`, `parallel`, `identifier` on load | CLI/SDK only (§4.5) |
| **Import a local GGUF** | **`lms import` CLI only** — and it is the load-bearing step in the sync design (§4.10) |
| **Delete a model from disk** | **Neither API nor CLI.** Filesystem `rm` is the only path |
| **Active runtime / engine** | Not over HTTP at all (§8.4) |

**Recommendation — REST-first with a narrow exec escape hatch, not a second architecture.** The
gateway's primary controller proxies the six `/api/v1` endpoints with existing patterns. The gaps
are closed by `exec`ing `lms` inside the container (`lms import`, `lms runtime ls --json`,
`lms load --gpu/--ttl/--parallel`) behind a small set of separately-guarded super-admin routes.

### 8.3 Why not the SDK

**`@lmstudio/sdk` is not an HTTP client — it speaks WebSocket RPC.** `LMStudioClient.guessBaseUrl()`
returns `ws://127.0.0.1:1234`: same port, different protocol, with `addRpcEndpoint`/`addChannelEndpoint`
multiplexed over it. **A NestJS controller cannot proxy that as REST pass-through** — it would need
a long-lived SDK client held in a Nest provider, translating our REST surface onto RPC, plus
reconnection handling. Reach for it only if streaming load/download progress becomes a requirement
(`loadModel` and `downloadModel` are *channel* endpoints with real progress streams, unlike REST's
poll-only status).

### 8.4 Detecting a silent CPU-only deployment

§4.1's failure mode — a CPU-only image that serves happily — **cannot be detected over HTTP.**
`GET /api/v1/models` reports `format: "gguf"`, which is a *weights format*, not an accelerator. No
`/api/v1/(runtime|engine|system|server)` path exists.

Runtime introspection lives only on the WebSocket RPC channel (`runtimeBackendInterface.ts`:
`listEngines`, `getEngineSelections`, `surveyHardware`, `selectEngine`), surfaced by
`lms runtime ls` and `lms runtime survey` (GPU name, CUDA/Metal/ROCm, VRAM, CPU ISA).

**So the console's runtime indicator is backed by an exec of `lms runtime survey --json`, not an
HTTP call.** A weak HTTP-only proxy signal — `load_time_seconds` from an `echo_load_config` load,
plus observed tokens/sec — is inferential and must not be presented as authoritative.

### 8.5 Gateway proxy routes

| Method + path | Backed by |
|---|---|
| `GET /admin/lm-studio/status` | Discovery path filtered to `provider=lm-studio` (§7.1) + `/lmstudio-greeting` |
| `GET /admin/lm-studio/models` | `GET /api/v1/models` |
| `POST /admin/lm-studio/models/load` | `POST /api/v1/models/load`, or exec `lms load` when `gpu`/`ttl`/`parallel` are set |
| `POST /admin/lm-studio/models/unload` | `POST /api/v1/models/unload` |
| `POST /admin/lm-studio/models/download` | `POST /api/v1/models/download` |
| `GET /admin/lm-studio/models/download/:jobId` | Poll `/api/v1/models/download/status/:job_id` |
| `GET /admin/lm-studio/runtime` | **exec** `lms runtime survey --json` (§8.4) |
| `POST /admin/lm-studio/models/import` | **exec** `lms import … -y -L` (§4.10) |
| `GET/POST/DELETE /admin/lm-studio/artifacts[/:key]` | MinIO via `IS3Service` — the storage-controller pattern verbatim (§7.1b) |

**Object keys containing `/` round-trip correctly** — the BFF re-`encodeURIComponent`s each path
segment (`encodeGatewayPath`, `apps/admin-console/src/server/hope-proxy.ts:50`) precisely for this.

### 8.6 Proxy defensively — there is no stability guarantee

The docs say 0.4.0 "officially released" v1 and recommend it over v0, but state **no versioning
guarantee, no breaking-change policy and no v0 removal date**. Therefore: pin the image by digest;
treat every `/api/v1/models` field as optional in the DTOs (**never `forbidNonWhitelisted` on the
response side**); health-check via `/lmstudio-greeting` + `{"lmstudio":true}`; and contract-test the
six endpoints on every image bump.

### OPEN-824-A — container lifecycle control is a different thing, and I recommend against it

"Managing the LM Studio server" splits into two very different asks:

1. **Availability, model load/unload, artifact management** — §7/§8 above. Safe, and mostly
   extension of shipped patterns.
2. **Start / stop / restart the container itself** — this does **not** exist anywhere in the
   gateway or console today (only passive HTTP probing), and building it means giving `apps/api`
   the ability to mutate Kubernetes workloads.

**Recommendation: do not build (2).** A gateway that can start and stop cluster workloads is a
large new privilege surface in a PHI cluster, and the same outcome is available through Argo CD,
which already owns the deployment and gives you an audit trail for free. Expose *state* in the
console (Deployment ready replicas, last transition) read-only if operators want visibility, and
leave *mutation* to GitOps. If you want (2) anyway, say so and it becomes its own ticket with its
own threat model — not a tab on this screen.

## 9. Tests that must not break

- `apps/admin-console/src/features/ai-models/components/__tests__/{ai-models-screen,discovery-drawer,model-form-sheet}.test.tsx`
- `apps/admin-console/src/features/ai-models/api/__tests__/ai-models-api.test.ts`
- `apps/admin-console/tests/e2e/ai-models.spec.ts` — **includes an axe assertion in both themes**; the new screen needs the equivalent
- `apps/api/src/modules/ai-model/__tests__/{ai-model-admin,ai-model-discovery}.controller.test.ts`
- `apps/api/tests/e2e/ai-model-discovery.spec.ts`
- `apps/api/tests/e2e/task-776-route-authz-matrix.spec.ts` — the new routes join it **automatically** once they appear in a regenerated `route-manifest.json`. Do **not** hand-write per-route "returns 403 for an API key" tests.
- `apps/text/src/text/tests/unit/{test_providers_endpoint,test_task799_provider_discovery,test_openai_compat_provider}.py`

**Any route change here triggers the full five-artifact regeneration** — see the execution plan §5.

### Follow-ups the exploration could not close (read before implementing)
- `apps/admin-console/src/features/ai-providers/` (`provider-meta.ts`, `provider-credentials-tab.tsx`) — **verify it already covers LM Studio base-URL entry** before building a new form.
- `AiModelService` and `IProviderConnectionService.resolveConnection` / `resolveTenantCloudOverrides` live in `@arcaai/applications` and were not read — required before implementing any new OCC-write route.
- `ai-runtime-profile.controller.ts` uses a **row-addressed-by-query-param** OCC pattern with a `CREATE_ETAG = '"0"'` sentinel — read it before deciding whether LM Studio tuning belongs in an `AiRuntimeProfile` row or a new model.

## 10. Verification Criteria
- [ ] Image builds reproducibly from a pinned `llmster` version with a recorded checksum
- [ ] GPU offload confirmed inside the container (not silent CPU fallback) — evidence pasted
- [ ] OpenAI-compatible `/v1/chat/completions` and `/v1/models` served and reachable from `apps/text`
- [ ] Model loads from the MinIO-synced PVC, in the required `<publisher>/<model>/` layout
- [ ] Readiness distinguishes "model loaded" from "process up"
- [ ] `n_parallel` set explicitly and headlessly; concurrency measured at 4, 8, 16
- [ ] Sharded-GGUF guard: sync verifies checksums and points at shard 1
- [ ] A GGUF synced from MinIO is visible to `lms ls` **after `lms import`** — and the staging file still exists (proves `-L`/`-c`, not a move)
- [ ] Deployment retires the out-of-band selector-less Service + hand-written Endpoints
- [ ] No telemetry egress observed; NetworkPolicy blocks everything but DNS + MinIO
- [ ] Routed to as provider priority #2 via an `AiProviderConnection` SYSTEM row — **no router code change**
- [ ] Rolling restart drops zero in-flight generations
- [ ] Console screen shows correct up/down status, and the banner carries `probe_error` verbatim when down
- [ ] Console surfaces the active runtime so a silent CPU-only image (§4.1) is visible, not hidden
- [ ] Artifact upload goes through the BFF proxy (`FileInterceptor`), download via presigned GET
- [ ] axe scan: 0 violations, both themes
- [ ] New routes appear in a regenerated `route-manifest.json` and pass the authz matrix unmodified

## 11. Change History
| Date | Change |
|---|---|
| 2026-08-29 | Ticket created. Owner directed a custom headless `llmster` GPU image over `linuxserver/docker-lm-studio`; ToS position recorded as accepted risk; MinIO artifact plane specified. |
