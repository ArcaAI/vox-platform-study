# syntax=docker/dockerfile:1
# STT Service Dockerfile
# Multi-stage build for optimized production image
#
# Built from the REPO ROOT context so the CPU stages can consume the single uv
# workspace lock (/uv.lock):
#   docker build -f apps/stt/docker/Dockerfile --target runtime    -t stt:api .
#   docker build -f apps/stt/docker/Dockerfile --target ml-runtime -t stt:ml .
#   docker build -f apps/stt/docker/Dockerfile --target worker     -t stt:worker .
#
# Build targets:
#   - runtime:    Lightweight API server (no ML dependencies, CPU only)  → workspace lock
#   - ml-runtime: Full ML inference stack (CUDA GPU with CPU fallback)    → GPU override install
#   - worker:     Dramatiq worker extending ml-runtime
#
# Requires hope-python-base first (for CPU stages):
#   docker build -t hope-python-base infrastructure/docker/python-base/
#
# CPU vs GPU dependency sourcing:
#   - CPU `runtime` installs stt's BASE deps from the unified workspace lock,
#     so it stays version-consistent with every other HOPE Python service.
#   - GPU `ml-runtime`/`worker` install stt[ml-gpu]/[nemo] with a Dockerfile
#     override that skips redundant nvidia-* wheels (the CUDA libs come from the
#     nvidia/cuda base image). This GPU path is NOT covered by `uv sync --frozen`
#     and must be validated on a GPU CI runner.
#   - GPU `ml-runtime`/`worker` additionally COMPILE pywhispercpp from source
#     (GGML_CUDA=1, pinned CUDA arch) because no CUDA wheel is published; the
#     ml-builder stage therefore needs the CUDA -devel base for nvcc.

# Base image is parameterized so CI can inject the registry-qualified tag while
# local builds default to the locally-built `hope-python-base:latest`.
ARG BASE_IMAGE=hope-python-base:latest

# =============================================================================
# Stage 1: Builder — base Python packages from the workspace lock (CPU, no ML)
# =============================================================================
FROM ${BASE_IMAGE} AS builder

# Layer 1: install ONLY stt's base deps from the workspace lock.
COPY pyproject.toml uv.lock ./
COPY apps/stt/pyproject.toml ./apps/stt/
COPY apps/guardrail/pyproject.toml ./apps/guardrail/
COPY apps/nlp/pyproject.toml ./apps/nlp/
COPY apps/smr/pyproject.toml ./apps/smr/
COPY apps/harness/pyproject.toml ./apps/harness/
COPY apps/tts/pyproject.toml ./apps/tts/
# Shared model-lifecycle package. `--no-install-project` skips only
# the TARGET package, not its workspace path dependencies (verified: omitting
# this COPY fails layer 1 with "Distribution not found"). Dependency-free and
# rarely changed, so it costs no meaningful layer-cache churn.
COPY packages/py-runtime-models ./packages/py-runtime-models
# TASK-558 — shared env-file loader (`hope-env`). Same workspace path-dependency
# rule as py-runtime-models above: every service now declares `hope-env`, so
# `uv sync` needs it on disk or layer 1 fails with "Distribution not found at:
# file:///app/packages/py-env". Dependency-light and rarely changed.
COPY packages/py-env ./packages/py-env
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package stt --no-dev --no-install-project --no-editable

# Layer 2: copy source + install the package itself.
COPY apps/stt/README.md ./apps/stt/
COPY apps/stt/src ./apps/stt/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --package stt --no-dev --no-editable

RUN find /app/.venv/lib -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib -type d -name "*.egg-info" -exec rm -rf {} + 2>/dev/null || true \
    && find /app/.venv/lib \( -name "*.pyc" -o -name "*.pyo" \) -type f -delete 2>/dev/null || true

# =============================================================================
# Stage 2: ML Builder — unified ML packages (CUDA-capable, CPU fallback)
# =============================================================================
# Uses the CUDA *devel* base (not -runtime) because whisper.cpp's CUDA backend
# is compiled from source here and needs nvcc, which only ships in -devel. This
# is builder-only: the shipped ml-runtime stage stays on -runtime, whose CUDA
# math libs (libcudart/libcublas) are what ggml-cuda links against.
# Installs stt[ml-gpu]/[nemo] directly (fresh resolve) with an override that
# skips nvidia-* wheels already provided by the base image. transformers/optimum
# are pinned by stt's pyproject ([ml]) so they match the workspace lock.
# =============================================================================
FROM nvidia/cuda:12.8.1-cudnn-devel-ubuntu22.04 AS ml-builder

