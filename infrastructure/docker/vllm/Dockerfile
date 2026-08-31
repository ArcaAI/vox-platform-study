# =============================================================================
# TASK-823 — vLLM inference image with OUT-OF-TREE GGUF support
# =============================================================================
# OWNER DECISION (implemented here, not relitigated): serve GGUF weights through
# the out-of-tree plugin. The owner was shown both sides — that vLLM removed its
# in-tree GGUF loader, and that Google publishes vLLM-native `w4a16`
# compressed-tensors builds of the same models that need no plugin at all — and
# chose the plugin path. The trade-offs are recorded factually in
# docs/implementation/TASK-823-vLLM-Inference-Service/README.md §13.
#
# -----------------------------------------------------------------------------
# THE VERSION PINCER THIS FILE EXISTS TO RESOLVE
# -----------------------------------------------------------------------------
#   v0.11.0 (what the dev compose `inference` profile runs today) HAS the
#           in-tree GGUF loader but does NOT know Gemma 4.
#   v0.28.0 (2026-08-26, current)  KNOWS Gemma 4 but has NO in-tree GGUF loader.
#
# There is no vLLM release that has both. GGUF moved out-of-tree under RFC
# vllm-project/vllm#39583, and vLLM's own documentation states it verbatim:
#   "GGUF support has migrated to OOT vllm-gguf-plugin"
#   "GGUF support in vLLM is highly experimental and under-optimized at the
#    moment, it might be incompatible with other features."
# Read that second sentence as a property of what this image ships, not as
# boilerplate.
#
# So: v0.28.0 for the model coverage, plus the official plugin for the loader.
#
# -----------------------------------------------------------------------------
# WHAT THIS IMAGE IS *NOT* GOOD FOR (do not discover these in production)
# -----------------------------------------------------------------------------
# 1. EMBEDDINGS ARE IMPOSSIBLE HERE. The plugin has no pooling path — its
#    tested-coverage table has exactly three modalities (Text, Vision-language,
#    Image generation) and no pooling/embedding entry. EmbeddingGemma cannot be
#    served as GGUF at all; it needs vLLM's NATIVE pooling runner against a
#    safetensors checkpoint (`--runner pooling --convert embed`). That is a
#    different serving mode, not a flag on this one.
# 2. GRANITE IS UNVERIFIED. Granite / Granite Guardian appear nowhere in the
#    plugin's tested set. Its own README: "A model appearing in vLLM's general
#    supported-model list does not by itself guarantee GGUF compatibility."
# 3. `s3://` CANNOT REACH THIS LOADER. See the manifest note in §13 of the
#    ticket: GGUF `--model` resolution accepts a LOCAL FILE PATH or a Hugging
#    Face `<repo_id>:<quant>`, and nothing else — so the shipped
#    `--load-format runai_streamer` + `s3://hope-models/...` design cannot serve
#    GGUF. A GGUF model must arrive as a local path with an explicit
#    `--tokenizer`.
# =============================================================================

# Base and plugin travel together — this pair is the artifact.
ARG BASE_IMAGE=vllm/vllm-openai:v0.28.0
FROM ${BASE_IMAGE}

# Redeclared after FROM so the provenance step can record what was actually used.
ARG BASE_IMAGE
ARG VLLM_GGUF_PLUGIN_REPO=https://github.com/vllm-project/vllm-gguf-plugin

# PINNED BY FULL 40-CHAR COMMIT SHA, never a branch and never a tag.
#
# WHY NOT THE PyPI RELEASE: the latest published release is 0.0.5 (2026-08-10)
# and it does NOT contain Gemma 4 support. Gemma 4 landed on `main` in this
# commit — "Gemma4 gguf support (#122)", committed 2026-08-31T02:34:35Z,
# verified with `git ls-remote https://github.com/vllm-project/vllm-gguf-plugin
# main` (it was HEAD of main at the time of writing).
#
# WHY NOT `@main`: a moving ref makes every rebuild a different image under the
# same Dockerfile. The verify step below re-asserts this exact SHA against the
# provenance baked into the image, so a drifted pin fails loudly.
#
# NOTE the trap this closes: the plugin's installed VERSION string is
# `base_version` from its pyproject and reads "0.0.5" even when built from this
# commit. The version alone can never tell you whether Gemma 4 is in the image;
# only the SHA can.
ARG VLLM_GGUF_PLUGIN_SHA=d4c1f0d082fc7cd4350da56689109a01c1f29d6c

USER root
ENV DEBIAN_FRONTEND=noninteractive

# `git` is NOT in vllm/vllm-openai — the base's only `apt-get install -y git`
# lives in the upstream `test-deps` stage, which is not an ancestor of
# `vllm-openai`. Installed unconditionally here (a no-op if that ever changes),
# because the pin above is a `git+https://...@<sha>` requirement.
RUN apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

