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

### 3.2 Prefer single-file GGUF

If a model must be sharded, the server must be pointed at **shard 1** (`model-00001-of-000NN.gguf`); pointing at any other yields `illegal split file idx`. **A partial sync that lands shard 2 first is a silent failure mode** — which is why the manifest records shard 1's key explicitly and the sync verifies checksums before flipping the ready sentinel. `gguf-split` splits at tensor boundaries, so shards are individually valid objects and are safe to store as separate MinIO objects with per-object checksums.

### 3.3 Sync mechanics

**Warm a PVC with a one-shot Job, not a per-pod init container.** Serving pods mount it `ReadOnlyMany`; nothing re-pulls per pod.

1. Job runs `s5cmd cp` (or `mc`) MinIO → PVC, reproducing the `<publisher>/<model>/` layout.
2. Verify sha256 against `manifest.json`.
3. Write a `.ready` sentinel. Serving pods gate on it.

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
- **`--parallel` has no REST equivalent.** So setting concurrency *and* KV-cache flags currently
  needs the CLI for one and REST for the other, or accepting defaults. Plan for the entrypoint to
  do `lms load --parallel` and then, if KV flags are needed, a follow-up REST load.

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

1. **Whether a GGUF dropped on disk by the MinIO sync is picked up automatically**, or needs
   `lms import` / a rescan / an index file. Docs imply a directory scan; not confirmed. If it
   needs an import step, the sync Job must call `lms import --user-repo <u>/<r> -y` per model, and
   §3.3's "sentinel then serve" design gains a step.
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

## 5. Kubernetes and security posture

| # | Control | Detail |
|---|---|---|
| L-1 | **NetworkPolicy: ingress on the API port from `apps/text` only** | Nothing else reaches it. |
| L-2 | **Private registry only** | The image embeds a proprietary binary; no redistribution right (§1). |
| L-3 | Block telemetry egress | Egress allow-list: DNS, MinIO. A PHI environment must not phone home. Verify no first-run analytics call. |
| L-4 | Readiness gates on **model loaded**, not process up | See §4 for the mechanism available. |
| L-5 | `terminationGracePeriodSeconds` ≫ longest generation; `preStop` sleep so the Service drops the endpoint first | Same discipline as vLLM (TASK-823 §8). |
| L-6 | Memory request ≥ model bytes + KV (`n_parallel × n_ctx`) | Plus a `startupProbe` with a generous `failureThreshold` covering model load. |
| L-7 | Non-root where the runtime permits | Verify what breaks; document if it cannot be non-root. |

## 6. Throughput expectations — set them honestly

LM Studio 0.4.0 added **continuous batching** for parallel requests to the same model, but `n_parallel` ("Max Concurrent Predictions") **defaults to 4**, it requires the llama.cpp runtime (MLX "coming soon"), and the ceiling is llama.cpp's, not LM Studio's. Raising `--parallel` without raising batch size *"just spreads the same throughput across more queues; latency goes up, aggregate tokens per second does not."*

Comparative 2026 benchmarks consistently put **vLLM 7–12× ahead above ~8 concurrent users** (≈10× aggregate throughput at 32 concurrent requests). Treat magnitudes, not exact figures, as reliable.

**Therefore: one LM Studio instance sustains single-digit-to-low-teens concurrent generations before p95 degrades.** Against the platform's 20–40 in-flight target, LM Studio is a **secondary/eval tier behind vLLM**, exactly as the priority order already states. Size expectations and the routing policy accordingly — do not let it become the primary candidate for clinical traffic under a `LEAST_BUSY` strategy.

## 7. Verification Criteria
- [ ] Image builds reproducibly from a pinned `llmster` version with a recorded checksum
- [ ] GPU offload confirmed inside the container (not silent CPU fallback) — evidence pasted
- [ ] OpenAI-compatible `/v1/chat/completions` and `/v1/models` served and reachable from `apps/text`
- [ ] Model loads from the MinIO-synced PVC, in the required `<publisher>/<model>/` layout
- [ ] Readiness distinguishes "model loaded" from "process up"
- [ ] `n_parallel` set explicitly and headlessly; concurrency measured at 4, 8, 16
- [ ] Sharded-GGUF guard: sync verifies checksums and points at shard 1
- [ ] No telemetry egress observed; NetworkPolicy blocks everything but DNS + MinIO
- [ ] Routed to as provider priority #2 via an `AiProviderConnection` SYSTEM row — **no router code change**
- [ ] Rolling restart drops zero in-flight generations

## 8. Change History
| Date | Change |
|---|---|
| 2026-08-29 | Ticket created. Owner directed a custom headless `llmster` GPU image over `linuxserver/docker-lm-studio`; ToS position recorded as accepted risk; MinIO artifact plane specified. |
