# =============================================================================
# TASK-824 — LM Studio (`llmster`) headless GPU serving image
# =============================================================================
# Owner decision 2026-08-30 (README §0): LM Studio + vLLM. The llama.cpp
# recommendation in §2A was considered and OVERRULED. This is the plan of
# record; ../image/ is retained only as the record of that argument and as the
# documented escape hatch (§2).
#
# The image embeds a PROPRIETARY binary we hold no redistribution right to.
# PUSH TO THE INTERNAL REGISTRY ONLY (§0 risk A-5, §5 L-2).
#
# -----------------------------------------------------------------------------
# THE TRAP THIS FILE EXISTS TO DEFEAT (§4.1, §0 risk A-3)
# -----------------------------------------------------------------------------
# `curl -fsSL https://lmstudio.ai/install.sh | bash` picks its bundle from the
# BUILD HOST. Re-verified against the live script on 2026-08-30:
#
#   install.sh:243 get_release_name()      "Linux x86_64" -> full${_bundle_suffix}
#   install.sh:594 get_linux_x86_full_bundle_suffix()
#                    -> "+cuda12" if supports_cuda_12_4_or_newer, else ""
#   install.sh:586 _minimum_driver_version="550.54.14"
#   install.sh:447 if ! check_cmd nvidia-smi; then echo ""; return 0
#   install.sh:442 if ! check_cmd timeout;    then echo ""; return 0   <-- NOTE
#
# The last line is a SECOND trigger the ticket did not record: a builder that
# lacks coreutils `timeout` gets the CPU bundle EVEN ON A GPU HOST. Two
# independent ways to silently ship a CPU-only image that starts, serves and
# answers.
#
# So we never run the installer's selection logic. We fetch ONE pinned URL and
# verify a pinned SHA-512. The two bundles are provably different artifacts
# (verified 2026-08-30 by fetching both .sha512 files):
#
#   full+cuda12.tar.gz  145d84440b8797614edb39b1019085c90fbc215c...  <- we pin
#   full.tar.gz         29464e0cc52bdf31f6feb9d280d1f499cbef494f...  <- CPU
#
# Therefore a CPU tarball CANNOT satisfy this build: sha512sum -c aborts it.
# That closes the BUILD half of A-3. The RUNTIME half — a correct image landing
# on a node with no GPU, no runtimeClassName, or a driver below the floor — is
# closed by the entrypoint's HOPE_EXPECT_ACCEL assertion, because §8.4
# establishes that a CPU-only deployment is UNDETECTABLE OVER HTTP.
# =============================================================================

# Base and artifact travel together. Defaults are the production pair.
# The arm64 pair exists ONLY so the CLI semantics can be exercised on a
# developer machine (see ../image-llmster/README.md); it is never deployed.
ARG BASE_IMAGE=nvidia/cuda:12.8.1-runtime-ubuntu24.04
FROM ${BASE_IMAGE}

ARG LLMSTER_VERSION=0.0.23-1
ARG LLMSTER_ARTIFACT=0.0.23-1-linux-x64.full+cuda12.tar.gz
# VERIFIED 2026-08-30 against llmster.lmstudio.ai/download/<artifact>.sha512
ARG LLMSTER_SHA512=145d84440b8797614edb39b1019085c90fbc215ccf2d73e74bce645a15513b092997c604e3a4ab86092e40b28601eaf85b627393169345f2a0c2a3df8f464367
# What this image is BUILT to accelerate with. Baked in, not passed at runtime,
# so a manifest cannot weaken it. The entrypoint refuses to serve if the
# daemon's actual runtime does not match.
ARG HOPE_BUILD_ACCEL=cuda

ENV DEBIAN_FRONTEND=noninteractive