# ── Preflight: the two things a GPU-less build silently needs ────────────────
# Both are properties of the BASE IMAGE, so if either ever stops holding, this
# fails here with a readable message instead of deep inside nvcc.
#
#  nvcc — the plugin builds a torch CUDAExtension from source (its README's
#    stated prerequisite is "CUDA toolkit or ROCm toolkit"). The base carries
#    cuda-nvcc/cuda-nvrtc/libcublas-dev for its own runtime JIT, which is the
#    only reason a source build is possible in this image at all.
#  TORCH_CUDA_ARCH_LIST — set by the base to '7.5 8.0 8.6 8.9 9.0 10.0 11.0
#    12.0'. Without it torch would try to QUERY A DEVICE to pick an
#    architecture, and buildkit exposes none. Deliberately NOT narrowed to the
#    Ampere-or-newer (compute >= 8.0) target: inheriting the base's superset
#    costs compile time (hence the job's generous timeout) and changes nothing
#    about what the image can run.
RUN set -eu; \
    export CUDA_HOME="${CUDA_HOME:-/usr/local/cuda}"; \
    if ! command -v nvcc >/dev/null 2>&1 && [ ! -x "${CUDA_HOME}/bin/nvcc" ]; then \
      echo "FATAL: no nvcc in the base image." >&2; \
      echo "The GGUF plugin compiles a CUDA extension from source and cannot" >&2; \
      echo "be installed without a CUDA toolkit. Do not 'fix' this by dropping" >&2; \
      echo "the extension — a pure-Python install fails only at inference." >&2; \
      exit 1; \
    fi; \
    if [ -z "${TORCH_CUDA_ARCH_LIST:-}" ]; then \
      echo "FATAL: TORCH_CUDA_ARCH_LIST is empty." >&2; \
      echo "The base image used to set it. Without it torch queries a device" >&2; \
      echo "to choose an architecture, and this runner has none." >&2; \
      exit 1; \
    fi; \
    echo "OK: nvcc=$(command -v nvcc || echo "${CUDA_HOME}/bin/nvcc")"; \
    echo "OK: TORCH_CUDA_ARCH_LIST=${TORCH_CUDA_ARCH_LIST}"

# ── Install the plugin ───────────────────────────────────────────────────────
# `--no-build-isolation` IS MANDATORY, and it is upstream's own instruction —
# the plugin README says, verbatim: "Disabling build isolation ensures that the
# CUDA extension is compiled against the same PyTorch installation used by vLLM
# at runtime." Without it, PEP 517 honours the plugin's
# `build-system.requires = [..., "torch>=2.9"]` by downloading a SEPARATE torch
# into an isolated env and compiling `_C_gguf` against THAT ABI, while the image
# runs torch 2.13.0. The result installs cleanly and breaks at inference.
#
# `--no-deps` IS ALSO USED, and here is the evidence for it. The plugin declares
# four runtime dependencies:
#     vllm                    (NO version specifier)
#     torch>=2.9              base has torch==2.13.0  -> satisfied
#     huggingface_hub>=1.26.0 vLLM pins >=1.27.0      -> satisfied
#     gguf>=0.17.0            NOT a vLLM 0.28.0 dep   -> genuinely absent
# Three of the four are already satisfied, so a resolving install would add
# exactly one package — but it would do so with a resolver that has an
# UNPINNED `vllm` requirement and full freedom over the transitive set. vLLM
# pins `torch==2.13.0` exactly and its CUDA stack (flashinfer, cutlass-dsl,
# quack-kernels, humming-kernels) is version-locked to it; anything that moves
# torch silently replaces the tested runtime. `--no-deps` removes the resolver
# from that decision entirely.
#
# The one genuinely-missing dependency is then installed on its own line. `gguf`
# cannot depend on vllm or torch, so it cannot move them by construction — and
# the before/after guard below proves that rather than assuming it.
#
# The first pip line supplies the build backend that `--no-build-isolation`
# then refuses to fetch. Its setuptools range is vLLM's OWN pin
# (requirements/common.txt), so it cannot drift outside what the base expects.
RUN set -eu; \
    export CUDA_HOME="${CUDA_HOME:-/usr/local/cuda}"; \
    before="$(python3 -c 'from importlib.metadata import version; print(version("vllm"), version("torch"))')"; \
    echo "runtime BEFORE plugin install: vllm/torch = ${before}"; \
    python3 -m pip install --no-cache-dir "setuptools>=77.0.3,<81.0.0" wheel; \
    python3 -m pip install --no-cache-dir --no-build-isolation --no-deps \
      "git+${VLLM_GGUF_PLUGIN_REPO}@${VLLM_GGUF_PLUGIN_SHA}"; \
    python3 -m pip install --no-cache-dir "gguf>=0.17.0"; \
    after="$(python3 -c 'from importlib.metadata import version; print(version("vllm"), version("torch"))')"; \
    echo "runtime AFTER  plugin install: vllm/torch = ${after}"; \
    [ "${before}" = "${after}" ] || { \
      echo "FATAL: installing the plugin MOVED vllm and/or torch." >&2; \
      echo "  before: ${before}" >&2; \
      echo "  after : ${after}" >&2; \
      echo "This image would no longer be the runtime the base image tested." >&2; \
      exit 1; }