WORKDIR /build

# Build toolchain only — deliberately NO apt python. Ubuntu 22.04's `python3.11`
# package is 3.11.0rc1, a RELEASE CANDIDATE, and this image used to both build and
# ship against it while every CPU service got a real 3.11.x from
# python:3.11-slim-trixie. The interpreter now comes from uv
# (python-build-standalone) so both halves of the fleet run a stable, pinned 3.11.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        cmake git

COPY --from=ghcr.io/astral-sh/uv:0.11.7 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_INSTALLER_METADATA=1 \
    UV_PYTHON_INSTALL_DIR=/opt/python

# The venv holds a SYMLINK to this interpreter, so ml-runtime must copy /opt/python
# alongside /opt/venv at the identical path or the link dangles.
# Patch pinned per 09-infrastructure-devops (pin tags, no floating refs). This runs
# before any expensive layer, so if uv 0.11.7's manifest predates this patch the
# build fails in seconds — drop to `3.11` or bump uv.
# `-VV` prints the resolved build to the log as evidence it is not an RC.
RUN uv python install 3.11.15 \
    && uv venv --python 3.11.15 /opt/venv \
    && /opt/venv/bin/python -VV

ENV PATH="/opt/venv/bin:$PATH"

# Workspace scaffolding: stt's pyproject declares hope-runtime-models / hope-env
# as `workspace = true` sources, so even this fresh (non-frozen) GPU resolve needs
# the workspace root (root pyproject.toml + uv.lock) and those path members on
# disk — the same set the CPU `builder` stage and the smr/harness Dockerfiles copy.
# Without it, `uv pip install` fails: "hope-runtime-models references a workspace
# in tool.uv.sources, but is not a workspace member".
COPY pyproject.toml uv.lock ./
COPY apps/stt/pyproject.toml apps/stt/README.md ./apps/stt/
COPY apps/guardrail/pyproject.toml ./apps/guardrail/
COPY apps/nlp/pyproject.toml ./apps/nlp/
COPY apps/smr/pyproject.toml ./apps/smr/
COPY apps/harness/pyproject.toml ./apps/harness/
COPY apps/tts/pyproject.toml ./apps/tts/
COPY packages/py-runtime-models ./packages/py-runtime-models
COPY packages/py-env ./packages/py-env
COPY apps/stt/src ./apps/stt/src

# Generate overrides that tell uv to skip most nvidia-* pip packages and triton.
#
# Why this is safe (verified by codebase audit of apps/stt/src/):
#   - Zero direct imports of any nvidia.* Python package
#   - Zero torch.compile() calls → triton not needed
#   - Most CUDA libs (cublas, cudnn, cufft, curand, nvrtc, cusparse, cusolver)
#     are already provided as system libraries by the nvidia/cuda base image
#   - The codebase is 100% inference-only: torch.no_grad(), model.generate(),
#     .to(device), torch.cuda.is_available() — no training, no autograd
#
# EXCEPTIONS — packages NOT skipped (must come from pip):
#   - nvidia-cusparselt-cu12: torch >=2.8.0 unconditionally loads
#     libcusparseLt.so.0 at import time (via torch._C), and the runtime
#     base image does NOT bundle cuSPARSELt (~287 MB).
#   - nvidia-cuda-cupti-cu12: torch >=2.8.0 unconditionally loads
#     libcupti.so.12 at import time (via torch._C). CUPTI is only shipped
#     in nvidia/cuda *devel* images, not the runtime variant (~15 MB).
#   - nvidia-nccl-cu12: torch >=2.8.0 unconditionally loads libnccl.so.2
#     at import time (via libtorch_cuda.so). Not shipped in the runtime
#     base image (~300 MB).
#
# This prevents ~2.6 GB of redundant downloads that the old approach
# (install-then-uninstall) was wasting on every uncached build.
RUN printf '%s\n' \
        'nvidia-cublas-cu12 ; sys_platform == "never"' \
        'nvidia-cuda-nvrtc-cu12 ; sys_platform == "never"' \
        'nvidia-cuda-runtime-cu12 ; sys_platform == "never"' \
        'nvidia-cudnn-cu12 ; sys_platform == "never"' \
        'nvidia-cufft-cu12 ; sys_platform == "never"' \
        'nvidia-curand-cu12 ; sys_platform == "never"' \
        'nvidia-cusolver-cu12 ; sys_platform == "never"' \
        'nvidia-cusparse-cu12 ; sys_platform == "never"' \
        'nvidia-nvjitlink-cu12 ; sys_platform == "never"' \
        'nvidia-cufile-cu12 ; sys_platform == "never"' \
        'nvidia-nvtx-cu12 ; sys_platform == "never"' \
        'triton ; sys_platform == "never"' \
        'flash-attn ; sys_platform == "never"' \
    > /tmp/cuda-overrides.txt