# libatomic1 + libgomp1: the upstream installer checks for both.
# tini: PID-1 signal handling and zombie reaping.
# coreutils is present in the base; `timeout` is used by the entrypoint's waits.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl libatomic1 libgomp1 tini \
 && rm -rf /var/lib/apt/lists/*

# Fixed-UID non-root with a REAL home.
# Bug #2093 (open, 2026-06-25) reports llmster hardcoding /root/.lmstudio and
# ignoring $HOME in containers. TESTED IN THIS LANE — see image-llmster/README.md
# for the verdict and the evidence. Fall back to root ONLY with a recorded reason.
RUN useradd -u 10001 -m -d /home/llmster -s /usr/sbin/nologin llmster \
 && mkdir -p /data && chown 10001:10001 /data

USER llmster
ENV HOME=/home/llmster \
    PATH=/home/llmster/.lmstudio/bin:/usr/local/bin:/usr/bin:/bin

# Pinned + checksummed. Deliberately NOT `curl install.sh | bash` — see above.
# `llmster bootstrap` is exactly what install.sh runs after extraction; it writes
# ~/.lmstudio/.internal/llmster-install-location.json with ABSOLUTE paths, which
# is why this stays single-stage (a copy between stages needs an identical $HOME).
RUN set -eu; cd /tmp; \
    curl -fsSL --retry 3 --retry-delay 5 -o llmster.tar.gz \
      "https://llmster.lmstudio.ai/download/${LLMSTER_ARTIFACT}"; \
    echo "${LLMSTER_SHA512}  llmster.tar.gz" | sha512sum -c -; \
    mkdir -p x && tar xf llmster.tar.gz -C x; \
    LMS_BOOTSTRAP_INSTALL_SH=1 LMS_NO_MODIFY_PATH=1 ./x/llmster bootstrap; \
    rm -rf /tmp/llmster.tar.gz /tmp/x; \
    lms version

# ── RUNTIMES MUST BE BAKED INTO THE IMAGE (owner directive, 2026-08-31) ──────
# They ARE. The previous revision of this stage asserted it with
# `lms runtime ls` and failed the build; that was the WRONG PROBE, not a bad
# bundle.
#
# MEASURED, pipeline 1030 / job 15218 (the failing build's own evidence dump):
#   `lms runtime ls`      -> "No runtimes found."
#   ~/.lmstudio/extensions/backends/ ->
#       llama.cpp-linux-x86_64-avx2-2.31.2                 (CPU)
#       llama.cpp-linux-x86_64-vulkan-avx2-2.31.2          (Vulkan)
#       llama.cpp-linux-x86_64-nvidia-cuda12-avx2-2.31.2   (CUDA)
#
# Both are true at once because `lms runtime ls` enumerates runtimes the HOST
# CAN RUN -- it is hardware-filtered. A CI runner has no NVIDIA device, so it
# correctly lists nothing, while the CUDA engine sits on disk. Using it here
# made a GPU a BUILD dependency, which it must never be: buildkit exposes no
# GPU (see the job's own "Platforms: linux/amd64,..." with no device), and an
# image only has to CONTAIN an engine, not exercise it.
#
# So this asserts the FILESYSTEM inventory, which is exactly what "baked in"
# means and is provable on any runner. The runtime half -- does this host have
# a GPU, and did we actually select the CUDA engine -- stays in entrypoint.sh
# A-2, where a device exists.
#
# Owner requirement (2026-08-31): images must be ready for CPU *and* CUDA, so
# both are required and a missing either-half fails the build.
#
# THE DAEMON MUST BE STARTED FIRST. Measured across two jobs:
#   job 15218 — `lms daemon up`, THEN `find ~/.lmstudio` -> three backends
#   job 15283 — no daemon, `ls .../extensions/backends`  -> EMPTY
# Same cached bootstrap layer in both, so `llmster bootstrap` does NOT populate
# extensions/backends; the daemon's FIRST START does. Starting it here means the
# engines are materialised into THIS layer, i.e. genuinely baked into the image
# rather than fetched on first use in the cluster — which is the property the
# owner directive is actually about.
#
# Starting the daemon needs no GPU (it started fine on the GPU-less runner in
# 15218). Reading the DIRECTORY afterwards is the honest probe; `lms runtime ls`
# is not, because it is hardware-filtered and answers about the host.
RUN set -eu; \
    b=/home/llmster/.lmstudio/extensions/backends; \
    lms daemon up >/dev/null || true; \
    i=0; while [ $i -lt 60 ]; do \
      lms daemon status 2>/dev/null | grep -q "is running" && break; \
      i=$((i+1)); sleep 1; \
    done; \
    lms daemon status 2>&1 | head -3; \
    echo "── ${b} ──"; ls -1 "${b}" 2>/dev/null || true; \
    cuda="$(ls -1 "${b}" 2>/dev/null | grep -i 'cuda' | head -1 || true)"; \
    cpu="$(ls -1 "${b}" 2>/dev/null | grep -i '^llama\.cpp' \
             | grep -vi 'cuda\|vulkan\|rocm\|hip\|metal' | head -1 || true)"; \
    if [ -z "${cuda}" ] || [ -z "${cpu}" ]; then \
      echo "── ~/.lmstudio tree (depth 3) ──" >&2; \
      find /home/llmster/.lmstudio -maxdepth 3 2>/dev/null | head -200 >&2; \
    fi; \
    [ -n "${cuda}" ] || { \
      echo "FATAL: no CUDA engine in the image (${b})." >&2; \
      echo "The +cuda12 bundle should install one; the tree above is the evidence." >&2; \
      exit 1; }; \
    [ -n "${cpu}" ] || { \
      echo "FATAL: no CPU engine in the image (${b})." >&2; \
      echo "A CPU-runnable image is an owner requirement, not a fallback." >&2; \
      exit 1; }; \
    echo "OK: CPU engine '${cpu}' and CUDA engine '${cuda}' are baked in."; \
    lms daemon stop >/dev/null 2>&1 || true

# Build-time provenance. `lms` cannot tell you which bundle produced it, so we
# record it ourselves and the entrypoint asserts against it.
#
# `accel` is the build ARG -- a DECLARATION of which bundle was requested. It is
# NOT a measurement, and it must never be read as one: it printed "cuda" on the
# job-15218 image whose CUDA engine was never confirmed. `engines` beside it IS
# the measurement, taken from the filesystem in the stage above.
RUN set -eu; \
    b=/home/llmster/.lmstudio/extensions/backends; \
    engines="$(ls -1 "${b}" 2>/dev/null | paste -sd, - || true)"; \
    printf '{"artifact":"%s","version":"%s","sha512":"%s","accel":"%s","engines":"%s"}\n' \
      "${LLMSTER_ARTIFACT}" "${LLMSTER_VERSION}" "${LLMSTER_SHA512}" "${HOPE_BUILD_ACCEL}" \
      "${engines}" \
      > /home/llmster/.lmstudio/hope-build-info.json; \
    cat /home/llmster/.lmstudio/hope-build-info.json

# Weights live on the mounted volume. ~/.lmstudio — ESPECIALLY .internal/, which
# holds llmster-install-location.json and the daemon's unix socket — stays in the
# image: without it `lms daemon up` fails with "no valid installation could be
# found", and a unix socket on a network volume breaks (§4.4).
RUN rm -rf /home/llmster/.lmstudio/models \
 && ln -s /data/models /home/llmster/.lmstudio/models

# HOPE_EXPECT_ACCEL is DERIVED FROM THE BUILD ARG, never hardcoded. The image
# asserts at runtime what it was actually built to accelerate with, so a
# manifest cannot weaken the guarantee by setting a weaker expectation than the
# bundle delivers — and the arm64 developer image (accel=none) cannot pretend
# to be the production one.
ENV LMS_PORT=1234 \
    LMS_SERVER_HOST=0.0.0.0 \
    HOPE_EXPECT_ACCEL=${HOPE_BUILD_ACCEL} \
    HOPE_MODELS_DIR=/data/models \
    HOPE_STAGING_DIR=/data/staging

VOLUME ["/data"]
EXPOSE 1234

COPY --chown=llmster:llmster entrypoint.sh /usr/local/bin/entrypoint.sh

# ── bake build identity, LAST layer ──────────────────────────────────────────
# These args change on every commit, so they sit below every COPY/RUN and never
# invalidate the (very expensive) bundle-download layer above them. Written to
# /app/build-info.json per docs/operations/build-info.schema.json. Build
# identity is an immutable property of the ARTIFACT and belongs to none of the
# configuration tiers — it must never become settable from a manifest, an env
# file, or turbo.json#globalEnv (09-infrastructure-devops.md §Release Versioning).
USER root
RUN mkdir -p /app && chown 10001:10001 /app
ARG BUILD_SERVICE
ARG BUILD_VERSION
ARG BUILD_RELEASE_TAG
ARG BUILD_GIT_BRANCH
ARG BUILD_GIT_SHA
ARG BUILD_AT
ARG BUILD_CI_PIPELINE_ID
ARG BUILD_CI_PIPELINE_URL
RUN set -eu; \
    release_tag=$( [ -n "${BUILD_RELEASE_TAG:-}" ] && printf '"%s"' "${BUILD_RELEASE_TAG}" || printf 'null' ); \
    pipeline_id=$( [ -n "${BUILD_CI_PIPELINE_ID:-}" ] && printf '"%s"' "${BUILD_CI_PIPELINE_ID}" || printf 'null' ); \
    pipeline_url=$( [ -n "${BUILD_CI_PIPELINE_URL:-}" ] && printf '"%s"' "${BUILD_CI_PIPELINE_URL}" || printf 'null' ); \
    printf '{"service":"%s","version":"%s","releaseTag":%s,"gitBranch":"%s","gitCommitSha":"%s","buildAt":"%s","ciPipelineId":%s,"ciPipelineUrl":%s}\n' \
      "${BUILD_SERVICE}" "${BUILD_VERSION}" "${release_tag}" "${BUILD_GIT_BRANCH}" "${BUILD_GIT_SHA}" "${BUILD_AT}" "${pipeline_id}" "${pipeline_url}" \
      > /app/build-info.json && \
    chown 10001:10001 /app/build-info.json
USER llmster

# §4.11 / bug #1323: LM Studio returns HTTP 200 FOR UNKNOWN PATHS, so a probe on
# any path always passes — including against a broken server. Both the status
# AND the body must be checked. Do NOT "simplify" this to a status-code check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${LMS_PORT}/lmstudio-greeting" | grep -q '"lmstudio":[[:space:]]*true' || exit 1

ENTRYPOINT ["/usr/bin/tini","--","/usr/local/bin/entrypoint.sh"]