# Copied AFTER the expensive install so editing the verifier does not
# invalidate the CUDA compile. It stays in the image on purpose: the
# verify-vllm-plugin CI job re-runs `assert` against the PUSHED image, so the
# build gate and the CI gate cannot drift apart.
COPY build-verify.py /opt/hope/build-verify.py
RUN chmod 0755 /opt/hope/build-verify.py

# ── Provenance: MEASURED, not restated ──────────────────────────────────────
# Records the base image ref, the plugin repo and its pinned commit SHA, and
# the versions of vllm / torch / vllm_gguf_plugin READ BACK FROM THE INSTALLED
# PACKAGES. The distinction matters: the sibling lmstudio image learned the
# hard way that a build ARG echoed into a JSON file is a DECLARATION of what
# was requested and proves nothing about what landed.
RUN set -eu; \
    BASE_IMAGE="${BASE_IMAGE}" \
    VLLM_GGUF_PLUGIN_REPO="${VLLM_GGUF_PLUGIN_REPO}" \
    VLLM_GGUF_PLUGIN_SHA="${VLLM_GGUF_PLUGIN_SHA}" \
    python3 /opt/hope/build-verify.py record

# ── The build-time assertion ────────────────────────────────────────────────
# A separate layer from `record`, and it re-supplies the SHA from the ARG, so
# the check is not the provenance file grading its own homework.
#
# It asserts ONLY what a machine with no GPU can honestly prove: the compiled
# `_C_gguf*.so` exists, the `gguf` entry point is discoverable in the
# `vllm.general_plugins` group through the same `importlib.metadata` call
# vLLM's own loader makes, that entry point loads, and vllm/torch are
# unmoved. It asserts NOTHING about a device, weights, or `vllm serve`.
# See the module docstring in build-verify.py for why that boundary is drawn
# exactly there.
RUN python3 /opt/hope/build-verify.py assert --expect-sha "${VLLM_GGUF_PLUGIN_SHA}"

# ── bake build identity, LAST layer ─────────────────────────────────────────
# These args change on every commit, so they sit below everything above and
# never invalidate the (very expensive) plugin-compile layer. Written to
# /app/build-info.json per docs/operations/build-info.schema.json. Build
# identity is an immutable property of the ARTIFACT and belongs to none of the
# configuration tiers — it must never become settable from a manifest, an env
# file, or turbo.json#globalEnv (09-infrastructure-devops.md §Release
# Versioning).
ARG BUILD_SERVICE
ARG BUILD_VERSION
ARG BUILD_RELEASE_TAG
ARG BUILD_GIT_BRANCH
ARG BUILD_GIT_SHA
ARG BUILD_AT
ARG BUILD_CI_PIPELINE_ID
ARG BUILD_CI_PIPELINE_URL
RUN set -eu; \
    mkdir -p /app; \
    release_tag=$( [ -n "${BUILD_RELEASE_TAG:-}" ] && printf '"%s"' "${BUILD_RELEASE_TAG}" || printf 'null' ); \
    pipeline_id=$( [ -n "${BUILD_CI_PIPELINE_ID:-}" ] && printf '"%s"' "${BUILD_CI_PIPELINE_ID}" || printf 'null' ); \
    pipeline_url=$( [ -n "${BUILD_CI_PIPELINE_URL:-}" ] && printf '"%s"' "${BUILD_CI_PIPELINE_URL}" || printf 'null' ); \
    printf '{"service":"%s","version":"%s","releaseTag":%s,"gitBranch":"%s","gitCommitSha":"%s","buildAt":"%s","ciPipelineId":%s,"ciPipelineUrl":%s}\n' \
      "${BUILD_SERVICE}" "${BUILD_VERSION}" "${release_tag}" "${BUILD_GIT_BRANCH}" "${BUILD_GIT_SHA}" "${BUILD_AT}" "${pipeline_id}" "${pipeline_url}" \
      > /app/build-info.json; \
    chmod 0644 /app/build-info.json; \
    cat /app/build-info.json

# ENTRYPOINT and USER are deliberately INHERITED from vllm/vllm-openai and must
# stay that way: the upstream entrypoint is `vllm serve`, and the serving flags
# are supplied by the Deployment manifest (which this lane does not own). An
# ENTRYPOINT here would silently change how every existing argument list is
# interpreted.
