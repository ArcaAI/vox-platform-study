# TASK-246: Python Docker Image Optimization

**Ticket**: TASK-246
**Type**: Infrastructure / Optimization
**Created**: 2026-03-23
**Updated**: 2026-03-23
**Status**: Completed

---

## Requirement Analysis

### Description
Optimize Docker images for all Python services (NLP, SMR, STT) to reduce image sizes from ~5.69GB to the smallest possible while maintaining functionality.

### Business Context
Large Docker images increase deployment time, storage costs, and CI/CD pipeline duration. The 5.69GB images were primarily caused by CUDA binaries shipped with PyTorch and inefficient multi-stage build patterns.

### Acceptance Criteria
- [x] All Python service images build successfully
- [x] All runtime dependencies verified working inside containers
- [x] Significant image size reduction achieved
- [x] No functional regressions
- [x] Missing `.dockerignore` files created

---

## Current State Evaluation

### Before Optimization

| Service | Key Issues |
|---------|-----------|
| NLP | PyTorch with CUDA binaries (~2.3GB), outdated uv (0.4.29), double-copy venv pattern, `editdistpy` build failure masked by `\|\| true` |
| SMR | Missing `.dockerignore`, `wget` installed for healthcheck, unnecessary `src/` copy in builder, fragile version pins |
| STT | Builder installed `ml-gpu,dev,test` extras for runtime target, copied entire `/usr/local/bin`, used `pip` instead of `uv`, no `.pyc` cleanup |

### Root Causes of 5.69GB Images
1. **PyTorch CUDA binaries** (~1.5-2.3GB): Default PyTorch wheels include CUDA libraries even when not needed
2. **Dev/test dependencies in production**: Builder stages installed dev and test extras
3. **Full `/usr/local/bin` copy**: Copied all builder binaries instead of specific entry points
4. **No artifact cleanup**: `.pyc`, `.pyo`, `__pycache__`, `.egg-info` files retained
5. **Missing `.dockerignore`**: Large build contexts sent to Docker daemon

---

## Implementation Summary

### Optimization Strategies Applied

1. **PyTorch CPU-only index** (`--extra-index-url https://download.pytorch.org/whl/cpu`): Saves ~1.5GB per image by avoiding CUDA binaries
2. **CUDA library stripping**: Remove `nvidia/` directory and CUDA `.so` files from torch for CPU-only deployments
3. **uv package manager** (v0.8.13): Replaced pip with uv for faster installs; used `ghcr.io/astral-sh/uv` multi-stage copy pattern
4. **Selective binary copy**: Copy only `uvicorn` and `dramatiq` binaries instead of entire `/usr/local/bin`
5. **Artifact cleanup**: Remove `.pyc`, `.pyo`, `__pycache__`, `.egg-info`, strip `.so` files
6. **Python-based healthcheck**: Replace `wget`/`curl` with `python -c "import urllib.request; ..."` to avoid installing extra packages
7. **New CPU ML target for STT**: Added `ml-runtime-cpu` and `worker-cpu` targets that use CPU-only PyTorch

### Image Size Results

| Service | Target | Size | Notes |
|---------|--------|------|-------|
| SMR | production | **211MB** | No ML deps, pure API service |
| STT | runtime | **696MB** | No ML deps, API + task queue |
| NLP | production | **981MB** | Includes PyTorch CPU, spacy, transformers, scikit-learn, pandas |

### Files Changed

| File | Change |
|------|--------|
| `apps/nlp/Dockerfile` | Rewrote: uv from ghcr.io, `uv pip install --system`, CUDA stripping, distroless production stage with correct PYTHONPATH |
| `apps/nlp/pyproject.toml` | Added `[tool.uv.extra-build-dependencies]` for editdistpy/setuptools |
| `apps/nlp/uv.lock` | Regenerated with updated dependency versions |
| `apps/smr/Dockerfile` | Rewrote: uv from ghcr.io, `uv sync --frozen`, removed wget, Python-based healthcheck |
| `apps/smr/.dockerignore` | **Created**: Excludes VCS, Python artifacts, tests, IDE files, env files |
| `apps/stt/docker/Dockerfile` | Rewrote: 8 stages (builder, ml-builder, gpu-builder, runtime, ml-runtime-cpu, ml-runtime, worker, worker-cpu), uv for CPU stages, selective binary copy |
| `apps/stt/docker/Dockerfile.apple` | Rewrote: uv-based builder, separate ml-builder-apple stage, proper multi-stage |
| `apps/stt/Makefile` | Added `docker-build-ml-cpu`, `docker-build-worker-cpu` targets, updated CI build |

