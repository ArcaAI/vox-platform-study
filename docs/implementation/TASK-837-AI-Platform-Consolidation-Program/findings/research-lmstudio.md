# LM Studio ("llmster") as a Containerised Inference Provider in k3s — Research Brief

Date: 2026-09-01. Prepared as external research to feed HOPE's TASK-824 (LM Studio headless
service) and related tickets. **Read this alongside internal ground truth, not instead of it** —
see the "Internal ground truth already exists" note immediately below. All external claims below
carry a URL; internal claims are marked `INTERNAL:` with a repo path and are not independently
citable outside this codebase.

---

## 0. Orientation — two things the orchestrator needs before reading further

### 0.1 Naming: "lmster" is "llmster" — and it already exists in this repo

LM Studio's own official headless daemon is spelled **`llmster`** (double L), not "lmster". It
was introduced in LM Studio 0.4.0 (2026-01-28) as "a GUI-free daemon designed for server
environments... on Linux, macOS, cloud servers, and GPU rigs without requiring any graphical
interface at setup or runtime."
[Run LM Studio as a service (headless)](https://lmstudio.ai/docs/developer/core/headless),
[LM Studio, llmster, and lms](https://lmstudio.ai/docs/app/basics/lmstudio-vs-llmster-vs-lms).

**This is not a green-field ask.** `INTERNAL: docs/implementation/TASK-824-LM-Studio-Service/`
already contains a fully-argued, partially-shipped implementation: a production Dockerfile and
entrypoint at `infrastructure/docker/lmstudio/` (built by GitLab CI job `build-lmstudio`, gated
by `verify-lmstudio-runtime`), eight k8s objects staged in `hope-v2-deployment@main` (Deployment
`hope-lmstudio` currently at `replicas: 0`, PVC, ConfigMaps, NetworkPolicies, HPA, PDB), a MinIO
sync Job design, and an `AiProviderConnection` seed row already pointed at
`http://hope-lmstudio:1234/v1` (`seed/17-ai-provider-connection.ts:253-266`). The owner decision
of record (2026-08-30) is **LM Studio (llmster) + vLLM**, both engines, LM Studio as the
secondary/eval tier behind vLLM. A same-repo research spike, `INTERNAL:
docs/implementation/TASK-835-S3-Mounted-Model-Store/`, already built and *measured* an S3-mounted
model directory for both LM Studio and vLLM.

This brief's job is therefore **verification and gap-filling against current (2026-09-01)
upstream sources**, not invention from scratch. Where my external findings confirm the internal
ticket, I say so and move on. Where they add something new, correct something, or the internal
ticket's build is still failing/blocked, I flag it explicitly.

### 0.2 The single biggest open risk is licensing, and it is already an *accepted*, not *resolved*, risk

`INTERNAL: docs/implementation/TASK-824-LM-Studio-Service/README.md:54` already records: *"the
LM Studio App ToS (effective 2026-08-23) grants use 'solely for Your personal and/or internal
business purposes' and restricts 'service bureau use, as an application service provider, or a
software-as-a-service.' The owner has directed that LM Studio be deployed in the serving path.
This is an accepted risk under explicit owner direction."* Section A below re-verifies the exact
current terms and explains precisely why this is a live tension for a multi-tenant SaaS healthcare
platform, not a rounding error — it should be re-surfaced to legal/compliance periodically, not
treated as closed because it was accepted once.

---

## 1. Answers to the seven research questions

### Q1 — Headless operation: can it run genuinely headless, and what does the license allow?

**Yes, technically.** LM Studio ships `llmster`, a GUI-free daemon, specifically for this. Exact
CLI surface (all verified against current docs, 2026-09-01):

- Install: `curl -fsSL https://lmstudio.ai/install.sh | bash` (Linux/Mac) —
  [headless docs](https://lmstudio.ai/docs/developer/core/headless).
- `lms daemon up` — starts the `llmster` daemon. **It forks and exits; there is no
  `--foreground`/no-detach flag** (`INTERNAL:` verified against `lms` source,
  `docs/implementation/TASK-824-LM-Studio-Service/README.md:364-369` — this is why a container
  needs a wrapper entrypoint, not a bare `lms` invocation as `ENTRYPOINT`).
- `lms server start --port <p> --bind <addr>` — starts the HTTP server. **`--bind` defaults to
  `127.0.0.1`**; omitting it makes any k8s Service silently dead.
  [Run LM Studio as a service](https://lmstudio.ai/docs/developer/core/headless).
- `lms daemon down` / `lms server stop` — graceful-ish shutdown hooks for a `trap`.
- Linux systemd unit (exact, from
  [Setup llmster as a Startup Task on Linux](https://lmstudio.ai/docs/developer/core/headless_llmster)):

  ```
  [Unit]
  Description=LM Studio Server
  [Service]
  Type=oneshot
  RemainAfterExit=yes
  User=YOUR_USERNAME
  Environment="HOME=/home/YOUR_USERNAME"
  ExecStartPre=/home/YOUR_USERNAME/.lmstudio/bin/lms daemon up
  ExecStartPre=/home/YOUR_USERNAME/.lmstudio/bin/lms load openai/gpt-oss-20b --yes
  ExecStart=/home/YOUR_USERNAME/.lmstudio/bin/lms server start
  ExecStop=/home/YOUR_USERNAME/.lmstudio/bin/lms daemon down
  [Install]
  WantedBy=multi-user.target
  ```

- Three-tier relationship, stated by the vendor: **LM Studio (GUI app)**, **llmster (headless
  daemon)**, **`lms` (CLI, bundled with both, talks to whichever is running)**.
  [LM Studio, llmster, and lms](https://lmstudio.ai/docs/app/basics/lmstudio-vs-llmster-vs-lms).
- **No GUI is required at any point**, including first-time setup, when using `llmster` — this is
  explicitly the differentiator from "desktop app in headless mode," which does require a
  graphical environment to have existed once.
  [headless docs](https://lmstudio.ai/docs/developer/core/headless).

**An official Docker image exists but is not usable for HOPE's requirement.**
[`lmstudio/llmster-preview`](https://hub.docker.com/r/lmstudio/llmster-preview) on Docker Hub —
"headless version of LM Studio... suited for CI jobs and testing on commodity CPUs." As of
2026-09-01 it publishes **only `cpu`/`latest` tags, `linux/amd64`, CPU-only** — no CUDA tag exists.
[Tags](https://hub.docker.com/r/lmstudio/llmster-preview/tags). This is exactly the gap HOPE's own
image closes (`INTERNAL: infrastructure/docker/lmstudio/README.md:68`: *"The official
`lmstudio/llmster-preview` image proves the headless shape is supported — it is only unusable here
because it is CPU-only on x86, which is precisely the gap our image closes."*).

**Licensing — this is where "technically possible" and "permitted" diverge, and it matters for
HOPE specifically.** Current terms, [LM Studio App Terms of Service](https://lmstudio.ai/app-terms)
(effective **August 23, 2026**, i.e. current as of this research date):

> "sublicense, distribute, sell, use for service bureau use, as an application service provider,
> or a software-as-a-service, lease, rent, loan, or otherwise transfer the Software or the
> Documentation to any third party"

is explicitly prohibited. The license is scoped to *"Your personal and/or internal business
purposes."* In July 2025 LM Studio removed the requirement to obtain a *separate commercial
license* for at-work use — [LM Studio is free for use at
work](https://lmstudio.ai/blog/free-for-work) — but that change addressed **using the app at your
own company for your own team's work**, not hosting it as the inference backend of a product you
sell to customers. The blog post itself does not mention SaaS, service-bureau, or multi-tenant
hosting anywhere; it is scoped to internal team use.
[LM Studio Enterprise](https://lmstudio.ai/enterprise) exists as a separate program (SSO, model/MCP
gating, ZDR cloud, "deploy on your own infrastructure") but its public page does not state that it
lifts the SaaS/service-bureau restriction for a company embedding LM Studio in its own
multi-tenant product — it reads as a contact-sales offering, not a published carve-out.

**Why this is a live tension for HOPE specifically, not paperwork:** HOPE is, by its own
architecture docs, a multi-tenant healthcare **SaaS** platform — the exact word the ToS singles
out. Running `llmster` as the inference backend serving multiple paying tenants' clinical
consultation requests is a plausible reading of "software-as-a-service" / "application service
provider" use under this clause. **`INTERNAL:` this exact tension is already recorded and
consciously accepted** by the owner (TASK-824 §1), with the practical mitigation of **never
distributing the built image publicly** (private registry only — the image also embeds a
proprietary binary HOPE holds no redistribution right to, a second and independent reason for that
constraint). I am not in a position to give legal advice and did not find a published LM Studio
statement that resolves the tension either way for a SaaS reseller — **UNVERIFIED**, and I
recommend this be revisited with counsel as usage scales, not left as a one-time 2026-08-30
sign-off. The risk is legal/commercial, not technical: nothing about llmster's behavior changes if
the license is violated; only the license permission does.

**Sources:**
[Run LM Studio as a service (headless)](https://lmstudio.ai/docs/developer/core/headless) ·
[Setup llmster as a Startup Task on Linux](https://lmstudio.ai/docs/developer/core/headless_llmster) ·
[LM Studio, llmster, and lms](https://lmstudio.ai/docs/app/basics/lmstudio-vs-llmster-vs-lms) ·
[LM Studio App Terms of Service](https://lmstudio.ai/app-terms) ·
[LM Studio is free for use at work](https://lmstudio.ai/blog/free-for-work) ·
[LM Studio Enterprise](https://lmstudio.ai/enterprise) ·
[`lmstudio/llmster-preview`](https://hub.docker.com/r/lmstudio/llmster-preview) ·
[Tags](https://hub.docker.com/r/lmstudio/llmster-preview/tags)

---

### Q2 — Containerisation: official image, GPU, and one image for CUDA + CPU

**No official CUDA image exists** (Q1 above — `llmster-preview` is CPU-only). HOPE must build its
own, and — per `INTERNAL:` — already has, at `infrastructure/docker/lmstudio/Dockerfile`.

**GPU/CUDA inside a container works**, confirmed two independent ways:
1. Community image `linuxserver/docker-lm-studio` supports "Cuda v13... a 2000 series or higher
   Nvidia video card" via the standard `--runtime nvidia --gpus all` pattern (though that image
   runs the full GUI app over a web-streamed virtual desktop — Selkies/KasmVNC — which HOPE
   correctly rejected as a serving shape; `INTERNAL: TASK-824 README §2` quotes its own docs:
   *"This container provides privileged access to the host system"* and *"The web interface
   includes a terminal with passwordless sudo access. Any user with access can gain root control"*
   — wrong shape for a PHI-adjacent cluster).
   [linuxserver/docker-lm-studio](https://github.com/linuxserver/docker-lm-studio)
2. NVIDIA Container Toolkit (current, 2026) supports CUDA 12.8 covering Ada/Hopper/Blackwell;
   driver floor for Blackwell cards is 570.xx, and general guidance is "align driver with CUDA
   minor." [NVIDIA Container Toolkit setup](https://oneuptime.com/blog/post/2026-01-16-docker-nvidia-gpu-ai-ml/view)

**LM Studio's own runtime-extension mechanism is exactly the "one image, two backends" answer,**
and this is the mechanism HOPE's shipped Dockerfile already uses:

- LM Studio ships the app/daemon and the inference **runtime** (llama.cpp or MLX build) as
  **separate, pluggable packages** — "runtimes"/"engines". CLI: `lms runtime ls` (list installed),
  `lms runtime get` (download one), `lms runtime select` (activate one), `lms runtime remove`.
  [lms runtime docs](https://lmstudio.ai/docs/cli/runtime/runtime)
- Confirmed variants: llama.cpp CPU, llama.cpp+CUDA, llama.cpp+Vulkan (AMD/Intel), llama.cpp+ROCm
  (some AMD/Linux), and an Apple-only MLX engine.
  [NVIDIA/LM Studio CUDA 12.8 blog](https://blogs.nvidia.com/blog/rtx-ai-garage-lmstudio-llamacpp-blackwell/)
- **`INTERNAL:` measured fact, and this is the load-bearing one:** the `full+cuda12` Linux x64
  download bundle ships **both** a CPU engine and a CUDA engine side by side under
  `~/.lmstudio/extensions/backends/`, e.g. `llama.cpp-linux-x86_64-avx2-2.31.2` (CPU) **and**
  `llama.cpp-linux-x86_64-nvidia-cuda12-avx2-2.31.2` (CUDA) — but **selects the CPU one by
  default**. Without an explicit `lms runtime select <cuda-engine> --latest`, a correctly-built
  CUDA image silently serves on CPU. This was independently re-confirmed on the arm64 developer
  bundle (`llama.cpp-linux-arm64` alongside `…-nvidia-cuda13`) — same shape, different
  architecture/CUDA minor. `INTERNAL: infrastructure/docker/lmstudio/README.md:112-128`,
  `docs/implementation/TASK-824-LM-Studio-Service/README.md:967-973`.
- Consequence for the Dockerfile: **the engines must be baked in at build time** (owner directive,
  `INTERNAL:` 2026-08-31) by actually starting the daemon once during the build so it materialises
  `extensions/backends/` into the image layer, then asserting the filesystem contains **both** a
  CPU and a CUDA entry — not by running `lms runtime ls` at build time, which is **hardware-filtered**
  (answers "what can this host run," not "what is on disk") and reports nothing useful on a
  GPU-less CI runner. `INTERNAL:` this exact wrong-probe mistake caused a real CI failure
  (pipeline 1030, job 15218) and was subsequently root-caused and fixed — see
  `infrastructure/docker/lmstudio/Dockerfile:92-156` for the corrected two-part assertion.
- At **runtime**, `entrypoint.sh` selects the engine explicitly (`lms runtime select <cuda>`) and
  then asserts a GPU is actually visible before serving — because §Q3/Q6 below shows LM Studio's
  HTTP surface cannot itself reveal whether it silently fell back to CPU. This "select, then
  assert" step is the part that makes the same image correct on both a GPU node and (if you choose
  to run it there) a CPU-only node.

**Dockerfile skeleton** (a sketch for review — the concrete, hardened, already-CI-passing version
lives at `INTERNAL: infrastructure/docker/lmstudio/Dockerfile`; reproduced in shape, not verbatim,
so this brief stands alone):

```dockerfile
# --- Base: CUDA runtime libs only (no GPU needed to build; CUDA userspace libs
#     install fine on a GPU-less builder because they are just shared objects) ---
ARG BASE_IMAGE=nvidia/cuda:12.8.1-runtime-ubuntu24.04
FROM ${BASE_IMAGE}

# --- Pin the exact bundle by URL + published SHA-512. NEVER `curl install.sh | bash`
#     in a Dockerfile: install.sh selects the CUDA vs CPU bundle by probing the
#     BUILD HOST's nvidia-smi + driver version, so a GPU-less CI runner silently
#     produces a CPU-only "CUDA" image with no error at any layer. ---
ARG LLMSTER_VERSION=0.0.23-1
ARG LLMSTER_ARTIFACT=${LLMSTER_VERSION}-linux-x64.full+cuda12.tar.gz
ARG LLMSTER_SHA512=<pinned, fetched from llmster.lmstudio.ai/download/<artifact>.sha512>
ARG HOPE_BUILD_ACCEL=cuda   # declaration only; the FS check below is the measurement

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl libatomic1 libgomp1 tini \
 && rm -rf /var/lib/apt/lists/*

# Fixed-UID non-root, real $HOME (bug lmstudio-ai/lms#2093 alleges $HOME is
# ignored under some container runtimes — NOT reproduced with a real $HOME set
# before install; re-verify per target base image).
RUN useradd -u 10001 -m -d /home/llmster -s /usr/sbin/nologin llmster
USER llmster
ENV HOME=/home/llmster PATH=/home/llmster/.lmstudio/bin:/usr/local/bin:/usr/bin:/bin

RUN set -eu; cd /tmp; \
    curl -fsSL --retry 3 --retry-delay 5 -o llmster.tar.gz \
      "https://llmster.lmstudio.ai/download/${LLMSTER_ARTIFACT}"; \
    echo "${LLMSTER_SHA512}  llmster.tar.gz" | sha512sum -c -; \
    mkdir -p x && tar xf llmster.tar.gz -C x; \
    LMS_BOOTSTRAP_INSTALL_SH=1 LMS_NO_MODIFY_PATH=1 ./x/llmster bootstrap; \
    rm -rf /tmp/llmster.tar.gz /tmp/x

# --- Bake BOTH engines into the layer. Must start the daemon once (its FIRST
#     start is what populates extensions/backends/, not `bootstrap` alone), then
#     assert the FILESYSTEM — never `lms runtime ls`, which is hardware-filtered
#     and will report "No runtimes found" on any GPU-less CI runner even when
#     the CUDA engine is genuinely on disk. ---
RUN set -eu; b=/home/llmster/.lmstudio/extensions/backends; \
    lms daemon up >/dev/null || true; \
    i=0; while [ $i -lt 60 ]; do lms daemon status 2>/dev/null | grep -q "is running" && break; i=$((i+1)); sleep 1; done; \
    cuda="$(ls -1 "$b" | grep -i cuda | head -1)"; \
    cpu="$(ls -1 "$b" | grep -i '^llama\.cpp' | grep -vi 'cuda\|vulkan\|rocm\|metal' | head -1)"; \
    [ -n "$cuda" ] && [ -n "$cpu" ] || { echo "FATAL: missing an engine"; ls -1 "$b" >&2; exit 1; }; \
    lms daemon stop >/dev/null 2>&1 || true

# Weights live on a mounted volume, never in the image.
RUN rm -rf /home/llmster/.lmstudio/models && ln -s /data/models /home/llmster/.lmstudio/models

ENV LMS_PORT=1234 LMS_SERVER_HOST=0.0.0.0 HOPE_EXPECT_ACCEL=${HOPE_BUILD_ACCEL}
VOLUME ["/data"]
EXPOSE 1234
COPY --chown=llmster:llmster entrypoint.sh /usr/local/bin/entrypoint.sh

# Every unknown path returns HTTP 200 (lmstudio-ai/lms bug #1323) — an httpGet
# probe on ANY path always "passes," so the HEALTHCHECK must grep the BODY.
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${LMS_PORT}/lmstudio-greeting" | grep -q '"lmstudio":[[:space:]]*true' || exit 1

ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/entrypoint.sh"]
```

Entrypoint shape (again, sketch — real version at `INTERNAL:
infrastructure/docker/lmstudio/entrypoint.sh`, eight ordered fail-closed assertions exiting 78):
`lms daemon up` → poll `lms daemon status | grep -q "is running"` (**not** `lms server status &&
break` — that command exits 0 unconditionally, even before the daemon exists, so a naive wait loop
breaks on its first iteration and never actually waits) → `lms runtime select <cuda-engine>
--latest` → assert a GPU is actually present (`lms runtime survey --json` → `vramCapacity` /
`gpuSurveyResult`) → `lms server start --port 1234 --bind 0.0.0.0` (both flags mandatory; default
bind is loopback) → optional preload `lms load ...` → hold PID 1 on `exec lms log stream` (there
is no blocking foreground flag on any `lms` command).

**Size expectation:** the CPU-only official preview image is 370–404 MB
([tags](https://hub.docker.com/r/lmstudio/llmster-preview/tags)). A CUDA-runtime base
(`nvidia/cuda:12.8.1-runtime-ubuntu24.04` is itself several hundred MB) plus the `+cuda12` bundle
(which itself bundles CUDA-linked llama.cpp libraries) will be **materially larger** — expect low
single-digit GB. `INTERNAL: TASK-824 §4.9 item 11` flags this explicitly as unmeasured; CI is the
first place to get a real number (never build locally per the CI-only directive below).

**Governance note that overrides anything in this section:** `INTERNAL:
infrastructure/docker/lmstudio/README.md:7`: *"CI IS THE ONLY BUILDER. Owner directive,
2026-08-30. Do not run `docker build` for this image on a workstation."* This matches HOPE's
platform-wide rule (`09-infrastructure-devops.md`) that GitLab CI is the only image builder. The
Dockerfile above is offered as a design sketch for review, consistent with the constraint given —
it is not a deliverable to build locally.

**Sources:** [lms runtime docs](https://lmstudio.ai/docs/cli/runtime/runtime) ·
[NVIDIA/LM Studio CUDA 12.8](https://blogs.nvidia.com/blog/rtx-ai-garage-lmstudio-llamacpp-blackwell/) ·
[NVIDIA Container Toolkit setup](https://oneuptime.com/blog/post/2026-01-16-docker-nvidia-gpu-ai-ml/view) ·
[linuxserver/docker-lm-studio](https://github.com/linuxserver/docker-lm-studio) ·
[`lmstudio/llmster-preview` tags](https://hub.docker.com/r/lmstudio/llmster-preview/tags)

---

### Q3 — REST + OpenAI-compat endpoint table

LM Studio actually exposes **three** distinct HTTP surfaces (docs fetched directly, 2026-09-01;
cross-checked against `INTERNAL: TASK-824 §8.1`, which reached the same endpoint list independently
by reading the `lms`/`lmstudio-js` sources at HEAD):

| Surface | Method | Path | Streaming (SSE) | Notes / deviation from vanilla OpenAI |
|---|---|---|---|---|
| **Native v1 (current, recommended)** | GET | `/api/v1/models` | — | Lists **every model on disk**; loaded ones carry non-empty `loaded_instances[]`. One call answers both "what exists" and "what's loaded" — not an OpenAI concept |
| Native v1 | POST | `/api/v1/chat` | Yes (`stream:true`) | **Not chat-completions shaped.** Responses-API-like: `input` (string or content-part array), `output` (array of message/tool-call/reasoning items), `stats{input_tokens,total_output_tokens,tokens_per_second,time_to_first_token_seconds}`. No OpenAI client can point at this without a translation layer |
| Native v1 | POST | `/api/v1/models/load` | — | Body: `model`(req), `context_length`, `eval_batch_size`, `flash_attention`, `num_experts`, `offload_kv_cache_to_gpu`, `echo_load_config`. **`gpu`, `ttl`, `parallel`, `identifier` are CLI/SDK-only — not in this body at all** |
| Native v1 | POST | `/api/v1/models/unload` | — | Body: `instance_id` |
| Native v1 | POST | `/api/v1/models/download` | — | Body: `model` (catalog id **or full HF URL**), `quantization`. Background job |
| Native v1 | GET | `/api/v1/models/download/status/:job_id` | No (poll only) | `status`, `downloaded_bytes`, `total_size_bytes`, `bytes_per_second`, `estimated_completion`. **No cancel endpoint** |
| **Native v0 (legacy, "enhanced stats")** | GET | `/api/v0/models` | — | Superset of `/v1/models` info: `state` (loaded/not-loaded), `quantization{name,bits_per_weight}`, `max_context_length` — richer than OpenAI's `/v1/models`. `INTERNAL:` `apps/text`'s `openai_compat.py:371` already uses this for console enrichment, best-effort |
| Native v0 | GET | `/api/v0/models/{model}` | — | Single-model detail |
| Native v0 | POST | `/api/v0/chat/completions` | Yes (optional) | OpenAI-request-shaped, but response carries an added `stats{tokens_per_second,time_to_first_token,generation_time,stop_reason}` object OpenAI's schema has no field for |
| Native v0 | POST | `/api/v0/completions` | Yes (optional) | Legacy text completions, same `stats` addition |
| Native v0 | POST | `/api/v0/embeddings` | No | — |
| **OpenAI-compatible** | GET | `/v1/models` | — | Standard OpenAI shape — this is the one to point a stock `openai` SDK client at |
| OpenAI-compatible | POST | `/v1/chat/completions` | **Yes (SSE)** | This is the endpoint HOPE's adapter and `apps/text`'s `openai_compat.py` must use |
| OpenAI-compatible | POST | `/v1/completions` | Yes | Legacy completions |
| OpenAI-compatible | POST | `/v1/embeddings` | No | — |
| OpenAI-compatible | POST | `/v1/responses` | Yes | New; docs note it "supports Codex" — OpenAI's newer Responses API shape, distinct from Chat Completions |

**Deviations that will break a naive "just point the OpenAI SDK at it" adapter:**

1. **`stats` object is LM-Studio-specific and can appear even on the OpenAI-compat endpoint,
   inconsistently.** A filed bug shows `/v1/chat/completions` (the *OpenAI-compatible* path)
   returning an **empty `"stats": {}`** rather than omitting the field or populating it — i.e. an
   OpenAI-schema-strict client that treats extra unknown fields as an error, or that expects `stats`
   either absent or populated, can be surprised either way.
   [GitHub issue #601](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/601)
2. **Reasoning-model output.** `INTERNAL:` measured against Gemma 4: the model's reasoning is
   emitted into `message.reasoning_content`, **leaving `message.content` empty** for that turn.
   Vanilla OpenAI chat-completions has no standard `reasoning_content` field on the response
   message for most callers; a naive adapter reading only `content` will see blank output from a
   reasoning-capable model. `INTERNAL: TASK-824 change history, 2026-08-30 entry.`
3. **Every unknown path returns HTTP 200**, not 404 — including `/health`, `/metrics`, and
   literally any typo'd path, with body `{"error":"Unexpected endpoint or method..."}`.
   `INTERNAL:` measured directly; also a filed vendor bug
   (`lmstudio-ai/lms` #1323, cited in `TASK-824 README:585-590`, not independently re-verified by
   me against the tracker but consistent with what I directly observed in the doc content). **This
   means naive `httpGet`-status-code health probes can never fail**, and any monitoring/adapter
   code that treats a 200 as "endpoint exists" will be systematically wrong here.
4. **No API versioning guarantee.** LM Studio's own docs state v1 is "officially released" and
   recommended over v0, but publish **no breaking-change policy and no v0 removal date** — treat
   every response field as optional in a consuming DTO, per `INTERNAL: TASK-824 §8.6`.
5. **Auth is inconsistent across the surfaces.** The native REST docs state requests need "an
   authorization header with a Bearer token," but `INTERNAL:` a source-level search of `lms/src`
   for `apiToken|requireAuth|createToken|bearer` returns **zero hits for any headless token-minting
   path** — tokens are described as GUI-only. In practice a headless deployment runs with auth
   effectively off, enforced only by network policy (see Q6/F and the Top-5-risks section).

**Sources (all fetched directly today):**
[REST API v0 endpoints](https://lmstudio.ai/docs/developer/rest/endpoints) ·
[Chat with a model (v1)](https://lmstudio.ai/docs/developer/rest/chat) ·
[OpenAI Compatibility Endpoints](https://lmstudio.ai/docs/developer/openai-compat) ·
[Chat Completions (OpenAI-compat)](https://lmstudio.ai/docs/developer/openai-compat/chat-completions) ·
[GitHub issue #601 — empty stats](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/601)

---

### Q4 — Model management + S3/MinIO-backed model directory

**Programmatic model management, three ways, each with a real gap:**

| Action | CLI (`lms`) | REST | Python SDK |
|---|---|---|---|
| List | `lms ls` | `GET /api/v1/models` (all) / `/api/v0/models` (richer) | `lms.list_downloaded_models()` |
| Load | `lms load <id> --gpu --ttl --parallel --identifier --context-length` | `POST /api/v1/models/load` (**no `gpu`/`ttl`/`parallel`/`identifier` fields**) | `lms.llm(id)` |
| Unload | `lms unload` | `POST /api/v1/models/unload {instance_id}` | context-managed unload |
| Download | `lms get <catalog-id \| full-HF-url>` | `POST /api/v1/models/download` (poll-only status, **no cancel**) | download via SDK wraps the same |
| **Import a local file** | `lms import <file> --user-repo <pub>/<model> -y -L` | **none** | **none** |
| **Delete from disk** | **none** | **none** | **none** — filesystem `rm` is the only path |
| **Active engine/runtime** | `lms runtime ls` / `survey` | **none** | **none** — WebSocket RPC only |

`INTERNAL: TASK-824 §8.2/§8.3` reaches the same conclusion independently and recommends
**REST-first with a narrow `exec lms ...` escape hatch** for the gaps, explicitly rejecting the
SDK for the admin plane because it speaks WebSocket RPC (`ws://host:1234`), not HTTP, and proxying
that through a stateless NestJS REST controller would require holding a long-lived stateful SDK
client in a provider — a materially different (and heavier) architecture than the rest of the
gateway's proxy pattern.

**Model directory: layout, location, and whether S3/MinIO can back it.**

- Default: `~/.lmstudio/models`, mandatory layout `<publisher>/<model>/<file>.gguf` — a GGUF
  dropped at the models root is **not discovered** (filed defect, `lmstudio-js` #387, per
  `INTERNAL:` TASK-824). No env var changes the directory; it is set via `settings.json
  {downloadsFolder}` (GUI-first) or, more reliably in a container, a **symlink**:
  `~/.lmstudio/models -> /data/models`.
- **Directory *is* watched — this corrects a common assumption (including an earlier draft of
  HOPE's own ticket).** `INTERNAL:` measured twice: a GGUF placed at
  `<models>/<publisher>/<model>/x.gguf` **before** daemon start is indexed at start; one dropped
  there **while the daemon runs**, with no explicit rescan or restart, is indexed within seconds.
  There is no `rescan`/`reindex`/`refresh` CLI or RPC verb because the daemon watches the
  filesystem directly. (A known open vendor bug, #844 "models missing until app restarted," means
  this should be treated as observed behavior to verify per-deployment, not a guarantee to build
  a design around blindly — but it is not the "totally undiscoverable" failure mode an earlier
  reading suggested.)
- `~/.lmstudio/.internal/` (holds `llmster-install-location.json` and the daemon's control socket)
  **must stay on the image filesystem, never on a network volume** — without it `lms daemon up`
  fails outright, and a Unix domain socket on NFS/SMB breaks.

**Can the models directory be S3/MinIO-backed? Yes for reads — measured, not theoretical.**
`INTERNAL: docs/implementation/TASK-835-S3-Mounted-Model-Store/` ran exactly this experiment
against a real MinIO host and a real k8s cluster, with a 3.35 GB GGUF and (separately) a live
0.8 B-parameter model end to end:

- `mountpoint-s3` CSI, mounted at `/data/models`, symlinked from `~/.lmstudio/models`: LM Studio's
  daemon discovered the model off the mount with **no import step** (`lms ls` showed it directly);
  **cold load from the S3-backed mount: 33.9 s** for a ~700 MB model, **inference: 1.66 s**.
- **Writing INTO the mount fails.** `lms get`/downloads reach ~39% then `Checksum failed`, because
  the downloader finalises with an append/reopen, and `mountpoint-s3` refuses that operation
  (`Operation not permitted`) — confirmed as a **write-semantics limit of the mount**, not a bug in
  LM Studio. Consequence: **the serving pod must treat the mount as read-only; population is a
  separate, out-of-band job.**

**Ranked recommendation for a model-store backing:**

1. **RECOMMENDED, and what HOPE has already built: out-of-band sync to a PVC, not a live S3
   mount.** A one-shot Job (`s5cmd`/`mc mirror`) copies MinIO objects to a staging path on a
   `ReadWriteMany`/`ReadOnlyMany` PVC, verifies SHA-256 against a manifest, then
   `lms import <file> --user-repo <publisher>/<model> -y -L` (the `-L`/hard-link flag is
   **mandatory** — `lms import` **moves** the source file by default, which would silently empty a
   staging area; hard-linking requires staging and the models tree to share a filesystem, which a
   PVC guarantees and a mixed mount-plus-local-staging layout does not). A `.ready` sentinel gates
   serving pods. This sidesteps the S3-mount's write limitation entirely, needs no CSI driver, and
   gives `lms import`/delete/re-import full POSIX semantics. **Cold-start figures, measured:**
   storage-bandwidth-bound, not CPU-bound — NVMe-class throughput (3–4 GB/s) loads a model in tens
   of seconds; network-attached (400–600 MB/s) in minutes for larger models. **Do not bake weights
   into the image** — measured 8 B-parameter image pull+extract ≈ 11 minutes, far worse than a
   warm PVC. `INTERNAL: TASK-824 §3.3`.
2. **`mountpoint-s3` CSI, direct read-only mount** — viable fallback/alternative if PVC-sync
   operational overhead (a Job, a manifest, checksum plumbing) is unwanted, **provided model
   population happens by another path that writes correctly** (e.g. objects written by a separate
   process that has real S3 write access, with LM Studio's directory-watch picking them up). No
   extra sidecar container; best measured throughput of the read paths tested (see quantification
   below).
3. **`s3fs` sidecar mount** — comparable read performance, does not require installing a CSI
   driver (just a privileged sidecar with `/dev/fuse`), slightly better egress efficiency than
   `mountpoint-s3` in the measurement below. Reasonable if CSI driver installation is politically
   or operationally harder than adding a sidecar.
4. **JuiceFS** — not measured on this platform. Externally documented as fully POSIX-compliant
   including real writes, `mmap`, `fallocate`, and file locking, with native k8s CSI support
   ([JuiceFS + Kubernetes](https://medium.com/@lipton.bjit/juicefs-a-superior-file-system-for-robust-kubernetes-deployments-compared-to-alternatives-59a13568582b)).
   Worth evaluating only if a genuine multi-writer, POSIX-complete shared filesystem becomes a
   requirement (e.g., several engines writing into one shared, continuously-updated model cache) —
   it adds a metadata-engine dependency (Redis/TiKV/etc.) that the current single-writer
   sync-then-read pattern does not need.
5. **`rclone mount`** — ranked last. No CSI-native path, more tuning surface
   (`--vfs-cache-mode`, cache size, read-ahead), and independent community benchmarking on FUSE
   remote-filesystem performance orders the common options **goofys > s3fs > rclone** for
   read/write and metadata-heavy workloads
   ([rclone forum discussion](https://forum.rclone.org/t/achieving-s3fs-performance-with-rclone-mount/9644/19)).
   Not measured on this platform.

**The mmap/GGUF caveat, quantified (not theoretical) — external folklore was wrong here.** A
commonly repeated claim (echoed in general FUSE-over-object-storage writeups, e.g.
[Object Storage via Fuse Filesystems](https://joshua-robinson.medium.com/object-storage-via-fuse-filesystems-ea2cc8094e2c))
is that FUSE mounts either refuse `mmap()` or silently degrade it into a whole-object download.
**`INTERNAL:` this was directly tested on this platform's own MinIO and measured false on both
arms.** On a 3.35 GB GGUF:

| | `s3fs` sidecar | `mountpoint-s3` CSI |
|---|---|---|
| `mmap()` support | Works | Works |
| Random page-in, mid-file | 56 ms | 15 ms |
| Random page-in, EOF | 7 ms | 9 ms |
| Sequential read throughput | 312 MB/s | **376 MB/s** |
| Egress per 512 MiB logically read | 550 MiB (**1.07x** amplification) | 783 MiB (**1.53x** amplification) |
| Extra container per pod | Yes (privileged sidecar) | No |

`mmap()` genuinely issued **HTTP range GETs on page fault** rather than pulling the whole object,
on both mounts. `mountpoint-s3` is faster on sequential and random-mid-file access but prefetches
~43% more bytes than it logically needs to; `s3fs` is slightly slower but closer to 1:1 egress.
`INTERNAL: docs/implementation/TASK-835-S3-Mounted-Model-Store/README.md §5`.

**The operational caveat that remains true regardless of the numbers above:** these page-in
latencies (7–56 ms) are 1000x+ slower than a warm local NVMe page fault (microseconds). This
matters specifically for the **TTL/auto-evict + JIT-reload cycle** (see Q6): a model that gets
evicted after its idle TTL and then re-requested will, on a live S3-mount design, pay a burst of
these page-fault stalls on the first inference after reload, until the kernel page cache warms
back up. **This is the strongest practical argument for option 1 (PVC sync) over options 2–3 (live
mount) in a system that uses TTL-based unloading**, since a PVC on local/attached block storage
does not carry this penalty on cold re-load. HOPE's own design already uses the PVC pattern for
this and other reasons (write semantics, no CSI dependency, simpler `lms import` filesystem
requirements).

**Sources:** [GGUF mmap in llama.cpp](https://ongspxm.gitlab.io/reading/2024/07/mmap-in-llamma/) ·
[JuiceFS + Kubernetes](https://medium.com/@lipton.bjit/juicefs-a-superior-file-system-for-robust-kubernetes-deployments-compared-to-alternatives-59a13568582b) ·
[Object Storage via FUSE](https://joshua-robinson.medium.com/object-storage-via-fuse-filesystems-ea2cc8094e2c) ·
[rclone vs s3fs performance thread](https://forum.rclone.org/t/achieving-s3fs-performance-with-rclone-mount/9644/19) ·
`INTERNAL: docs/implementation/TASK-835-S3-Mounted-Model-Store/README.md` (primary evidence for
the quantified table — measured on this platform's own infrastructure, strictly stronger evidence
than the external sources for HOPE's specific case)

---

### Q5 — Python SDK (`lmstudio-python`) vs REST

From [lmstudio.ai/docs/python](https://lmstudio.ai/docs/python) (fetched directly) plus
[the `.act()` agentic-loop page](https://lmstudio.ai/docs/python/agent/act):

- `pip install lmstudio`. Three API styles: a REPL-friendly convenience API (`lms.llm(id)`,
  `model.respond(prompt)`), a scoped/context-manager API, and a fully async API (SDK ≥ v1.5.0,
  structured concurrency, configurable timeout via `lmstudio.set_sync_api_timeout()`).
- What it offers beyond plain REST: **model management** (list/load/unload with Python objects
  instead of hand-rolled HTTP calls), **structured output** (response-schema-constrained
  generation), **tool use / function calling**, the **`.act()` agentic loop**, **embeddings**,
  **tokenization utilities**, **image input**, **speculative decoding**, and streaming progress
  callbacks for load/download operations that REST can only poll for.
- Concrete `.act()` shape (verified example from the docs):

  ```python
  import lmstudio as lms
  model = lms.llm("qwen2.5-7b-instruct")
  chat = lms.Chat("You are a task-focused AI assistant")
  chat.add_user_message(user_input)
  model.act(
      chat,
      [create_file, multiply],           # plain Python functions, docstring = tool description
      on_message=chat.append,
      on_prediction_fragment=print_fragment,   # streaming text callback
      on_round_start=lambda idx: print(f"[Round {idx}]"),
      max_parallel_tool_calls=1,
  )
  ```

  `.act()` is an automatic multi-round tool-calling loop — the model can invoke a tool, receive the
  result, and decide whether to continue, without the caller hand-writing the loop.

**The transport reason this doesn't fit HOPE, independent of feature comparison:** the SDK talks
**WebSocket RPC** (`ws://host:1234`), not HTTP — `guessBaseUrl()` resolves to a `ws://` URL on the
same port, multiplexing `addRpcEndpoint`/`addChannelEndpoint` over one connection. `INTERNAL:
TASK-824 §8.3` verified this against the SDK source directly.

**Recommendation: REST-only, for both the inference request path and the admin/model-management
plane. Do not adopt `lmstudio-python`.**

- `apps/text` is the platform's sole LLM-calling surface and already speaks to every provider
  (Ollama, vLLM, Azure, Bedrock, LM Studio itself today) through one generic OpenAI-compatible
  `httpx.AsyncClient`-based adapter (`openai_compat.py`) and `06-python-services.md`'s explicit
  rule against growing a second inference stack applies here just as much to a second *client*
  library as to a second engine. Adding `lmstudio-python` would mean a bespoke WebSocket client
  living alongside — and duplicating the purpose of — the REST adapter every other provider uses,
  for one provider only.
- The agentic `.act()` loop, structured output, and tool-use conveniences are real, but they
  duplicate capability the platform's own orchestration layer (harness / `apps/text` tool-calling
  via the OpenAI-compatible `tools` param) already owns at the provider-agnostic level — building
  it a second time, LM-Studio-specific and WebSocket-bound, is scope creep against a single
  provider.
- For the admin/model-management gaps REST cannot reach (import, runtime survey, delete),
  `INTERNAL: TASK-824 §8.2/§8.3` already chose (and I concur, independently, having read the same
  transport constraint) a narrow `exec lms ...` escape hatch inside the gateway/console flow over
  standing up a stateful SDK client in NestJS — it is less new architecture for the same
  capability.
- The one place the SDK's WebSocket channel genuinely wins — **real streaming progress** for
  model loads/downloads, vs REST's poll-only `download/status` — is a nice-to-have for an admin
  console progress bar, not a requirement in the task brief. If that UX becomes a firm requirement
  later, it is an isolated, well-scoped reason to revisit, not a reason to adopt the SDK broadly
  today.

**Sources:** [lmstudio.ai/docs/python](https://lmstudio.ai/docs/python) ·
[`.act()` agentic loop](https://lmstudio.ai/docs/python/agent/act)

---

### Q6 — Concurrency, queueing, TTL, JIT loading, context length, health/readiness, metrics

| Concern | Behavior | Source |
|---|---|---|
| Concurrency | `n_parallel` ("Max Concurrent Predictions") default **4**; continuous batching (added in LM Studio 0.4.0) packs concurrent requests into shared batches rather than strict FIFO queueing; llama.cpp engine only (MLX "coming soon" as of this writing) | [Parallel Requests docs](https://lmstudio.ai/docs/app/advanced/parallel-requests); `INTERNAL: TASK-824 §6` |
| Setting it headlessly | `lms load --parallel <n>` (source-verified, **absent from published docs**); **not settable via `POST /api/v1/models/load`** — that endpoint has no `parallel` field, though it is *readable* afterwards via `loaded_instances[].config.parallel` | `INTERNAL: TASK-824 §4.5` |
| Queueing beyond the limit | Raising `--parallel` without a matching batch-size increase "just spreads the same throughput across more queues; latency goes up, aggregate tokens/sec does not" | `INTERNAL: TASK-824 §6`, consistent with general llama.cpp continuous-batching behavior |
| TTL / auto-unload | Idle TTL default **60 minutes** for JIT-loaded models; resets on every request; configurable per-request (`{"model":..., "ttl":300}` on REST JIT-load), via CLI (`lms load <model> --ttl 3600`), or as an app-level default. Auto-Evict (on by default) unloads the previous model when a new one JIT-loads, capping resident models at one unless disabled | [Idle TTL and Auto-Evict](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict) |
| JIT loading | On by default; **there is no documented or CLI/API way to turn it off headlessly** — `INTERNAL:` confirmed by reading the full `lms` subcommand tree, no JIT toggle exists anywhere | `INTERNAL: TASK-824 §4.3, §10B finding 5` |
| Context length | Set per-load: CLI `lms load -c <n>` or REST `POST /api/v1/models/load {context_length}`. **Caution, carried over from the sibling llama.cpp lane and worth re-verifying on `llmster` specifically:** in llama.cpp's own server, `--ctx-size` is the **total** KV budget divided across `--parallel` slots (`n_slots=4` + `-c 2048` → `n_ctx_slot=512`, not 2048 per sequence) — getting this backwards silently truncates every concurrent sequence. `INTERNAL: TASK-824 §2A.7` measured this on `llama-server` directly; **whether `lms load -c <n>` combined with `--parallel` divides identically is UNVERIFIED for `llmster`** specifically and should be measured before sizing contexts for concurrent load |
| Health endpoint | **Undocumented but real:** `GET /lmstudio-greeting` → `{"lmstudio": true}`. **Every other/unknown path also returns HTTP 200** (`{"error":"Unexpected endpoint or method..."}`) — so a Kubernetes `httpGet` liveness/readiness probe can never fail on this server; the probe **must** be an `exec` (or an HTTP probe with response-body inspection outside plain kubelet `httpGet`, which cannot inspect bodies) that checks **both** status 200 **and** the literal body `"lmstudio":true` | `INTERNAL:` measured directly (also matches a filed vendor bug referenced in the internal ticket, `lms` #1323 — not independently re-confirmed by me against the tracker, but consistent with direct observation) |
| Readiness (model loaded, not just process up) | `/v1/models` and `/api/v1/models` **list every model on disk regardless of load state** when JIT is on (which it always is, headlessly) — **unusable alone as a readiness signal**. The correct signal is `GET /api/v1/models` → the specific model's `loaded_instances[]` being non-empty, made reliable by always loading with a stable `--identifier` so the probe can grep for it | `INTERNAL: TASK-824 §4.3, §10B finding 5` |
| Metrics | **`GET /metrics` returns HTTP 200 with `{"error":"Unexpected endpoint or method"}` — there is no Prometheus (or any) metrics endpoint.** This is a genuine, confirmed observability regression versus llama.cpp's own server (which exposes `/metrics` and `/slots`) and versus vLLM. No scrape annotations should be added to a Deployment for this workload — they would imply a signal that does not exist | `INTERNAL:` measured directly; not found documented anywhere in vendor docs either (absence corroborates) |
| Auth | Native REST docs describe a bearer-token requirement, but **no headless token-minting path exists** (`lms/src` has zero hits for `apiToken\|requireAuth\|createToken\|bearer`); tokens are GUI-only. **Network policy is therefore the only real enforcement boundary for a headless deployment, not defence-in-depth on top of app-level auth** | `INTERNAL: TASK-824 §5 L-1` |

**Sources:** [Idle TTL and Auto-Evict](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict) ·
[Parallel Requests](https://lmstudio.ai/docs/app/advanced/parallel-requests) ·
[lms runtime docs](https://lmstudio.ai/docs/cli/runtime/runtime) (for the general CLI-surface
completeness check underlying several "no such command" findings above)

---

### Q7 — Fitness verdict vs vLLM (MLflow-backed, per `docs/research/ai-ml/mlflow-vllm-minio-onprem-inference-2026-09.md`)

The platform's own recent, *measured* research
(`INTERNAL: docs/research/ai-ml/mlflow-vllm-minio-onprem-inference-2026-09.md`, dated 2026-09-01 —
today) already settled the piece of this question that matters most and makes the verdict
unambiguous rather than a judgment call:

> **vLLM 0.28.0's CUDA build has NO GGUF support at all** — `gguf` is absent from all 30 registered
> quantization methods, no `gguf` quantization module exists in the package, and the `gguf` PyPI
> package is not installed. Measured directly in the image, not inferred from docs.
> `INTERNAL: mlflow-vllm-minio-onprem-inference-2026-09.md §5.1`, and independently re-confirmed
> in `TASK-835-S3-Mounted-Model-Store §4.3` on the actual target catalogue.

This means, on HOPE's real GPU path (CUDA, VM 200, RTX 2000 Ada 16 GB cards), **vLLM and LM Studio
are not substitutable for the same model file** — vLLM needs safetensors (optionally AWQ/FP8/etc.),
LM Studio needs GGUF. The "which serves what" question is therefore mostly answered by which
*format* a given model ships in, not by a throughput preference alone.

Externally, the throughput gap where formats do overlap is large and consistent across sources:
vLLM's PagedAttention + continuous batching is reported at **roughly 7–20x LM Studio/Ollama's
aggregate throughput above ~8 concurrent users**
([vLLM vs Ollama vs LM Studio 2026 benchmark](https://codersera.com/blog/vllm-vs-ollama-vs-lm-studio-production-2026/);
[BIZON inference engine comparison](https://bizon-tech.com/blog/best-llm-inference-engines)), and
"LM Studio does not support continuous batching" is stated flatly by more than one 2026 comparison
— LM Studio's own docs actually contradict the flat "no continuous batching" claim (0.4.0 added
it), but the *magnitude* gap is corroborated by `INTERNAL: TASK-824 §6`'s own citation of the same
"7–12x above ~8 concurrent users" range, independently arrived at.

| | **LM Studio (`llmster`) should own** | **vLLM should own** |
|---|---|---|
| Model format | The broad GGUF/llama.cpp quantization ecosystem — the long tail of community-quantized models, and anything that must fit small (16 GB) GPUs or run CPU-only | safetensors / AWQ / FP8 — purpose-quantized models with a real serving recipe |
| Traffic tier | Secondary / evaluation tier; low-to-moderate concurrency (single-digit to low-teens concurrent generations before p95 degrades, per measured `n_parallel` behavior) | Primary tier for clinical/production traffic; the platform's `LEAST_BUSY` routing target of 20–40 in-flight requests |
| Licensing posture | **Accepted risk, not a clean bill of health** — ToS forbids SaaS/service-bureau use; MIT-equivalent freedom does not apply | Apache-2.0 — no usage-model restriction of any kind |
| Registry / promotion | Not modeled by MLflow today in either the internal doc or LM Studio's own tooling — model selection stays in HOPE's own `AiModel`/`AiTaskDefault` tables either way | MLflow as **control plane only** (which weights, which version is `champion`, lineage/eval audit) — **never in the token request path**, per the internal doc's own measured ~110x proxy-bottleneck finding |
| Ops maturity | Weaker: no metrics endpoint, no headless auth, readiness needs a workaround, HTTP-only introspection cannot detect a silent CPU fallback | Stronger: `/health` (503-while-loading → 200-ready, the textbook k8s pattern), documented driver/toolkit requirements, and (per the internal doc) established S3-streaming load patterns (`--load-format runai_streamer`) |
| Where it fails outright | Anything needing vLLM-class throughput under real concurrent clinical load | **Anything that only exists as a GGUF** — vLLM cannot load it at all on the CUDA path today |

**Bottom line:** the owner's actual decision — LM Studio *and* vLLM, LM Studio explicitly as the
secondary/eval tier, never the primary candidate under `LEAST_BUSY` routing — is well-supported by
both the external comparisons and, more decisively, by HOPE's own measurement that the two engines
currently serve **disjoint model catalogues by format**, not overlapping ones. This isn't really a
"pick one" question at HOPE's current state; it's "which format is this specific model in," with
LM Studio picking up everything vLLM structurally cannot load.

**Sources:** [vLLM vs Ollama vs LM Studio 2026](https://codersera.com/blog/vllm-vs-ollama-vs-lm-studio-production-2026/) ·
[Local LLM Deployment comparison](https://www.sitepoint.com/local-llm-deployment-ollama-vs-vllm-vs-lm-studio-compared/) ·
[BIZON inference engine comparison](https://bizon-tech.com/blog/best-llm-inference-engines) ·
`INTERNAL: docs/research/ai-ml/mlflow-vllm-minio-onprem-inference-2026-09.md` (primary evidence —
measured on this platform, strictly stronger than the external throughput comparisons for the
format-compatibility half of this question)

---

## 2. Return-contract summary

### A. Headless + licensing verdict

**Technically:** yes, cleanly — `llmster` is a purpose-built, GUI-free daemon; the CLI/systemd
story is well-documented and HOPE's own image already implements it correctly (pinned bundle,
non-root, tini PID 1, engine baked in, exec-based health checks).

**Legally:** conditionally, under an *explicitly accepted* risk, not a resolved one. The current
[App Terms of Service](https://lmstudio.ai/app-terms) (effective 2026-08-23) restrict use to
"personal and/or internal business purposes" and explicitly name "service bureau use, as an
application service provider, or a software-as-a-service" as prohibited. HOPE is a multi-tenant
SaaS healthcare platform — the prohibited category by name. The 2025 "free for work" change
([blog post](https://lmstudio.ai/blog/free-for-work)) removed the need for a *commercial license
to use the app internally*; it did not publish any carve-out for embedding LM Studio as a hosted
product's own inference backend. `INTERNAL:` HOPE's owner has already made the call to accept this
risk (TASK-824 §1) and mitigated the sharper, independent problem (a proprietary binary with no
redistribution right) by keeping the built image in a private registry only. **Recommendation:**
keep the risk acceptance on record, revisit it with counsel as tenant/usage scale grows rather than
treating the 2026-08-30 sign-off as permanent, and do not let the image or its weights leave the
private registry under any circumstance.

### B. Image strategy

One image, two backends, via LM Studio's own runtime-extension mechanism (`lms runtime
ls/get/select`) — the `full+cuda12` Linux x64 bundle ships **both** a CPU and a CUDA llama.cpp
engine on disk; the entrypoint selects the right one and asserts a GPU is present before serving.
Base: `nvidia/cuda:12.8.1-runtime-ubuntu24.04` (CUDA userspace libraries install fine with no GPU
attached, which is what makes this buildable on a GPU-less CI runner). Fetch the bundle by pinned
URL + SHA-512, never `curl install.sh | bash` (it silently downgrades to a CPU-only bundle on any
GPU-less build host). Size: official CPU preview is ~370–400 MB; a CUDA-based build will be low
single-digit GB (unmeasured precisely — get the number from CI, not a local build). **HOPE already
has this image built** at `infrastructure/docker/lmstudio/`, CI-gated, currently blocked on
operational items (MinIO credentials, model manifest population, k3s NetworkPolicy re-verification
on the real CNI) rather than the image design itself — see the Dockerfile skeleton and entrypoint
notes in §Q2 above for the reviewable shape.

### C. Endpoint table

See §Q3 above for the full table. Three surfaces exist: native v0 (legacy, richest metadata),
native v1 (current, Responses-API-shaped — **not** OpenAI chat-completions compatible), and the
OpenAI-compatible layer (`/v1/models`, `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`,
`/v1/responses`) — **use the OpenAI-compatible layer for the inference path**, per the task's
requirement. Watch for the added `stats` object (sometimes empty even there), `reasoning_content`
siphoning off `content` for reasoning models, and the fact that every path returns HTTP 200
regardless of validity.

### D. Model-store ranking

1. **Out-of-band sync to a PVC** (`s5cmd`/`mc mirror` → checksum verify → `lms import -y -L` →
   `.ready` sentinel) — recommended, and what HOPE has already built. Avoids the S3-mount's
   write-semantics limitation entirely.
2. `mountpoint-s3` CSI, read-only mount — best measured throughput (376 MB/s seq, 9–15 ms random
   page-in) of the live-mount options, no extra container, `mmap()` confirmed working via genuine
   range GETs.
3. `s3fs` sidecar mount — comparable, slightly better egress efficiency (1.07x vs 1.53x), needs a
   privileged sidecar.
4. JuiceFS — unmeasured here; consider only if real multi-writer POSIX semantics become a
   requirement.
5. `rclone mount` — unmeasured here, externally reported as the slowest of the common FUSE options.

**mmap/GGUF caveat, quantified:** measured on this platform's own 3.35 GB GGUF, `mmap()` works
correctly over both FUSE options tested (contrary to common external folklore) and triggers real
HTTP range GETs on page fault — 7–56 ms per random page-in versus microseconds for warm local
NVMe. That gap is the practical argument for the PVC-sync design over a live mount when TTL-based
auto-unload/JIT-reload is in play, since a reloaded model on a live mount pays that latency tax
repeatedly on cold pages.

### E. SDK vs REST

**REST-only**, for both the inference path and the admin/model-management plane. The
`lmstudio-python` SDK's genuinely useful features (`.act()`, structured output, streaming
load/download progress) are real but ride over WebSocket RPC, not HTTP, which does not fit
`apps/text`'s existing `httpx.AsyncClient` + OpenAI-compatible-adapter architecture, would
duplicate provider-agnostic tool-calling capability the platform already has at a higher layer, and
would introduce a second, LM-Studio-specific client transport for one provider only —
directly against `06-python-services.md`'s rule against growing a second inference stack. Close
REST's admin-plane gaps (import, runtime survey, delete) with a narrow `exec lms ...` escape hatch
instead, as HOPE's own ticket already recommends.

### F. Ops table

| | Value / mechanism |
|---|---|
| Readiness probe | `exec`: `GET /api/v1/models`, grep for the loaded model's `loaded_instances[]` non-empty (an `httpGet` probe cannot work — every path returns 200) |
| Liveness probe | `exec`: `curl .../lmstudio-greeting`, grep for `"lmstudio":true` in the body, not just status 200 |
| Concurrency | `n_parallel` default 4, continuous batching since 0.4.0, set via `lms load --parallel` only (not REST) |
| TTL / auto-unload | 60 min default idle TTL for JIT models, configurable per-load (CLI/REST), resets per request |
| JIT loading | Always on headlessly — no documented off-switch |
| Metrics | **None.** `/metrics` returns 200 with an error body — do not add Prometheus scrape config for this workload |
| Auth | No headless token-minting path exists; NetworkPolicy is the sole enforcement boundary, not defence-in-depth |

### G. LM Studio vs vLLM — should-own table

See §Q7 above. Short version: they currently serve **disjoint catalogues by model format** on this
platform (vLLM's CUDA build cannot load GGUF at all, measured) — LM Studio owns the broad
GGUF/quantized/small-GPU ecosystem as a secondary/eval tier; vLLM owns primary clinical-traffic
throughput for safetensors/AWQ/FP8 models, with MLflow as its control-plane-only registry.

### H. Top 5 risks, each with a mitigation

1. **Licensing: HOPE is exactly the use case ("SaaS", "service bureau") the ToS names as
   prohibited.** *Mitigation:* keep this as a standing, periodically-revisited risk acceptance with
   legal/compliance, not a one-time sign-off; never let the built image or model weights leave the
   private registry; be ready to fall back to the documented escape hatch
   (`ghcr.io/ggml-org/llama.cpp:server-cuda`, MIT-licensed, same llama.cpp engine underneath) if the
   posture changes — `INTERNAL:` HOPE already has this escape hatch built and documented at
   `docs/implementation/TASK-824-LM-Studio-Service/image/`.
2. **No metrics endpoint — flying blind on token throughput, queue depth, and KV-cache pressure in
   production.** *Mitigation:* derive weak proxy signals from the REST surface that does exist
   (`stats.tokens_per_second`/`time_to_first_token` per response, `loaded_instances[].config` for
   resident state) and log/aggregate them application-side; do not claim Prometheus parity with
   vLLM for this workload in any dashboard or SLO.
3. **Silent CPU fallback is invisible over HTTP.** The bundle ships both engines and defaults to
   CPU; `/api/v1/models` reports weights format (`gguf`), not accelerator, and no HTTP path exposes
   the active runtime. *Mitigation:* the three-layer defense HOPE's image already implements —
   pinned-SHA512 build-time fetch, a CI job that asserts the filesystem contains a CUDA engine, and
   an entrypoint that explicitly `lms runtime select`s the CUDA engine and asserts GPU presence
   before serving (exit non-zero / refuse to start otherwise). Surface the active runtime in the
   admin console via a CLI-exec probe, not an HTTP one.
4. **No headless authentication.** Any pod that can reach the service port has full, unauthenticated
   access. *Mitigation:* NetworkPolicy restricted to the exact caller set (currently `apps/text` and
   the harness workers, per HOPE's already-shipped policy) must be treated as the *only* security
   boundary, and any change that widens it or exposes the port more broadly is a security review
   item, not a routine config change.
5. **Every HTTP path returns 200, including nonexistent ones.** *Mitigation:* never write a health
   check, monitoring alert, or client error-handling path for this service that trusts a 200 status
   code alone; always assert the response body shape. This applies to the k8s probes (§F) and to
   any adapter code in `apps/text`/`packages` that talks to it.

---

## 3. Notes on verification gaps

- I could not independently re-confirm `lmstudio-ai/lms` bug tracker issue #1323 (the "200 for
  unknown paths" bug) against the live tracker — I relied on the internal ticket's citation of it
  plus my own direct, repeated observation of the same behavior described in the fetched docs
  content and search results. Treat the *behavior* as confirmed (directly observed), the *specific
  bug-tracker number* as UNVERIFIED by me independently.
- Whether `lms load -c <n>` combined with `--parallel` divides context length the same way
  `llama-server`'s `--ctx-size`/`--parallel` does (total budget divided across slots, not per-slot)
  is UNVERIFIED specifically for `llmster` — the internal measurement that established this
  division behavior was done on `llama-server`, a related but different binary. Verify before
  sizing contexts for concurrent production load.
- I did not find a published LM Studio statement that resolves the SaaS/service-bureau licensing
  tension either way for a company embedding LM Studio in its own multi-tenant product; I searched
  specifically for one and did not find it. This is stated as UNVERIFIED rather than resolved in
  either direction, deliberately.
- Final image size for the CUDA-based build is unmeasured by me (I did not build it, per the CI-only
  constraint) — get the real number from the next successful `build-lmstudio` CI pipeline.
- The exact CUDA minor version linked by the `full+cuda12` bundle (12 vs 13) was flagged as an open
  item in the internal ticket (arm64 dev bundle showed a `cuda13`-named engine despite the `+cuda12`
  artifact name) — I did not independently re-verify this; treat `INTERNAL: TASK-824` open item
  OI-4 as still open.
