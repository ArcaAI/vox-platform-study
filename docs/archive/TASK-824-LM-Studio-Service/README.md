# TASK-824 — LM Studio headless as a containerized service

| | |
|---|---|
| **Status** | **In Progress — the build failure was a WRONG PROBE, not a bad bundle (§12.1).** `build-lmstudio` failed at `Dockerfile:107` (pipeline **1030**, job **15218**) because it asserted with `lms runtime ls`, which enumerates runtimes **the host can run** and so lists nothing on a GPU-less runner. That same job's evidence dump shows `extensions/backends/` already holds `llama.cpp-linux-x86_64-avx2` (CPU), `…-vulkan-avx2`, and `…-nvidia-cuda12-avx2` — **the CUDA engine was baked in all along**. The build now asserts the filesystem inventory and requires BOTH a CPU and a CUDA engine (owner requirement 2026-08-31); the accelerator check that genuinely needs hardware stays in `entrypoint.sh` A-2. Engine still DECIDED (§0: LM Studio + vLLM); manifests committed, `hope-lmstudio` live at `replicas: 0`; **OPEN-824-HARNESS is RESOLVED by widening** (`82c63a6ff`). Still blocked on R-2, R-3, R-5 — R-1 (the private CA) is CANCELLED by owner decision |
| **Type** | infrastructure |
| **Branch** | `dev-2.2` |
| **Depends on** | MinIO model-artifact bucket (`hope-models` already exists, `docker-compose.yml:145`); objects not yet mirrored |
| **Feeds** | TASK-818 (router) — the GGUF serving tier |
| **Related** | **TASK-831 (model catalogue — inverted the engine priority)**, TASK-823 (vLLM), TASK-822 (MLflow), TASK-828 §4b (MinIO on the LAN) |

> **⚠️ READ §0 FIRST, THEN §10B.** The engine question is CLOSED: **LM Studio
> (`llmster`) + vLLM**, by owner decision on 2026-08-30. §2A's `llama-server`
> recommendation was made, considered and **overruled**; it is retained below as
> the record of the argument, not as the plan. **Do not re-open the comparison
> and do not initialise a llama.cpp server.**
>
> §4–§5 are the llmster build spec and are LIVE. Where §10B's measurements
> contradict them — §4.7's wait-loop, §4.10's "no rescan", §4.3's readiness
> design — **§10B is correct and the shipped artifacts follow it.**

## 0. ✅ OWNER DECISION 2026-08-30 — LM Studio, not llama.cpp

**The owner has decided: LM Studio server + vLLM service. Do not initialise a
llama.cpp server.** §2A's recommendation was made, considered and **overruled**. It is
retained below as the record of the argument, not as the plan.

**This ticket therefore builds the custom headless `llmster` GPU image (§4).**

### Risks accepted by this decision, stated once and then not re-argued

| # | Risk | Consequence |
|---|---|---|
| **A-1** | **LM Studio audio support is UNVERIFIED-NEGATIVE**, and Gemma 4 E2B/E4B are vision **and audio** | If audio matters clinically, it must be verified early. A model that serves text and vision but silently not audio is the failure this flags |
| **A-2** | **The no-rescan hazard returns** (§4.10). LM Studio has no rescan API or CLI — established three ways | A GGUF synced onto the volume is **not** visible. The sync MUST call `lms import … -y -L` (`-L`/`-c` mandatory: import **moves** by default) |
| **A-3** | **The silent-CPU-fallback returns** (§4.1) | `install.sh` picks the `+cuda12` bundle from the **build host's** `nvidia-smi`. A GPU-less CI runner yields a CPU-only image that starts, serves and answers — silently. Fetch the pinned `+cuda12` tarball by URL with a verified SHA-512 |
| **A-4** | Auth cannot be minted headlessly | Tokens are GUI-only, so **NetworkPolicy is the only enforcement point** (§5 L-1) — not defence in depth |
| **A-5** | ToS + private-registry constraint | The image embeds a proprietary binary; **internal registry only** |
| **A-6** | Readiness is weaker | `/lmstudio-greeting` proves *server up*, not *model loaded*, and LM Studio returns **200 for unknown paths**, so a path probe always passes |

### What carries over from the llama.cpp work regardless