### Key Design Decisions

1. **NLP uses `uv pip install` instead of `uv sync`**: The `editdistpy` package (transitive dep of `symspellpy`) requires `pkg_resources` at build time but doesn't declare it. `uv sync` uses build isolation which breaks this. `uv pip install --system` works around it.

2. **STT new `ml-runtime-cpu` target**: Previously there was no way to run ML inference without the NVIDIA CUDA base image. The new target uses `python:3.11-slim` with CPU-only PyTorch, suitable for development, testing, and CPU-based production deployments.

3. **Distroless for NLP production**: Kept `gcr.io/distroless/python3-debian12:nonroot` for the smallest attack surface. Required explicit `PYTHONPATH` since distroless doesn't include `/usr/local/lib/python3.11/site-packages` in default path.

4. **Commit-pinned image tagging**: Replaced `latest`-only tagging in GitLab CI with a multi-tag strategy: every image gets a commit SHA tag (`a1b2c3d4`), a branch-SHA tag (`main-a1b2c3d4`), and `latest` as a convenience alias. Semver releases (`v1.0.0`) additionally get the version tag (`1.0.0`). This ensures every running container is traceable to the exact commit that built it.

---

## Change History

| Date | Description | Files |
|------|-------------|-------|
| 2026-03-23 | Initial optimization of all Python Dockerfiles | See files changed above |
| 2026-03-23 | Replace `latest`-only tagging with commit-pinned multi-tag strategy | `.gitlab-ci.yml`, `apps/stt/Makefile`, `apps/stt/scripts/validate-build.sh` |
| 2026-03-23 | Phase 2: Comprehensive review & optimization pass | See below |
| 2026-03-23 | Phase 3: STT GPU dependency optimization — eliminate ~2.9 GB redundant downloads | `apps/stt/docker/Dockerfile` |
| 2026-03-23 | Phase 4: GitLab Runner config review & security fixes | `research/configs/gitlab-runner/config.toml` |
| 2026-03-23 | Phase 5: Registry metadata database migration — fix "missing manifest digest" | `research/configs/gitlab/gitlab.rb` |

### Phase 2: Review & Optimization (2026-03-23)

Comprehensive review against 2025-2026 Docker best practices with research from official uv docs, PythonSpeed, and BuildKit documentation.

#### SMR Dockerfile (`apps/smr/Dockerfile`)
- Added `# syntax=docker/dockerfile:1` BuildKit directive
- Upgraded base from `python:3.11-slim` to `python:3.11-slim-trixie` (latest Debian)
- Added `UV_COMPILE_BYTECODE=1`, `UV_LINK_MODE=copy`, `UV_PYTHON_DOWNLOADS=never`
- Replaced `COPY pyproject.toml uv.lock` with `--mount=type=bind` for dependency layer
- Added `--no-editable` flag to prevent broken `.pth` references
- Added apt cache mounts (`--mount=type=cache,target=/var/cache/apt,sharing=locked`)
- Fixed cleanup: removed `*.dist-info` from exclusion list (breaks `importlib.metadata`)
- Added `PATH="/app/.venv/bin:$PATH"` for proper venv activation
- Increased healthcheck `start-period` from 10s to 30s
- Changed healthcheck to exec form (JSON array) for proper signal handling

#### NLP Dockerfile (`apps/nlp/Dockerfile`)
- Replaced hardcoded `uv pip install` with lockfile-based `uv sync --locked` for reproducible builds
- `editdistpy` build issue now handled by `[tool.uv.extra-build-dependencies]` in pyproject.toml
- Replaced distroless production stage with `python:3.11-slim-trixie` + non-root user for better operability
- Added healthcheck to production stage (was missing — distroless had no shell)
- Increased debug healthcheck `start-period` from 5s to 60s (spaCy model loading)
- Replaced `curl` healthcheck with `python -c urllib` (removes 9.3MB curl dependency)
- Added `PATH` env var for proper venv activation in production stage

#### STT Dockerfile (`apps/stt/docker/Dockerfile`)
- Added `# syntax=docker/dockerfile:1` BuildKit directive
- Replaced `rm -rf /var/lib/apt/lists/*` with `--mount=type=cache,target=/var/cache/apt,sharing=locked` across all stages (builder, ml-builder, gpu-builder, cpu-runtime-base, ml-runtime)