# Install torch + torchaudio first (--no-deps) to avoid pulling their
# nvidia-* transitive deps. Then install remaining ML-GPU deps with
# --override to skip nvidia-*/triton entirely during resolution.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python --no-deps \
        "torch>=2.8.0,<2.9.0" \
        "torchaudio>=2.8.0,<2.9.0"

RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python --only-binary flash-attn \
        "flash-attn>=2.8.3" \
    || echo "WARNING: flash-attn prebuilt wheel not available, skipping (attention will use default PyTorch SDPA path)"

RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python \
        --override /tmp/cuda-overrides.txt \
        "./apps/stt[ml-gpu]"

RUN --mount=type=cache,target=/root/.cache/uv \
    printf '%s\n' \
        'transformers==5.5.4' \
    >> /tmp/cuda-overrides.txt \
    && uv pip install --python /opt/venv/bin/python \
        --override /tmp/cuda-overrides.txt \
        "./apps/stt[nemo]"

# whisper.cpp WITH CUDA — must run AFTER [ml-gpu]/[nemo] so neither resolves the
# CPU wheel back over it.
#
# The PyPI `pywhispercpp` wheels are prebuilt CPU-only ggml (Metal on macOS, plain
# CPU on manylinux). whisper.cpp does NOT error when asked for a GPU it wasn't
# compiled for — it logs `use gpu = 1` and silently decodes on the CPU thread pool.
# So `context_params={"use_gpu": True}` in models/whisper_cpp_loader.py was a no-op
# and the platform-default ml-en GGUF pipeline ran on whisper_cpp_num_threads CPU
# threads while torch/onnxruntime-gpu held an idle CUDA context.
#
# Upstream documents CUDA support as a source build gated on GGML_CUDA=1. Its
# setup.py turns EVERY environment variable into a `-D<KEY>=<VALUE>` CMake define,
# which is how all three flags below reach CMake.
#
#   GGML_CUDA=1              enable ggml's CUDA backend.
#   CMAKE_CUDA_ARCHITECTURES pinned deliberately: ggml defaults to `native`, which
#                            probes the BUILDER's GPU — on a GPU-less CI runner that
#                            yields a wrong-arch or CPU-only build, failing silently
#                            exactly like the wheel did. 89 = Ada Lovelace
#                            (RTX A2000 Ada / L4 / 4090). Update with the deploy GPU.
#   BUILD_SHARED_LIBS=OFF    REQUIRED, not an optimization. Upstream's CMakeLists is
#                            `add_subdirectory(whisper.cpp)` + link `whisper`, with no
#                            install rule and no RPATH, so a shared whisper.cpp build
#                            leaves `_pywhispercpp.so` linked against a libwhisper.so.1
#                            that is never copied into site-packages —
#                            `ImportError: libwhisper.so.1: cannot open shared object
#                            file` at import. The published wheels only work because
#                            cibuildwheel runs `auditwheel repair` to vendor it; a
#                            source install gets no such repair. Static-linking whisper
#                            + ggml into the extension removes the dangling reference
#                            entirely and keeps everything inside /opt/venv, which is
#                            all the ml-runtime stage copies. CUDA itself stays
#                            dynamic (libcudart/libcublas from the -runtime base).
#   CMAKE_POSITION_INDEPENDENT_CODE  static archives must be -fPIC to link into a
#                            shared Python extension; not guaranteed by default and
#                            the failure is a link-time relocation error.
#
# Set inline rather than as ENV: with setup.py's env->define conversion, a persistent
# ENV would leak these defines into any later source build in this stage.
RUN --mount=type=cache,target=/root/.cache/uv \
    GGML_CUDA=1 \
    CMAKE_CUDA_ARCHITECTURES=89 \
    BUILD_SHARED_LIBS=OFF \
    CMAKE_POSITION_INDEPENDENT_CODE=ON \
    uv pip install --python /opt/venv/bin/python \
        --reinstall-package pywhispercpp \
        "pywhispercpp @ git+https://github.com/absadiki/pywhispercpp@v1.5.0"