- **The catalogue and co-tenancy plan** (TASK-831) are engine-independent.
- **The MinIO layout** — `s3://hope-models/<slug>/<version>/`, `SHA256SUMS`-verified (TASK-832).
- ⚠️ **The provider trap still applies:** `provider: 'llama-cpp'` in the catalogue selects `LlamaCppProvider`'s raw `/completion` path — no chat template, no image or audio parts. **Multimodal models stay on `'lm-studio'`.**
- **vLLM stays at `replicas: 0`.** It cannot serve this catalogue — GGUF is deprecated in-tree (RFC #39583) and its Gemma 4 recipe needs 24 GB+ against 16 GiB cards. It remains the tier for future AWQ/FP8 models.

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

## 2A. ENGINE DECISION — I recommend `llama-server`, not the `llmster` image

**Status: RECOMMENDATION, awaiting owner. Nothing here is a unilateral switch.**
§2 above records the owner's 2026-08-29 decision to build a custom headless
`llmster` image. That decision was made **before TASK-831 existed**. TASK-831
landed 2026-08-30 and changed three of the inputs it rested on. This section
states the recommendation and its evidence; the ticket's §4–§5 llmster build
spec is left intact and un-edited so the owner can weigh both.

> **Recommendation: serve the catalogue with `ghcr.io/ggml-org/llama.cpp:server-cuda-b9853`,
> digest-pinned, in a thin local layer. Retire the `llmster` build.**

### 2A.1 What changed since the decision was made

| Input the decision rested on | What TASK-831 established |
|---|---|
| The catalogue is text LLMs | **Two headline models are vision + AUDIO.** The Gemma 4 projectors carry BOTH encoders — verified by parsing the GGUF headers: `clip.has_vision_encoder = True`, `clip.has_audio_encoder = True`, `gemma4v` + `gemma4a`, BF16 |
| LM Studio serves the catalogue | **LM Studio audio is UNVERIFIED-negative** — no badge, no changelog entry, docs say only *"Chat Completions (text and images)"*. §4.1's own conclusion: *"If the audio path is required, LM Studio should be considered out and llama.cpp used directly."* |
| llama.cpp is the escape hatch (§2) | It is now the **only** engine that can serve the catalogue at all — vLLM deprecated in-tree GGUF (RFC #39583, ~0.1% usage) and its Gemma 4 recipe needs **24 GB+** against **15.99 GiB** cards |

### 2A.2 The case, in order of weight

**1. Audio.** Buying a serving tier that cannot use half of what the projector
ships is the whole argument. Everything below is corroboration.

> **Verified, and honestly qualified.** Loading Gemma 4 E2B with `--mmproj` makes
> `GET /props` report `modalities: {"vision":true,"video":true,"audio":true}`, and
> the log confirms `loaded multimodal model` — so llama.cpp genuinely activates the
> audio encoder. **But llama.cpp itself warns at load:**
> `W init_audio: audio input is in experimental stage and may have reduced quality`,
> and **no audio clip was actually inferenced in this lane** (vision was — a
> known-answer smoke test passed). So the honest comparison is *"an engine with
> audio support it labels experimental"* versus *"an engine with no evidence of
> audio support"* — still decisive, but not "solved". TASK-831 §8's audio smoke
> test remains a prerequisite for clinical traffic.

**2. The entire §4.10 problem class disappears.** §4.10 is the ticket's largest
hazard and it was established three independent ways: **there is no rescan API
and no rescan CLI**, so a GGUF dropped on the volume is simply not visible;
`lms import` **moves** by default (`-L`/`-c` mandatory); the
`<publisher>/<model>/` tree is mandatory; and bug #844 ("models missing until
the application is restarted") is open. None of it exists here. `llama-server`
is told `--model /path/file.gguf`. **And router mode has the rescan LM Studio
lacks** — verified: `GET /models?reload=1` re-reads the preset file, plus
`POST /models/load` and `/models/unload`.

**3. Health.** §4.3 needs JIT-off + preload + `/v1/models`, or an exec of
`lms ps`; §4.11 records that LM Studio **returns 200 for unknown paths**
(bug #1323) so a generic probe always passes, *including against a broken
server*. `llama-server`'s `GET /health` is 503 while loading, 200 when ready —
the ticket itself calls this *"the ideal readiness gate"*. **Verified.**

**4. The §4.1 CPU-fallback trap is structurally absent.** §4.1 named
`curl install.sh | bash` *"the highest-probability failure in this ticket"*:
it probes the **build** host for `nvidia-smi` and silently ships a CPU-only
image. With an official `-cuda` tag the accelerator is in the tag and frozen in
the digest — there is no build-host probe to get wrong. §8.4's consequence
(a CPU-only deployment "cannot be detected over HTTP", needing an exec of
`lms runtime survey --json`) also dissolves: **verified**, `GET /props` returns
`build_info: "b9853-7af4279f4"` and `modalities: {vision, video, audio}` over
plain HTTP.

**5. Licensing.** §1 records the LM Studio ToS restricting *"service bureau use,
as an application service provider, or a software-as-a-service"*, accepted as
owner risk, and forcing a **private-registry-only** image (L-2) because we hold
no redistribution right. llama.cpp is **MIT**. Both the risk and the
distribution constraint disappear. On a healthcare platform this is not a
rounding error.

**6. Auth becomes real.** §5 L-1 had to declare the NetworkPolicy *"the ONLY
enforcement point, not defence in depth"* because LM Studio has **no headless
way to mint a token** — grepping `lms/src` for
`apiToken|requireAuth|createToken|bearer` returns zero hits. `llama-server` has
`--api-key` and `--api-key-file` (**verified in `--help`**), so the
NetworkPolicy returns to being defence in depth.

**7. Most of §4.9's twelve UNVERIFIED items evaporate.** They are almost all
LM Studio-specific: bug #2093 (`$HOME` ignored as non-root), whether
`settings.json{downloadsFolder}` is honoured before first daemon start, the
first-run EULA/telemetry call under blocked egress, the `lms runtime` alias, the
`--parallel`-plus-REST-knobs asymmetry. Shipping a decision that depends on
twelve open unknowns is the expensive part, not the image build.

### 2A.3 What LM Studio wins — recorded, not buried

- **Console richness.** `openai_compat.py:410` enriches listings from LM
  Studio's native `/api/v0/models` with `state`, `quantization` and
  `max_context_length`. llama-server answers 404 there, so the
  `DiscoveryDrawer` shows less per-model metadata. **Verified safe, not
  broken**: that helper documents *"ANY failure returns `{}`: enrichment is
  strictly best-effort and must never degrade or fail the `/v1/models`
  listing"*, and a non-200 returns `{}` before parsing. Partial mitigation:
  llama-server's `/props` and `/v1/models` still carry the build, the alias,
  modalities and `n_ctx`.
- **Projector auto-pairing.** LM Studio pairs any mmproj in the model folder
  (issue #1760, with no opt-out). llama-server needs `--mmproj` explicitly —
  but it then **fails loudly**, which is the safer failure, and the entrypoint
  here refuses to boot without it.
- **One process, many models, natively.** llama-server's equivalent is router
  mode, which self-reports as experimental (§2A.4).

### 2A.4 The one genuine cost: router mode is experimental

llama-server prints at every startup:

```
NOTE: router mode is experimental
      it is not recommended to use this mode in untrusted environments
```

Router mode is needed because **`AiProviderConnection` is `@@unique([tenantId,
service, provider])`** — the SYSTEM tenant gets exactly ONE baseUrl per
`(service, provider)`, and the chat catalogue has three models. Three
single-model servers cannot all be addressed without adding a provider name in
`packages/**`.

Mitigations, and the honest fallback:

- The pod is not in an untrusted environment: NetworkPolicy admits only
  `hope-text` and `prometheus`, and `--api-key-file` adds a credential LM Studio
  cannot have at all.
- The **embedding plane is kept out of router mode** entirely, so the platform's
  embedding path never depends on it.
- If the owner rejects it, the fallback costs **one chat model, not a
  redesign** — see `deployment/README.md` §6.

### 2A.5 What this does NOT change

- **No router code changes**, on either choice. `apps/text` reaches both
  engines through `openai_compat`, whose
  `_LM_STUDIO_PROVIDER_NAMES = frozenset({"lm-studio", "openai_compat"})`
  (`openai_compat.py:37`) already treats the two names as one. The switch is a
  **`baseUrl` on one existing seed row**.
- **`AiModel.provider` stays `'lm-studio'`** on all four rows. This looks wrong
  and is not — see the trap below.
- §3's MinIO artifact plane, §5's security posture, §6's "secondary tier, not
  the primary candidate for clinical traffic under `LEAST_BUSY`", and §7's
  console work all stand. §6's throughput ceiling is llama.cpp's in both cases —
  §6 says so itself: *"the ceiling is llama.cpp's, not LM Studio's."*

> ### ⚠️ The trap this decision creates, stated once
> In the catalogue, **`provider: 'llama-cpp'` does NOT mean "served by
> llama.cpp"**. It selects `LlamaCppProvider`, which posts to the **native
> `/completion`** endpoint — a raw-prompt client (`providers/llama_cpp.py:79`
> `_build_prompt`) that applies **no chat template** and **cannot express image
> or audio content parts**. Tagging a Gemma 4 IT multimodal model `'llama-cpp'`
> loses its chat template *silently* and both modalities *loudly*.
> The multimodal models must stay on `'lm-studio'` — the `openai_compat`
> adapter — even though the server is llama-server.

### 2A.6 Build floor — verified by ancestry, not by build number

TASK-831 §4.1 sets a hard floor of **b9383** (2026-05-28): below it, a projector
pre-norm bug and an audio RMS-norm eps bug produce plausible-but-wrong
multimodal output **with no error**.

Pinned build: **b9853** (2026-07-01), git rev
`7af4279f4579094cbe121cccb3c28357396e55d0`, image digest
`sha256:62a1d4e144789aa3dd6948d350388fd4b9ac4d12744f33213a89c4e5a9af25df`.

Comparing `9853 > 9383` is a proxy. What was actually checked is that each fix
commit is an **ancestor** of the image's revision
(`image/verify-build-floor.py`, re-runnable):

```
image revision : 7af4279f4579094cbe121cccb3c28357396e55d0
committed      : 2026-07-01T05:32:55Z

  PR #21309  PRESENT  behind_by=0    ahead_by=1216  — model: gemma 4 vision support
  PR #21421  PRESENT  behind_by=0    ahead_by=1087  — mtmd: gemma 4 audio conformer encoder support
  PR #23815  PRESENT  behind_by=0    ahead_by=460   — mtmd: gemma 4 audio rms_norm eps 1e-6 (audio correctness)
  PR #23822  PRESENT  behind_by=0    ahead_by=453   — mtmd: gemma 4 projector pre_norm (vision correctness)

PASS — every required multimodal fix is an ancestor of this build.
```

`behind_by=0` on all four is the proof. Note **b9383 is not a published image
tag** (ggml-org publishes only a subset of builds; `server-cuda-b9383` → 404),
so b9853 is the nearest published build past the floor — not an arbitrary bump.

### 2A.7 Two findings that change how the co-tenancy plan is expressed

**(a) `--ctx-size` is the TOTAL KV budget, divided across `--parallel` slots.**
Verified — `-c 2048 -np 4` logs `n_slots = 4, n_ctx_slot = 512`. So TASK-831
§6.4's "~28 sequences @ 8k" is `--parallel 28 --ctx-size 229376`, **not**
`--ctx-size 8192`. Getting this backwards silently truncates every sequence to
`ctx/parallel` tokens. Every preset in `deployment/llama-cpp.yaml` is written as
`parallel × per-seq` for this reason.

**(b) The per-card placement plan is not implementable, by either engine.**
TASK-831 §6.4 caveat 1 already says so — time-slicing hands out fungible
permits and nothing pins a model to a card. This is a property of the hardware
(no MIG/MPS/vGPU, §6.1), not of the engine choice. What *is* controllable is
**total residency**, which `--models-max 2` plus the per-model context caps
bound. Both Deployments therefore ship at `replicas: 0` pending an actual
`nvidia-smi` reading, per §6.4 caveat 2 ("Measure before trusting").

### 2A.8 The decision requested

1. **Accept `llama-server` and retire the `llmster` build** (recommended), or
   direct that §4's llmster image be built anyway — in which case the audio
   modality is out of scope until LM Studio audio support is *positively*
   verified, and §4.9's twelve unknowns must be closed first.
2. **Accept router mode**, or take the fallback in `deployment/README.md` §6
   (one Gemma 4 + Granite Guardian; the second Gemma unreachable).
3. Unchanged and still open from TASK-831 §9: the **embedding transport**
   (§5 — TEI cannot load the GGUF, and `apps/text` has no llama.cpp embeddings
   provider) and whether to **drop `qwen3.5-4B`** (assumed dropped here; it is
   absent from the manifest and presets).

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

## 10A. What this lane actually delivered, and what it proved

**Artifacts** (all staged, nothing applied, nothing committed to `hope-v2-deployment`):

| Path | What |
|---|---|
| `image/Dockerfile` | Thin layer over the digest-pinned upstream CUDA image |
| `image/entrypoint.sh` | Boot assertions (ready sentinel, `--mmproj`, `/props` verification) |
| `image/verify-build-floor.py` | Proves the b9383 floor by COMMIT ANCESTRY |
| `deployment/llama-cpp.yaml` | 13 objects: 2 Deployments + 2 Services + presets CM + 4 NetworkPolicies + 2 HPA + 2 PDB |
| `deployment/model-sync.yaml` | PVC + manifest/script ConfigMap + PreSync Job |
| `deployment/verify-manifest.py` | TSV↔JSON consistency + live-HuggingFace digest re-check |
| `deployment/config/llama-cpp.env` | configMapGenerator input (deliberately near-empty) |
| `deployment/README.md` | Handover, ROOT_CONFIG_REQUESTS, seed-row spec, fallback |
| `infrastructure/docker/docker-compose.dev.yml` | New opt-in `gguf` profile (2 services) |

### Proven by execution (CPU image — same binary and build as the CUDA image)

| Claim | Evidence |
|---|---|
| Build floor met | 4/4 fix PRs `behind_by=0` against `7af4279f…` |
| Provenance record is honest | `models.tsv` and `upstream.json` name the same 4 slugs; all 6 recorded digests match the live HF blobs; total **14.79 GiB**, matching TASK-831 §6.3 exactly |
| Image builds + runs non-root | `docker build` OK; UID 10001 |
| Sentinel gate works | Missing `/models/.ready` → **exit 78**, refuses to serve |
| `--mmproj` gate works | `HOPE_EXPECT_MODALITIES` set + no `--mmproj` → **exit 78** |
| Readiness gate is real | `/health` **503 `{"error":{"message":"Loading model"}}` at t+0.02s → 200 `{"status":"ok"}` at t+1.68s** on a cold 3.12 GiB load |
| Build assertable over HTTP | `/props` → `build_info: "b9853-7af4279f4"` |
| Projector state assertable over HTTP | `/props` → `modalities: {vision,video,audio}` |
| **`-m` does NOT auto-pair the projector** | Gemma 4 E2B loaded with `-m` alone reports `modalities: {"vision":false,"audio":false}` — a TEXT-ONLY server, exactly as TASK-831 §4.1 condition 2 warns |
| **`--mmproj` activates BOTH modalities** | Same model + `--mmproj` → `modalities: {"vision":true,"video":true,"audio":true}`, and the log confirms `load_model: loaded multimodal model`. This is the load-bearing verification for §2A: **llama.cpp genuinely serves Gemma 4 AUDIO**, the capability LM Studio has no evidence of |
| **Real VISION inference, known answer** | A solid-red 224×224 PNG + *"What colour fills this image? Answer with one word."* → **`content: 'Red'`**, `finish_reason: stop`, with `reasoning_content` showing genuine image analysis (*"The image is a solid, vibrant red color"*). 15.1s on arm64 CPU. This is one half of TASK-831 §8's required per-modality smoke test |
| Alias solves the §7.4 trap | `--alias` → `/v1/models` `id` is exactly the string given |
| Chat + template work | Gemma 4 E2B chat completion generated; template applied from the GGUF |
| Embeddings work | 768-dim, **L2 = 1.000000**, `/v1/embeddings` |
| Router mode works | Preset section name becomes the served id; `unloaded` → request → `loaded` |
| Sync works | `sync.sh` unmodified in `minio/mc` against live MinIO, on TASK-832's `<slug>/<version>/` layout: mirror → `sha256sum -c SHA256SUMS` → flatten → `.ready` |
| **Sync fails CLOSED, 3 ways** | corrupted `SHA256SUMS` → `CHECKSUM MISMATCH`; missing `SHA256SUMS` → `refusing to trust this prefix`; unfilled version → `FATAL … version is unset`. **All three: exit 1, `.ready` absent.** The positive control in between returns exit 0 with `.ready` present |
| Compose is valid + opt-in | Full stack validates with every profile; `gguf` absent from the default profile |

### Bugs found by RUNNING the artifacts, not by reviewing them

1. `done < <(...)` — bash process substitution in a script the Job runs with `/bin/sh` (BusyBox ash). Syntax error at runtime. Rewritten POSIX.
2. **`minio/mc` ships no `jq`** and no package manager to add one. The script died on `jq: command not found`. Resolved for good by the reconciliation below: the sync verifies against the prefix's plain-text `SHA256SUMS`, so no JSON is parsed at sync time at all.
3. A `jq | while read` pipeline would have run the loop body in a SUBSHELL, silently discarding `fail=1` — a checksum mismatch would have reported success. The loop reads from a redirected file.

### Reconciled mid-lane with TASK-832

TASK-832 ("MinIO goes internal — and the bootstrap script was silently broken")
landed on `dev-2.2` while this work was in flight and made
`infrastructure/docker/minio/README.md` **authoritative** for the `hope-models`
bucket. Merging it in changed this lane's design, correctly:

- An earlier draft carried its own `<publisher>/<repo>/<quant>/` keys, inherited
  from **§3.1 — a shape chosen because *LM Studio* resolves models from a
  `<publisher>/<model>/` directory tree.** That constraint died with §2A's engine
  recommendation, and TASK-832's `<slug>/<version>/` layout supersedes it.
- `<version>` is **content-addressed** (`<quant>-<sha256-12>` of `manifest.json`),
  so it cannot be a constant in a manifest — it is an input, and the Job **fails
  closed on the placeholder** rather than syncing a different model silently.
- Digests are **no longer duplicated** into this repo. The sync verifies against
  each prefix's own `SHA256SUMS`, keeping one source of truth; `upstream.json`
  remains only as the publisher's pre-upload provenance record (§5.5 step 0).
- The Job now uses the least-privilege `hope-models-reader` credential
  (no `DeleteObject`) rather than root, and drops the `mc certs/CAs/` mount —
  TASK-832 states plainly that `mc` reads `SSL_CERT_FILE` and that path does not work.

Had this lane finished without merging, it would have shipped a bucket layout
that no longer exists.

A fourth was found the hard way, and is worth recording because it is the exact hazard the sync
Job exists to catch: a repeatedly-resumed `curl` of the E2B projector produced a
**1,227,764,480-byte file against an expected 986,833,664** — oversized, and failing sha256.
The size + digest gates rejected it. Corruption from an interrupted transfer is not hypothetical.

### NOT proven — stated plainly

- **No GPU execution of any kind.** This lane ran on an arm64 Mac with no NVIDIA device. GPU
  offload, VRAM residency, the co-tenancy plan and every throughput figure are **unverified**.
  §4.1's silent-CPU-fallback risk is argued to be structurally absent (the accelerator is in the
  tag and the digest); that is an argument, not a measurement.
- **AUDIO inference was never exercised.** Vision was (see above, known-answer smoke test passed);
  audio was not — no audio clip was ever sent through the model. Half of TASK-831 §8's requirement
  therefore still stands: **run a known-transcript audio clip and diff against the HF Transformers
  reference before clinical traffic.** Note Google's card constrains audio to **30 s max**, and
  modality order matters (image before text, audio after text).
- **llama.cpp itself flags audio as experimental.** Verbatim, at projector load:
  `W init_audio: audio input is in experimental stage and may have reduced quality`. This tempers
  §2A's headline argument and is recorded rather than omitted — but the comparison is unchanged:
  llama.cpp has audio support that warns about its quality, LM Studio has no evidence of audio
  support at all.
- **PLE correctness** (TASK-831 §4.1b) — untouched here. Still the most consequential open item,
  and its failure mode is silent quality loss.
- **Router mode under load, or with 3 models resident** — only single- and one-model-router
  configurations were exercised.
- Granite Guardian and Gemma 4 E4B were never downloaded or loaded; their digests are verified
  against HuggingFace but no file was fetched.

## 10B. Phase 2 — the LM Studio (`llmster`) tier, per the §0 owner decision

This is the lane that BUILT the decision in §0. §10A above belongs to the
llama.cpp lane whose recommendation §0 overruled; its artifacts (`image/`,
`deployment/`) are left untouched as the record of that argument and as the
documented escape hatch (§2).

### Artifacts

| Path | What |
|---|---|
| `infrastructure/docker/lmstudio/Dockerfile` | Pinned, SHA-512-verified `+cuda12` bundle on a CUDA runtime base. Non-root uid 10001 |
| `infrastructure/docker/lmstudio/entrypoint.sh` | Eight ordered boot assertions, each fail-closed with exit 78 |
| `infrastructure/docker/lmstudio/.dockerignore` | Context is two files |
| `infrastructure/docker/lmstudio/README.md` | The measured-behaviour record, and what it does/does not cover |
| `.gitlab/ci/build.yml` | `build-lmstudio` + `verify-lmstudio-runtime`; CUDA base added to the warm-up list |
| `deployment-llmster/lmstudio.yaml` | 8 objects: PVC, ConfigMap, PreSync sync Job, Deployment (`replicas: 0`), 2 NetworkPolicies, PDB, HPA. **(Phase 3 makes it 9 / 3 — see §10C)** |
| `deployment-llmster/lmstudio-service-cutover.yaml` | The Service — separated because it is the one outage-capable step |
| `deployment-llmster/audio-smoke-test.sh` | Executable A-1 test. **Not run** |
| `deployment-llmster/README.md` | Handover, R-1..R-7, the `AiProviderConnection` spec, OI-1..OI-6 |

**The image is built by CI only** (owner directive, 2026-08-30). It lives under
`infrastructure/docker/` following the `python-base` / `qdrant-init` convention,
not under this ticket directory, because a CI job needs a real repo path.

### The four traps, and where each is now closed

| Trap | Closed by |
|---|---|
| §4.1 silent CPU bundle | Pinned SHA-512 (build) → `verify-lmstudio-runtime` (CI) → entrypoint A-2 (pod) |
| §4.10 no rescan | Refuted by measurement (see below); replaced by a *verified* publication step that asserts every expected key before serving |
| §4.2 daemon forks and exits | `entrypoint.sh`, holding on `exec lms log stream`, with explicit `--port` AND `--bind` |
| §4.11 liveness | Every probe is an `exec` that greps the body. No `httpGet` probe on this server can ever fail |

### Findings that CORRECT this ticket

Measured against llmster 0.0.23-1 by running the vendor's own binary.

1. **§4.7's wait-loop does not wait.** `lms server status` exits **0 before the
   daemon exists**, so `... && break` breaks on the first iteration. In fact
   *every* `lms` status command exits 0 regardless of the answer, including
   `lms runtime select` on a machine with **no GPU**. Every gate must match
   output text. This is §4.11's HTTP hazard (200 for unknown paths) reappearing
   one layer down in the CLI.

2. **§4.10's conclusion does not hold.** Its three pieces of evidence are each
   correct — no rescan subcommand, no rescan RPC, no docs concept — but the
   inference is not. A GGUF at `<models>/<publisher>/<model>/x.gguf` is indexed
   **at daemon start**, and one dropped there **while the daemon runs** is
   indexed within seconds, with no import and no restart. There is no rescan
   command because the daemon watches the directory. "No rescan API" and "no
   discovery" are different claims, and only the first was evidenced.

3. **A second silent-CPU path §4.1 does not describe.** The bundle ships **both**
   engines and **selects the CPU one by default** (`llama.cpp-linux-arm64` ✓
   alongside `…-nvidia-cuda13`). Shipping the right bundle is necessary but not
   sufficient — without an explicit `lms runtime select` a correct CUDA image
   runs on CPU. There is also a second trigger in `install.sh` itself: a builder
   lacking coreutils `timeout` gets the CPU bundle **even on a GPU host**
   (`install.sh:442`).

4. **`lms import` without `-L` crashes; it does not silently move.** `-y`
   suppresses the warning text but the CLI still opens a TTY prompt and dies
   with `BadResource: ENOTTY: Not a typewriter`, exit 1, nothing imported. `-L`
   remains mandatory, for a different reason than stated. With `-L`: staging
   inode unchanged, link count 1 → 2.

5. **§4.3's readiness design has no headless mechanism.** There is **no JIT
   control anywhere in the CLI**. With JIT on, `/v1/models` lists every model on
   disk regardless of load state, exactly as §4.3 warns. The working signal is
   `/api/v1/models` → per-model `loaded_instances[]`, which is empty for a model
   merely on disk.

6. **The model key comes from the `<model>` segment of `--user-repo`, not the
   filename** — and LM Studio **prepends `text-embedding-`** for embedding
   models. This is the §7.4 `sourceUri` trap made concrete; `imports.tsv` carries
   an expected-key column and the entrypoint asserts it before serving.

7. **Defaults are loopback on a random port** (`{"host":"127.0.0.1","port":41343}`
   in a fresh container), and `~/.lmstudio/.internal/http-server.json` is **not**
   the live serving address — it still read `127.0.0.1:41343` after
   `lms server start --port 1234 --bind 0.0.0.0` succeeded.

8. **LM Studio exposes no metrics endpoint.** `GET /metrics` → 200 with
   `{"error":"Unexpected endpoint or method"}`. A real observability regression
   versus llama.cpp; no scrape annotations were added, because they would imply
   a signal that does not exist.

9. **Bug #2093 not reproduced.** As uid 10001 with `HOME=/home/llmster`, the
   install landed in `/home/llmster/.lmstudio`, and the daemon started, served
   and ran inference from there. See the caveat below.

### NOT proven — stated plainly

- **No image build is claimed.** Per the owner directive of 2026-08-30, CI is the
  only builder; local build results obtained earlier in this lane are
  **discarded as evidence** and no claim rests on them.
- **The measured facts above are from the `linux-arm64` bundle.** They are facts
  about the vendor's CLI and server, retained because several correct this
  ticket. They are **not** evidence about the production artifact, which is
  `linux-x64` + `full+cuda12` on a CUDA base — a different bundle on a different
  architecture. Finding 9 in particular is a property of *our image* and needs
  CI re-confirmation.
- **No GPU execution of any kind.** GPU offload, VRAM residency, throughput, the
  co-tenancy plan, and A-2 firing in its *positive* direction are all unverified.
- **Audio was NOT verified (risk A-1).** `audio-smoke-test.sh` is delivered as an
  executable test, not a result. All evidence gathered is negative or absent:
  the docs say "text and images"; the per-model schema carries
  `capabilities{vision, trained_for_tool_use, reasoning}` with **no audio flag**.
  The script's three outcomes distinguish explicit rejection, working audio, and
  the dangerous middle case — accepted with HTTP 200 but answered from the text
  alone.
- **Whether LM Studio auto-pairs `*-mmproj.gguf` is UNVERIFIED** (OI-1). If it
  does not, vision *and* audio are both silently unavailable, and there is no
  `--mmproj` equivalent on `lms load` or in the REST load body. The smoke test's
  vision control is the discriminator.
- **Which CUDA minor the `+cuda12` bundle links** (OI-4). The arm64 bundle ships a
  **cuda13** engine, so the `nvidia/cuda:12.8.1-runtime-ubuntu24.04` base may be
  the wrong minor. `verify-lmstudio-runtime` prints the engine list on the first
  pipeline.
- **Offline cold start with egress blocked** (§4.9 item 9) is unverified, and
  matters more here than for llama.cpp: LM Studio is closed-source, so its
  first-run telemetry behaviour cannot be read from source.

### Two accepted regressions, named rather than buried

- **No auth at all.** LM Studio has no headless token path, so the ingress
  NetworkPolicy is the *only* enforcement point (§5 L-1, risk A-4) rather than
  defence in depth. Treat any weakening of that rule as a security change.
- **No metrics.** Finding 8.

## 10C. Phase 3 — deployability: no CA, a service account, and real reachability (2026-08-30)

Phase 2 produced manifests that were correct but **could not be applied**: they
required a private-CA ConfigMap that had never existed, and the sync Job could not
start at all. Phase 3 is the pass that made them deployable, driven by three owner
directives.

### Directive 1 — "No CA. At all." (but that is about AUTHENTICATION, not transport)

Every trace of the private "ARCAAI Internal CA" is removed from
`deployment-llmster/`: `SSL_CERT_FILE`, the `/etc/ssl/arcaai/ca.crt` mount and the
`arcaai-internal-ca` volume are gone from the sync Job. **Authentication to MinIO
is a MinIO SERVICE ACCOUNT — an access key and a secret — and nothing else.**
`ROOT_CONFIG_REQUEST R-1` is **CANCELLED and recorded as cancelled**, struck
through in `deployment-llmster/README.md` §3 rather than deleted, so it can be
reinstated verbatim.

**The transport stays `https://`.** MinIO serves TLS on :9000 and one port serves
one scheme, so moving this workload to plain HTTP would have forced pgBackRest,
GitLab, Loki, Tempo, Prometheus and both cloudflared origins to be re-pointed as
collateral. What replaces the CA is **certificate verification turned off at the
client**: `mc --insecure`, on the `config host add` **and** on `mc mirror` inside
`sync.sh` (the flag is evaluated per invocation, not inherited from the alias).

### Directive 2 — PHI hardening is explicitly de-prioritised

Stated so it can be reversed. An unverified TLS connection **encrypts the wire but
does not authenticate the peer**: it defeats passive capture on `10.10.1.0/24`, not
an on-path attacker. `hope-lmstudio-model-sync-egress` still confines the traffic
to `10.10.1.102/32`, and model **integrity** is untouched — `sync.sh` still
verifies every file against the prefix's own `SHA256SUMS` and refuses to write
`.ready` on a mismatch. Only confidentiality and peer authenticity are relaxed.

Every disabling point carries a comment saying so, so they are greppable, and
reinstatement is two edits: drop both `--insecure` flags, restore `SSL_CERT_FILE`
plus the CA volume and mount. The endpoint line does not change.

Measured against a stand-in MinIO with the same TLS shape (`deployment-llmster/README.md` §7.2):
plain HTTP → `Client sent an HTTP request to an HTTPS server`; https without a CA →
`x509: certificate signed by unknown authority`; https + `--insecure` → works.

### Directive 3 — reachability, and the topology ruling that shapes it

The directive was *"make sure lmstudio can interact with / can be interacted by
other internal services such as `text`."* The owner then **ruled on the topology**:
internal peers reach LM Studio **through the gateway** (`hope-api` → `hope-text` →
LM Studio), never by dialling it directly.

So the ingress peer set is **`hope-text` and nothing else**, and it must not be
widened on the assumption that another service calls the engine. `hope-guardrail`
is not a peer either — it no longer dials an LLM at all, so the "guardrail path"
runs guardrail → text → lmstudio.

> ### ✅ OPEN-824-HARNESS — RESOLVED 2026-08-30 by widening, and the ruling above is SUPERSEDED
>
> `82c63a6ff` (monorepo) and `dd19dab2` (deployment repo, *"LM Studio's workload lands inert — the
> Service does NOT"*) admit **`hope-harness` and `hope-harness-worker`** to the ingress policy
> alongside `hope-text`. So the paragraph immediately above — *"the ingress peer set is `hope-text`
> and nothing else, and it must not be widened"* — no longer describes the shipped rule, and the
> paragraph below it no longer describes an open blocker. Both are kept as the record of the
> reasoning that was overturned.
>
> **Why the earlier ruling was overturned, on measurement rather than preference:** the gateway's
> text surface is BUSINESS-plane. `UnifiedAuthGuard` accepts a service-account token, an API key
> or a JWT, and **never `X-Service-Token`** — so neither harness workload can authenticate to it,
> and the credential that would let them is tenant-bound with no wildcard in `allowedTenantIds`.
> Holding the narrow set would therefore not have routed harness through the gateway. It would
> only have cut Institutional-RAG embeddings off at the Service cutover, presenting as an
> embeddings outage rather than as a policy decision.
>
> **Both halves were measured** (`587213170`): `hope-text`, `hope-harness` and
> `hope-harness-worker` reach `:1234`; `hope-nlp` and `hope-guardrail` still time out. Widening the
> rule for harness did not widen it for anything else — which is the half of a NetworkPolicy change
> that usually goes unproven. Measured on a **different CNI from k3s**, so it proves the policy is
> correct, not that the target cluster enforces it: **`R-5` stays open.**

**⚠️ ~~OPEN-824-HARNESS — a blocker this exposed.~~** *(Historical — resolved above.)* `hope-harness` and
`hope-harness-worker` are configured *today* to dial LM Studio directly for
Institutional-RAG embeddings
(`HARNESS_RETRIEVAL_EMBEDDINGS_BASE_URL=http://hope-lmstudio:1234/v1` at
`base/harness.yaml:110` and `base/harness-worker.yaml:123`) and are live against the
out-of-band Service. Under the ruling they are not peers, so enforcing this policy
drops their calls — verified in the lab, where both went from ALLOWED to BLOCKED
the moment the shipped policy was applied. **They must be re-pointed through the
gateway before the Service cutover; the fix is in the deployment repo, not a wider
ingress rule.** Carried as a blocking pre-cutover step (5'') in the cutover file.

**Egress needed a second policy, and that is a defect this ticket had.** A
NetworkPolicy selects pods by LABEL, and the model-sync Job's pod template carries
`app: hope-lmstudio` — so the DNS-only `hope-lmstudio-egress` selected the Job and
would have blocked the `mc mirror` it exists to run. The Job pod now also carries
`app.kubernetes.io/component: model-sync`, and a narrower
`hope-lmstudio-model-sync-egress` grants DNS + `10.10.1.102/32:9000` to that pair.
Policies are additive, so the Job gets MinIO and the serving pod keeps DNS only —
which is the property the original policy was written to have.

### The Service: kept separate, deliberately

The requirement is that `http://hope-lmstudio:1234` resolve to the POD. Keeping
`lmstudio-service-cutover.yaml` out of the main file is what delivers that: the
Deployment is at `replicas: 0` and the image has never been built, so folding it in
would have Argo CD replace the live selector-less Service with zero pods behind the
new selector — the exact outcome the requirement forbids. The cutover gained two
new steps: 5' proves the NetworkPolicy peer set from each caller (allow AND deny
halves) before the Service moves, and 6' re-verifies by name through the Service
afterwards.

### A bug found by RUNNING the manifest, not by reviewing it

```
mc: <ERROR> Unable to save new mc config. mkdir /home/hope: permission denied.
```

`minio/mc` has no `/home/hope`, `/home` is root-owned, and the pod runs as uid
10001 — so `MC_CONFIG_DIR=/home/hope/.mc` killed the first command before a byte
was fetched. **Every PreSync of this Job would have failed.** Fixed with an
`emptyDir` mounted at `/home/hope`. Full evidence, including the three transport
controls, the successful end-to-end sync over **HTTPS with verification
disabled**, and the four least-privilege checks on the `hope-models-reader`
policy: `deployment-llmster/README.md` §7.

### Still NOT proven

The image has never been built; no GPU execution of any kind; and NetworkPolicy
enforcement was demonstrated on a **different CNI**, so R-5 stays open for the real
k3s cluster. §10B's "NOT proven" list is otherwise unchanged.

## 12. Where this actually stands (2026-08-31)

### 🔴 The image does NOT build, and risk A-3 is therefore NOT closed

`build-lmstudio` **failed** on `arca/hope-v2` pipeline **1030**, job **15218**, commit
`698598b9`, `script_failure` after 30.8 s:

```
FATAL: no CUDA runtime present after bootstrap.
Runtimes must be INCLUDED in the image, not fetched on first use.
See the tree above to identify how this bundle installs engines.
ERROR: failed to build: … Dockerfile:107 … exit code: 1
```

### 12.1 CORRECTION (2026-08-31, later the same day) — the bundle was never the problem

Everything below this subsection was written from `lms runtime ls` alone and reached the
wrong conclusion. The failing job printed BOTH of these, five milliseconds apart:

```
── lms runtime ls ──
No runtimes found.
── ~/.lmstudio tree (depth 3) ──
…
/home/llmster/.lmstudio/extensions/backends/llama.cpp-linux-x86_64-avx2-2.31.2
/home/llmster/.lmstudio/extensions/backends/llama.cpp-linux-x86_64-vulkan-avx2-2.31.2
/home/llmster/.lmstudio/extensions/backends/llama.cpp-linux-x86_64-nvidia-cuda12-avx2-2.31.2
```

Both are true because **`lms runtime ls` is hardware-filtered** — it enumerates runtimes the
HOST CAN RUN, not files on disk. A CI runner has no NVIDIA device, so it correctly reports
nothing while the CUDA engine sits on disk.

**Amended after job 15283.** The first version of this correction went on to say
"`llmster bootstrap` DOES install the engines". That was wrong, and the next build proved it:
a stage that listed `extensions/backends` WITHOUT starting the daemon found it **empty**, on
the same cached bootstrap layer.

| Job | Sequence | `extensions/backends` |
|---|---|---|
| 15218 | `lms daemon up` → `find ~/.lmstudio` | three engines |
| 15283 | `ls` only, no daemon | **empty** |

So the DAEMON'S FIRST START installs them, not `bootstrap`. Job 15218's tree was the
post-daemon-start state, and reading it as evidence about a bootstrap-only image was the
error. Both probes tried so far were wrong in different ways — `lms runtime ls` asks the host
what it can run, and a bare listing asks before anything is installed. The build now starts
the daemon and then reads the directory, which is also what bakes the engines into the layer
rather than leaving them to be fetched on first use in the cluster.

The consequence is that the assertion made **a GPU a build dependency**, which it must never
be: buildkit exposes no device (the job's own banner reads `Platforms: linux/amd64,…`), and an
image only has to CONTAIN an engine, not exercise it. The base is
`nvidia/cuda:12.8.1-runtime-ubuntu24.04` — CUDA *libraries*, which install with no GPU present —
so one image serves CPU and CUDA both, which is the owner requirement.

Fixed by asserting the filesystem inventory instead, requiring BOTH a CPU and a CUDA engine.
`hope-build-info.json` also gained a MEASURED `engines` list beside the declared `accel`,
because `accel` is a `printf` of the `HOPE_BUILD_ACCEL` build ARG and would have read `"cuda"`
on exactly the image that failed — it is a declaration, never evidence.

**Therefore risk A-3's build half is CLOSED by construction, not by hope.** The runtime half —
does the deployed host have a GPU, and was the CUDA engine actually selected — was always in
`entrypoint.sh` A-2 and is unchanged.

**Read the failure precisely, because the two halves come apart.**

| Layer | State |
|---|---|
| The `+cuda12` **tarball** | ✅ Lands, and its pinned **SHA-512** verifies — so the CPU tarball cannot have been substituted. This half of A-3's fix is real and structural |
| An installed CUDA **runtime** | ❌ **Absent.** `lms runtime ls` answers *"No runtimes found."* — on STDERR, exit 0, stdout empty. Not "a CPU engine was selected": **no engine at all** |

**`hope-build-info.json`'s `"accel": "cuda"` is NOT evidence of either.** It is written from the
`HOPE_BUILD_ACCEL` build ARG (`Dockerfile:57,130`) — a declaration of intent. It would read `cuda`
on precisely the image that just failed to build. Anything that cites it as proof of the bundle's
accelerator is citing a `printf`.

**Where the assumption came from.** Both the CI gate and `entrypoint.sh` A-2 assumed
`llmster bootstrap` registers the bundle's engines. That came from a measurement of the **arm64
DEVELOPER bundle on a developer machine** (§10B finding 3: *"ships both engines … llama.cpp-linux-arm64
alongside …-nvidia-cuda13"*). It was never re-measured on the **x64** bundle, and there it does not
hold. Owner directive 2026-08-31: runtimes must be baked at BUILD time — an image with no runtime
cannot serve, and CI only fires after the image is already pushed. `698598b92` moved the assertion
into the Dockerfile, which is why the failure now surfaces as a red build instead of a red pod.

**Consequence for A-3.** Its three-layer chain was: pinned SHA-512 (build) → `verify-lmstudio-runtime`
(CI) → `entrypoint.sh` A-2 (pod). Layer 1 holds. Layers 2 and 3 both read `lms runtime ls`, and on
this bundle that command reports nothing to check — so **A-3 is open**, and the open question is no
longer "did a CPU bundle sneak in" but **"how does this bundle install engines at all?"** The
failing `RUN` prints the whole `~/.lmstudio` tree on failure precisely to answer that; the tree is
in job 15218's log.

**What `verify-lmstudio-runtime` proves, stated once so it is not overclaimed:** it greps the merged
output of `lms runtime ls` for `cuda` inside a container with **no NVIDIA device attached**. It is a
**bundle/provenance assertion**. It does not prove a GPU exists, and it was never able to — its own
epilogue says so: *"this proves the BUNDLE only. GPU presence is asserted at pod start by
entrypoint.sh A-2 (exit 78), because this runner has no NVIDIA device and `lms runtime select`
succeeds without one."* **Any claim that this job "cannot pass without a GPU" is wrong.**

### The manifests ARE committed and live

`dd19dab2` — *"LM Studio's workload lands inert — the Service does NOT"* — is on
`hope-v2-deployment@main`. Live and **Synced/Healthy**: Deployment `hope-lmstudio` (0/0), HPA, PDB,
ConfigMaps `hope-lmstudio-config-h2b672g88m` and `hope-lmstudio-manifest`, NetworkPolicies
`hope-lmstudio-ingress` / `hope-lmstudio-egress`.

**Two objects were pulled OUT of the sync, both for the same reason** — nothing that cannot yet
succeed may gate the Application:

- `4adb9512` — the **model-sync PreSync hook wedged the Application**. It cannot pass until R-2/R-3
  are satisfied, so it did not gate the sync, it deadlocked it. Moved to `out-of-band/`.
- `de8dc03e` — `hope-lmstudio-models` is a **`WaitForFirstConsumer` PVC** and the Deployment is at
  `replicas: 0`, so it has no consumer and stays `Pending` forever while Argo gates sync health on
  it: a permanent `OutOfSync`. Moved out-of-band next to the Job that populates it. Both are
  cutover-time objects, not sync-time ones.

### Not digest-pinned

`base/lmstudio.yaml` hardcodes `image: registry.taphuynh.dev/hope/lmstudio:dev` — a **mutable
tag** — and the dev overlay's `images:` list has **no entry** for it, while carrying digest pins for
all fourteen other images. Its own comment says the overlay is expected to set `newName` + digest.
That step is unwired, and it cannot be wired until there is an image to pin.

### The corrected blocker list

| Id | State |
|---|---|
| **The build** | 🔴 **FAILING** — no runtime in the bundle (above). This is now the first blocker, ahead of everything below |
| R-1 private CA | ✅ CANCELLED by owner decision (struck through, not deleted) |
| R-2 `hope-models-reader` Secret | ⬜ Operator — a hand-created MinIO service account under the committed policy; shared with TASK-823 |
| R-3 publish models + fill `models.tsv` | ⬜ **Not done.** All four rows in ConfigMap `hope-lmstudio-manifest` are still the literal placeholder `SET-AT-PUBLISH`; `sync.sh` fails closed on it |
| R-4 registry creds / private-only | ✅ Structurally (`imagePullSecrets: hope-registry-creds`); the "not mirrored publicly" half is a human policy check |
| R-5 k3s NetworkPolicy enforcement | ⬜ **OPEN** — the peer set was measured on a different CNI |
| R-6 `LMS` release-tag grammar | ⬜ Deferred, non-blocking (branch-push + `ALL-` triggers work today) |
| R-7 `AiProviderConnection` no-op | ✅ `seed/17-ai-provider-connection.ts:253-266` already targets `http://hope-lmstudio:1234/v1` |
| Service cutover | ⬜ `lmstudio-service-cutover.yaml` deliberately separate — folding it in today repoints the live Service at zero pods |
| GPU accounting | ⬜ The HOST LM Studio instance holds VRAM entirely outside k8s accounting, so the scheduler's ledger understates usage; read `nvidia-smi` on the node before scaling |

## 11. Change History
| Date | Change |
|---|---|
| 2026-08-29 | Ticket created. Owner directed a custom headless `llmster` GPU image over `linuxserver/docker-lm-studio`; ToS position recorded as accepted risk; MinIO artifact plane specified. |
| 2026-08-30 | **Engine recommendation reversed pending owner sign-off (§2A): `llama-server` over the `llmster` build.** Driven by TASK-831 — two headline models are vision **and audio**, and LM Studio audio support is UNVERIFIED-negative. Six corroborating findings: §4.10's entire no-rescan problem class disappears (and router mode HAS a rescan, `GET /models?reload=1`); `/health` gives a real 503→200 readiness gate (verified); the §4.1 silent-CPU-fallback trap becomes structurally absent; MIT licence removes both the ToS risk and the private-registry constraint; `--api-key-file` makes §5 L-1's auth gap real rather than "NetworkPolicy is the ONLY enforcement point"; and most of §4.9's twelve unknowns are LM Studio-specific. Build floor b9383 proven by **commit ancestry** (4/4 fix PRs `behind_by=0`), not by build number. Staged a thin digest-pinned image, a checksum-verifying MinIO→PVC sync Job (with the §4.10 `lms import` step correctly ABSENT), 13 k8s objects incl. the first NetworkPolicies for this workload, an opt-in `gguf` compose profile, and the `AiProviderConnection` spec — which turns out to be a **one-field `baseUrl` change to an existing seed row**, no router code and no `AiModel.provider` change. Recorded three findings that change how the plan is expressed: `--ctx-size` is the TOTAL KV budget divided across `--parallel` slots (so §6.4's "28 seq @ 8k" is `-np 28 -c 229376`); `provider: 'llama-cpp'` in the catalogue selects the raw-prompt `/completion` adapter and would silently strip the chat template from a multimodal model; and Gemma 4 emits reasoning into `message.reasoning_content`, leaving `content` empty. Two genuine costs recorded rather than buried: router mode self-reports as **experimental** ("not recommended in untrusted environments"), and the embedding plane **cannot route at all** until TASK-831 §9 owner decision 2 is taken, because `apps/text` registers only `tei-embed` and TEI cannot load a GGUF. **No GPU was available to this lane; GPU offload and all throughput claims are unverified.** |
| 2026-08-30 | **Phase 2 — built the LM Studio (`llmster`) tier per the §0 owner decision (§10B).** Image at `infrastructure/docker/lmstudio/` (pinned + SHA-512-verified `+cuda12` bundle, non-root uid 10001, build-info baked); CI wiring in `.gitlab/ci/build.yml` (`build-lmstudio` + `verify-lmstudio-runtime`, which fails the pipeline on a CPU-only image); 8 staged k8s objects at `replicas: 0` with the Service separated into a cutover file because it is the one outage-capable step (`hope-lmstudio` currently fronts the HOST instance and carries both summarization and guardrail). **Per the owner directive of 2026-08-30, CI is the only builder; local build results are discarded as evidence.** Nine measured findings against llmster 0.0.23-1, several of which CORRECT this ticket: §4.7's wait-loop never waits (`lms server status` exits 0 before the daemon exists — in fact every `lms` status command exits 0 regardless of the answer, `runtime select` included, even with no GPU); **§4.10's conclusion does not hold** — a GGUF in `<publisher>/<model>/` is indexed at daemon start AND live, so there is no rescan command because the daemon watches the directory ("no rescan API" and "no discovery" are different claims); a **second silent-CPU path** — the bundle ships both engines and selects the CPU one by default, plus `install.sh:442` yields the CPU bundle on a builder lacking `timeout` even on a GPU host; `lms import` without `-L` **crashes** on a TTY probe rather than silently moving; §4.3's readiness design has **no headless mechanism** (no JIT control exists) so readiness is `loaded_instances[]` via an exec probe; the model key derives from the `--user-repo` `<model>` segment with a `text-embedding-` prefix for embedding models (the §7.4 trap, now asserted at boot); defaults are loopback on a random port; and **no `/metrics` endpoint exists** — an observability regression recorded rather than hidden. **NOT proven: no image build is claimed, no GPU execution, and AUDIO WAS NOT VERIFIED** — `audio-smoke-test.sh` is delivered as an executable A-1 test with all gathered evidence negative or absent, and OI-1 (whether LM Studio auto-pairs `*-mmproj.gguf`) must be closed first or vision and audio are both silently unavailable. |
| 2026-08-30 (Phase 3) | **Deployability pass (§10C): the CA is gone, the peer set follows the gateway ruling, and the manifest was RUN rather than only reviewed.** Per owner directive — no private CA anywhere, authentication is a MinIO SERVICE ACCOUNT and nothing else, PHI hardening explicitly de-prioritised. **"No CA" settles authentication, not transport:** the endpoint stays `https://10.10.1.102:9000` (MinIO serves TLS on :9000, one port serves one scheme, and plain HTTP would have forced pgBackRest, GitLab, Loki, Tempo, Prometheus and both cloudflared origins to be re-pointed as collateral), and what replaces the CA is `mc --insecure` on BOTH `mc` invocations — the `config host add` and the `mc mirror` inside `sync.sh`, because mc evaluates the flag per invocation. Removed `SSL_CERT_FILE`, the `/etc/ssl/arcaai` mount and the `arcaai-internal-ca` volume; **`ROOT_CONFIG_REQUEST R-1` is recorded as CANCELLED, struck through rather than deleted**. Moved the MinIO endpoint out of a hardcoded literal (and out of the platform's `hope-secrets`, which still holds the PUBLIC tunnel hostname) into `config/lmstudio.env` → `hope-lmstudio-config.LMSTUDIO_S3_ENDPOINT_URL`, referenced NON-optionally: an endpoint is `env`-tier config, and a stale Secret value fails OPEN onto the internet where a missing ConfigMap key fails the pod. **Ingress peer set is `hope-text` ONLY**, per the owner's topology ruling that internal peers reach LM Studio through the gateway rather than dialling it — which exposed **OPEN-824-HARNESS**: `base/harness.yaml:110` and `base/harness-worker.yaml:123` set `HARNESS_RETRIEVAL_EMBEDDINGS_BASE_URL=http://hope-lmstudio:1234/v1` and are LIVE today, so they must be re-pointed through the gateway before the Service cutover or their embeddings calls are dropped (carried as blocking cutover step 5''; deliberately NOT worked around by widening the rule). **Found and fixed a NetworkPolicy defect this ticket shipped:** the sync Job's pod carries `app: hope-lmstudio`, so the DNS-only egress policy selected it and would have blocked its own `mc mirror`; the Job now also carries `app.kubernetes.io/component: model-sync` and a third, narrower policy grants it DNS + `10.10.1.102/32:9000` while the serving pod keeps DNS only. **Found by RUNNING the Job on a throwaway cluster: `mc: <ERROR> Unable to save new mc config. mkdir /home/hope: permission denied` — `minio/mc` has no `/home/hope` and the pod runs as uid 10001, so EVERY PreSync would have failed**; fixed with an `emptyDir` at `/home/hope`. Then proved the shipped configuration end to end against a MinIO serving TLS with a self-signed leaf: three transport controls (plain HTTP → `Client sent an HTTP request to an HTTPS server`; https without a CA → `x509: certificate signed by unknown authority`; https + `--insecure` → works), then `mc config host add` from the ConfigMap endpoint + `hope-models-reader` Secret, the `SET-AT-PUBLISH` fail-closed guard, `mc mirror`, `sha256sum -c` verification, the `.ready` sentinel, and correct PVC ownership under `fsGroup: 10001`; plus the reader service account denying put/delete/other-bucket. Ingress policy verified behaviourally (`hope-text` ALLOWED; harness, harness-worker and nlp all BLOCKED, against a clean all-allowed baseline) — **on a different CNI, so R-5 stays OPEN for k3s**; egress showed a startup race (forbidden destination reachable at t=0, blocked at t=45s, reproduced twice). Kept `lmstudio-service-cutover.yaml` separate and said why in the file: folding it in would repoint the live Service at zero pods. Added cutover steps 5' (prove the peer set, allow AND deny halves), 5'' (the harness blocker) and 6' (re-verify through the Service by name). Wrote the operator runbook `docs/operations/inference/serving-tier-cluster-deployment.md`. |
| 2026-08-31 | **The image does NOT build, so risk A-3 is OPEN — and `OPEN-824-HARNESS` is resolved.** New §12. `build-lmstudio` FAILED on `arca/hope-v2` pipeline **1030**, job **15218**, commit `698598b9`: *"FATAL: no CUDA runtime present after bootstrap"* at `Dockerfile:107`. The two halves of A-3 come apart — the `+cuda12` **tarball** lands and its pinned SHA-512 verifies (structural, real), but the bundle registers **no inference runtime at all** (`lms runtime ls` → "No runtimes found."), so both the CI gate and `entrypoint.sh` A-2 have nothing to check. **`hope-build-info.json`'s `"accel": "cuda"` is a `printf` of the `HOPE_BUILD_ACCEL` build ARG, not a measurement** — it would read `cuda` on exactly the image that just failed. The assumption that `llmster bootstrap` registers the bundle's engines came from the **arm64 developer** bundle measured on a developer machine (§10B finding 3) and does not hold on x64; `698598b92` moved the assertion into the Dockerfile per owner directive, so it now fails as a red build rather than a red pod. Also corrected: **`verify-lmstudio-runtime` proves the BUNDLE only** — it greps `lms runtime ls` inside a container with no NVIDIA device — so any claim that it "cannot pass without a GPU" is wrong; the job's own epilogue says so. **`OPEN-824-HARNESS` is RESOLVED by widening** (`82c63a6ff` + deployment `dd19dab2`), which SUPERSEDES §10C's "peer set is `hope-text` and nothing else, and it must not be widened": `UnifiedAuthGuard` never accepts `X-Service-Token`, so neither harness workload could authenticate to the gateway and the narrow set would have produced an embeddings outage, not a routing change. Both halves measured (`587213170`) — text/harness/harness-worker allowed, nlp/guardrail still blocked — on a different CNI, so **R-5 stays open**. Recorded that the manifests are committed and live at 0/0 (`dd19dab2`), that two objects were pulled out of the sync because they could not yet succeed (`4adb9512` model-sync PreSync hook; `de8dc03e` the `WaitForFirstConsumer` PVC with no consumer), and that the image is **not digest-pinned** — `base/lmstudio.yaml` carries the mutable tag `:dev` and the dev overlay has no `images:` entry for it, alone among fourteen. |
| 2026-08-31 (later) | **CORRECTION — A-3's build half is closed; the bundle was never at fault (new §12.1).** The `build-lmstudio` failure was a WRONG PROBE. `lms runtime ls` is hardware-filtered — it lists runtimes the HOST CAN RUN — so on a GPU-less CI runner it reports "No runtimes found." while `extensions/backends/` demonstrably holds `llama.cpp-linux-x86_64-avx2` (CPU), `…-vulkan-avx2` and `…-nvidia-cuda12-avx2`. Both facts are printed by job **15218** itself, milliseconds apart. So `llmster bootstrap` DOES register the engines, the §10B arm64 measurement generalised, and the earlier entry's "the bundle registers no inference runtime at all" is WITHDRAWN. The real defect was making a GPU a BUILD dependency, which buildkit can never satisfy; an image only has to CONTAIN an engine. `Dockerfile:107` now asserts the filesystem inventory and requires BOTH a CPU and a CUDA engine per the owner requirement that images run either way (`nvidia/cuda:12.8.1-runtime-ubuntu24.04` installs CUDA libraries without a device, so a single image covers both). `hope-build-info.json` gained a measured `engines` list beside the declared `accel`. The runtime-half check is untouched in `entrypoint.sh` A-2. |
| 2026-08-31 (later, amended) | **§12.1 amended — the daemon's first start installs the engines, not `bootstrap`.** Job **15283** failed the new filesystem assertion with an EMPTY `extensions/backends`, on the same cached bootstrap layer that job 15218 had shown three engines under. The difference is that 15218 ran `lms daemon up` first. So the earlier sentence "`llmster bootstrap` DOES install the engines" is WITHDRAWN: 15218's tree was the post-daemon-start state. The Dockerfile now starts the daemon and then reads the directory — which additionally means the engines are materialised INTO the image layer, satisfying the owner directive that runtimes be baked in rather than fetched on first use. The hardware-filtering finding about `lms runtime ls` is unaffected and still stands. |