#### GitLab CI (`.gitlab-ci.yml`)
- **SECURITY FIX**: Removed hardcoded GitHub PAT, replaced with `$GITHUB_BACKUP_USER` / `$GITHUB_BACKUP_TOKEN` CI variables
- Added `compression=zstd` to registry cache for 30-50% faster cache push/pull

#### .dockerignore Files
- Standardized SMR and NLP `.dockerignore` to match STT structure
- Added CI/CD exclusions (`.github/`, `.gitlab-ci.yml`) to all services
- Added `.gitattributes` exclusion

#### Files Modified
| File | Change Type |
|------|-------------|
| `apps/smr/Dockerfile` | Optimized |
| `apps/smr/.dockerignore` | Standardized |
| `apps/nlp/Dockerfile` | Rewritten |
| `apps/nlp/.dockerignore` | Standardized |
| `apps/stt/docker/Dockerfile` | Optimized |
| `apps/stt/.dockerignore` | Updated |
| `.gitlab-ci.yml` | Security fix + optimization |

### Phase 3: STT GPU Dependency Optimization (2026-03-23)

#### Problem: ~2.9 GB Redundant NVIDIA Downloads

The `stt` and `stt-worker` builds were downloading ~2.9 GB of `nvidia-*` pip packages and `triton` during every uncached build, only to uninstall them immediately after. The Phase 2 "install-then-uninstall" approach still wasted bandwidth and 10-12 minutes of build time.

#### Codebase Audit Findings

A thorough audit of `apps/stt/src/` confirmed:

- **Zero direct imports** of any `nvidia.*` Python package
- **Zero `torch.compile()` calls** — `triton` not needed
- **Zero distributed training** — `nccl` not needed
- **All CUDA libraries** (`cublas`, `cudnn`, `cufft`, `curand`, `nvrtc`, `cusparse`, `cusolver`) are already provided as system libraries by the `nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04` base image
- The codebase is **100% inference-only**: `torch.no_grad()`, `model.generate()`, `.to(device)`, `torch.cuda.is_available()` — no training, no autograd

#### Solution: `uv` Override File

Replaced the "download-then-uninstall" approach with a `uv pip install --override` strategy using `sys_platform == "never"` markers. This prevents `uv` from downloading the packages during dependency resolution.

**Packages excluded via override** (15 total):
`nvidia-cublas-cu12`, `nvidia-cuda-cupti-cu12`, `nvidia-cuda-nvrtc-cu12`, `nvidia-cuda-runtime-cu12`, `nvidia-cudnn-cu12`, `nvidia-cufft-cu12`, `nvidia-curand-cu12`, `nvidia-cusolver-cu12`, `nvidia-cusparse-cu12`, `nvidia-cusparselt-cu12`, `nvidia-nccl-cu12`, `nvidia-nvjitlink-cu12`, `nvidia-cufile-cu12`, `nvidia-nvtx-cu12`, `triton`

**Impact**: Eliminates ~2.9 GB of wasted downloads and ~10-12 minutes of build time per uncached build. No changes to `pyproject.toml` or `uv.lock` — the override is Dockerfile-scoped.

#### STT Dockerfile Architecture (Final)

| Stage | Base Image | Purpose |
|-------|-----------|---------|
| `builder` | `python:3.11-slim-trixie` | Install core API dependencies via `uv sync` |
| `ml-builder` | `nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04` | Install ML + GPU deps with NVIDIA override |
| `runtime` | `python:3.11-slim-trixie` | CPU-only API server |
| `ml-runtime` | `nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04` | GPU-capable ML inference server (with CPU fallback) |
| `worker` | `ml-runtime` | Dramatiq worker for async ML tasks |

#### Files Modified

| File | Change |
|------|--------|
| `apps/stt/docker/Dockerfile` | Replaced install-then-uninstall with `--override` strategy |

---

### Phase 4: GitLab Runner Config Review (2026-03-23)

Reviewed `research/configs/gitlab-runner/config.toml` (VM 411) against the CI pipeline requirements.

#### Changes Applied