# Two-part gate. `set -eu` matters: if the extension fails to LOAD, the import's own
# error (e.g. a dangling libwhisper.so.1) must surface instead of being swallowed and
# reported as the unrelated "built without CUDA". Only a loadable-but-CPU extension
# should reach the grep.
RUN set -eu; \
    ext=$(/opt/venv/bin/python -c "import _pywhispercpp as p; print(p.__file__)"); \
    echo "pywhispercpp extension: $ext"; \
    ldd "$ext"; \
    ldd "$ext" | grep -qiE "libcudart|libcublas" \
      || { echo "FATAL: pywhispercpp loaded but linked no CUDA runtime — whisper.cpp would fall back to CPU"; exit 1; }

# The two workspace path deps (hope-runtime-models, hope-env) resolve as EDITABLE
# under `uv pip install` (tool.uv.sources workspace=true) — an
# `__editable__.<pkg>.pth` in site-packages whose sole content is an absolute path
# to the build tree (/build/packages/*/src). The ml-runtime/worker stages copy
# ONLY /opt/venv (never /build), so that link dangles at import time:
# `ModuleNotFoundError: No module named 'hope_env'`. Re-install both as plain,
# baked-in wheels so their code lives INSIDE site-packages and survives the
# venv-only copy — the `uv pip install` analogue of the CPU builder's
# `uv sync --no-editable`. --no-sources treats the paths as ordinary local dirs
# (not workspace members, so no editable link); --no-deps skips the already-
# resolved dependency tree; --reinstall-package overwrites the editable install.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python \
        --no-deps --no-sources \
        --reinstall-package hope-runtime-models \
        --reinstall-package hope-env \
        ./packages/py-runtime-models ./packages/py-env

RUN find /opt/venv \( \
        -name "__pycache__" \
        -o -name "*.egg-info" \
    \) -type d -exec rm -rf {} + 2>/dev/null || true \
    && find /opt/venv \( \
        -name "*.pyc" -o -name "*.pyo" \
        -o -name "*.mo" -o -name "*.ipynb" \
    \) -type f -delete 2>/dev/null || true \
    && rm -rf /opt/venv/lib/python3.11/site-packages/torch/test \
              /opt/venv/lib/python3.11/site-packages/torch/utils/benchmark \
              /opt/venv/lib/python3.11/site-packages/caffe2 \
       2>/dev/null || true

# =============================================================================
# Stage 3: Runtime — lightweight API server (CPU only, no ML deps)
# =============================================================================
FROM ${BASE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="stt" \
    org.opencontainers.image.description="High-availability Speech-to-Text service"

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 ffmpeg

COPY --from=builder --chown=hope:hope /app/.venv /app/.venv
COPY --chown=hope:hope apps/stt/src ./src

ENV PYTHONPATH=/app/src

USER hope

EXPOSE 8861

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8861/api/v1/health')"]

CMD ["uvicorn", "stt.main:app", "--host", "0.0.0.0", "--port", "8861"]

# =============================================================================
# Stage 4: ML Runtime — full inference stack (GPU with CPU fallback)
# =============================================================================
FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu22.04 AS ml-runtime

LABEL org.opencontainers.image.title="stt-ml" \
    org.opencontainers.image.description="STT ML runtime (CUDA GPU with automatic CPU fallback)" \
    org.opencontainers.image.vendor="ARCA AI"

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
    && apt-get install -y --no-install-recommends \
        libsndfile1 ffmpeg \
    && groupadd --gid 1001 hope \
    && useradd --uid 1001 --gid hope --create-home --shell /bin/bash hope \
    && mkdir -p /models && chown -R hope:hope /app /models

# Interpreter AND venv both come from ml-builder — no apt python here either (it
# would be the same 3.11.0rc1). /opt/python must land at the builder's
# UV_PYTHON_INSTALL_DIR path, because /opt/venv symlinks into it.
COPY --from=ml-builder --chown=hope:hope /opt/python /opt/python
COPY --from=ml-builder --chown=hope:hope /opt/venv /opt/venv
COPY --chown=hope:hope apps/stt/src ./src

USER hope

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src \
    HF_HOME=/models/hf-cache \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    OTEL_SERVICE_NAME=stt \
    OTEL_EXPORTER_ENDPOINT=http://localhost:4317 \
    OTEL_ENABLED=false \
    METRICS_ENABLED=true

EXPOSE 8861

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD ["/opt/venv/bin/python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8861/api/v1/health')"]

CMD ["/opt/venv/bin/python", "-m", "uvicorn", "stt.main:app", "--host", "0.0.0.0", "--port", "8861"]

# =============================================================================
# Stage 5: Worker — Dramatiq worker extending ml-runtime
# =============================================================================
FROM ml-runtime AS worker

CMD ["/opt/venv/bin/python", "-m", "dramatiq", "stt.worker", "--processes", "2", "--threads", "4"]
