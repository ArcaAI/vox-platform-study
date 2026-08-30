# TASK-824 — HOPE GGUF serving tier.
#
# ============================================================================
# WHY THIS IS A THIN LAYER AND NOT A `llmster` BUILD
# ============================================================================
# The original ticket (§4.6) specified a custom headless LM Studio image built
# from the `llmster` bundle. TASK-831 landed after that decision and inverted
# the engine question — see this ticket's §2A for the full argument. The short
# version: two of the five catalogue models are vision + AUDIO, LM Studio has
# no evidence of audio support, and llama.cpp is MIT with official GPU images.
#
# The consequence for THIS file is the part worth stating loudly:
#
#   §4.1 called `curl install.sh | bash` "the highest-probability failure in
#   this ticket" — it probes the BUILD host for `nvidia-smi` and silently
#   produces a CPU-only image that serves happily at a fraction of throughput.
#
# That failure mode is not mitigated here. It is STRUCTURALLY ABSENT: the
# accelerator is named in the tag AND frozen in the digest below. There is no
# build-host probe to get wrong, and no §8.4 exec-based runtime survey needed
# to detect it after the fact.
#
# ============================================================================
# BUILD FLOOR — VERIFIED, NOT ASSUMED
# ============================================================================
# TASK-831 §4.1 sets a hard floor of llama.cpp build b9383 (2026-05-28).
# Below it, two bugs produce plausible-but-wrong multimodal output with NO
# error: a post-norm/pre-norm projector bug and an audio RMS-norm eps bug.
#
# This image pins b9853 (2026-07-01), git rev 7af4279f4579094cbe121cccb3c28357396e55d0.
# The floor was verified by confirming the FIX COMMITS are ancestors of that
# revision, not by comparing build numbers:
#
#   PR #23822 (projector pre_norm fix)   merge c8914ad4f44e -> ahead_by=453, behind_by=0
#   PR #23815 (audio rms_norm eps fix)   merge d6be3158e1fa -> ahead_by=460, behind_by=0
#   PR #21309 (gemma 4 vision support)   merge 63f8fe0ef4d1 -> ahead_by=1216, behind_by=0
#   PR #21421 (gemma 4 audio encoder)    merge 547765a93e5a -> ahead_by=1087, behind_by=0
#
# `behind_by=0` on all four is the actual proof. Re-run the check in
# `verify-build-floor.py` (this directory) after ANY digest bump.
#
# NOTE: b9383 itself is NOT a published image tag — ggml-org publishes only a
# subset of builds. b9853 is a published build comfortably past the floor.
# Do not "fix" the pin to b9383; that tag returns 404.
#
# ============================================================================
# DIGEST PIN
# ============================================================================
# Tag AND digest. The tag documents intent; the digest is what actually
# resolves. §8.6 requires digest pinning because llama.cpp publishes no
# API stability guarantee.
#
#   ghcr.io/ggml-org/llama.cpp:server-cuda-b9853
#   digest sha256:62a1d4e144789aa3dd6948d350388fd4b9ac4d12744f33213a89c4e5a9af25df
#   (multi-arch index: linux/amd64 + linux/arm64; ~2.6 GB compressed)
#
# The CPU counterpart, used for local/CI verification on non-NVIDIA hosts:
#   ghcr.io/ggml-org/llama.cpp:server-b9853
#   digest sha256:5f05878dd6ba327e7ada531737b6b883b0df1737470678ba10d52f34e1d8b32d
#
# Build the CPU variant with:  --build-arg BASE_IMAGE=<cpu ref above>
ARG BASE_IMAGE=ghcr.io/ggml-org/llama.cpp:server-cuda-b9853@sha256:62a1d4e144789aa3dd6948d350388fd4b9ac4d12744f33213a89c4e5a9af25df

FROM ${BASE_IMAGE}

# Re-declared after FROM so it is readable in the build-info label below.
ARG BASE_IMAGE
ARG LLAMA_BUILD=b9853
ARG LLAMA_REVISION=7af4279f4579094cbe121cccb3c28357396e55d0

LABEL org.opencontainers.image.title="hope-llama-cpp" \
      org.opencontainers.image.description="HOPE GGUF serving tier (llama.cpp server, CUDA)" \
      org.opencontainers.image.base.name="${BASE_IMAGE}" \
      dev.arcaai.llama.build="${LLAMA_BUILD}" \
      dev.arcaai.llama.revision="${LLAMA_REVISION}" \
      dev.arcaai.build-floor="b9383" \
      dev.arcaai.ticket="TASK-824"

# The upstream image is distroless-ish: it carries llama-server plus its runtime
# libs and NOT much else. We add exactly two things and nothing more:
#   1. curl  — the probes below and the entrypoint's readiness wait need it.
#   2. jq    — the entrypoint asserts /props JSON (modalities, build_info).
# Kept deliberately minimal; every added package is attack surface in a PHI pod.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl jq ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/hope-entrypoint.sh
RUN chmod 0755 /usr/local/bin/hope-entrypoint.sh

# Non-root. Unlike the llmster path (§4.9 item 3, bug #2093 — llmster has been
# reported to hardcode /root/.lmstudio and ignore $HOME in containers), llama-server
# holds no per-user state at all: weights come from a read-only mount and the
# only writable path it needs is an optional slot-save dir we do not enable.
# So non-root here is uneventful, which is the point — L-7 is satisfied without
# a "document why it cannot be non-root" escape.
RUN useradd -u 10001 -m -d /home/hope -s /usr/sbin/nologin hope
USER 10001:10001
ENV HOME=/home/hope

# Weights are mounted, never baked. §3.3: an 8B image pull + extract measures
# ~11 min, versus ~40s from a warm PVC at 3.5 GB/s.
VOLUME ["/models"]
EXPOSE 8080

# LIVENESS + READINESS IN ONE ENDPOINT.
# `GET /health` returns 503 while the model is still loading and 200 when it is
# resident. This is the single biggest operational difference from LM Studio,
# whose §4.11 problem is that it returns HTTP 200 for UNKNOWN paths (bug #1323),
# so a generic path probe always passes even against a broken server, and whose
# §4.3 readiness story needs JIT-off + preload + /v1/models or an exec of `lms ps`.
#
# VERIFIED on the CPU image, build b9853: /health -> {"status":"ok"} when ready.
# In router mode the router answers /health as soon as the ROUTER is up (children
# load on demand), so the k8s readinessProbe for the router Deployment targets
# /v1/models instead — see llama-cpp.yaml.
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${LLAMA_ARG_PORT:-8080}/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/hope-entrypoint.sh"]