| Setting | Before | After | Reason |
|---------|--------|-------|--------|
| `concurrent` (global) | 16 | 9 | Match actual sum of runner limits (8 vCPU / 16 GB host) |
| `build-runner-01` `limit` | 3 | 2 | Prevent resource saturation during heavy Docker builds |
| `build-runner-01` `output_limit` | default (4096) | 20480 (20 MB) | Prevent log truncation for verbose ML builds |
| `build-runner-01` `image` | `docker:27-dind` | `docker:27` | DinD not needed — runner uses host Docker socket |
| `build-runner-01` `shm_size` | 256 MB | 512 MB | Prevent OOM in multi-stage BuildKit builds |
| `build-runner-01` `GIT_STRATEGY` | `clone` | `fetch` | Faster CI starts — reuse existing repo |
| `build-runner-01` `GIT_DEPTH` | unset | 1 | Shallow clone — only need current commit for builds |
| `fast-runner-01` / `test-runner-01` `GIT_DEPTH` | unset | 10 | Shallow but enough history for test/lint operations |
| `deploy-runner-01` `GIT_STRATEGY` | `clone` | `clone` (kept) | Deploy needs clean state for safety |

#### Security Fixes

- Redacted all hardcoded `glrt-...` runner tokens with `<REDACTED_*>` placeholders
- Redacted MinIO S3 `AccessKey`/`SecretKey` credentials across all runner cache configs

#### Files Modified

| File | Change |
|------|--------|
| `research/configs/gitlab-runner/config.toml` | Performance tuning + credential redaction |

---

### Phase 5: Registry Metadata Database Migration (2026-03-23)

#### Problem: "Invalid tag: missing manifest digest" on All Images

All images in the GitLab Container Registry UI showed "Invalid tag: missing manifest digest" with 0B size. Images were actually pushed correctly and could be pulled — this was a UI/metadata parsing issue.

#### Root Cause

Docker BuildKit (used via `docker buildx build --push`) creates images with **OCI image index format** (`application/vnd.oci.image.index.v1+json`) and provenance attestations by default. GitLab's **legacy Container Registry** stores metadata only in object storage (MinIO S3) and cannot parse OCI index manifests when rendering the UI.

#### Solution: Enable Registry Metadata Database

Instead of adding `--provenance=false` to the CI pipeline (a workaround that suppresses OCI features), enabled the **Registry Metadata Database** — a PostgreSQL-backed metadata store available since GitLab 17.3+.

On GitLab 18.3+ (current: 18.8.6), the database is auto-provisioned as a logical database within the main GitLab PostgreSQL instance. No external database setup required.

#### Benefits

- **OCI manifest support**: BuildKit images with provenance attestations display correctly
- **Online garbage collection**: Automatic cleanup of untagged manifests (replaces manual `registry-garbage-collect -m`)
- **Tag listing performance**: Metadata queries hit PostgreSQL instead of walking S3 objects
- **Storage visibility**: Repository/project/group-level storage usage tracking
- **No CI pipeline changes needed**: BuildKit defaults work as-is

#### Migration Procedure (VM 410)

The migration requires a brief **read-only window** for the registry (pulls work, pushes blocked):

1. Add `registry['database'] = { 'enabled' => false }` and `'maintenance' => { 'readonly' => { 'enabled' => true } }` to `registry['storage']` in `gitlab.rb`, then `gitlab-ctl reconfigure`
2. Run `sudo -u registry gitlab-ctl registry-database migrate up` to create schema
3. Run `sudo -u registry gitlab-ctl registry-database import --log-to-stdout` to import existing metadata
4. Set `registry['database'] = { 'enabled' => true }`, remove `maintenance` block, then `gitlab-ctl reconfigure`

#### Important Notices

| Notice | Detail |
|--------|--------|
| **One-way migration** | After enabling the database, it becomes the source of truth. Reverting requires restoring from a pre-migration backup |
| **Timestamp reset** | `createdAt` / `publishedAt` timestamps on existing tags reset to the import date — the legacy registry does not track original tag publish dates |
| **Backup coverage** | `gitlab-backup` does **not** separately back up the registry database. Since it's a logical database within the main GitLab PostgreSQL instance, it is covered by the main PostgreSQL backup. If using an external database, manual backup management is required |
| **Read-only during import** | The registry must be in read-only mode during the import. Duration depends on the number of tagged images — typically minutes for small registries |
| **No offline GC needed** | After migration, online GC runs automatically. The legacy `registry-garbage-collect` command safely exits when the database is enabled. Verify no third-party GC cron jobs are scheduled |
| **Post-import GC load** | Expect ~48 hours of elevated database load after import as online GC drains its initial queues. Monitor via `registry_gc_*` Prometheus metrics |

#### Files Modified

| File | Change |
|------|--------|
| `research/configs/gitlab/gitlab.rb` | Added `registry['database'] = { 'enabled' => true }` block |
