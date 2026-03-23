# TASK-246: Python Docker Image Optimization

**Ticket**: TASK-246
**Type**: Infrastructure / Optimization
**Created**: 2026-03-23
**Updated**: 2026-03-23
**Status**: Completed

---

## Requirement Analysis

### Description
Optimize Docker images for all Python services (NLP, SMR, STT-v2) to reduce image sizes from ~5.69GB to the smallest possible while maintaining functionality.

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
| STT-v2 | Builder installed `ml-gpu,dev,test` extras for runtime target, copied entire `/usr/local/bin`, used `pip` instead of `uv`, no `.pyc` cleanup |

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
7. **New CPU ML target for STT-v2**: Added `ml-runtime-cpu` and `worker-cpu` targets that use CPU-only PyTorch

### Image Size Results

| Service | Target | Size | Notes |
|---------|--------|------|-------|
| SMR | production | **211MB** | No ML deps, pure API service |
| STT-v2 | runtime | **696MB** | No ML deps, API + task queue |
| NLP | production | **981MB** | Includes PyTorch CPU, spacy, transformers, scikit-learn, pandas |

### Files Changed

| File | Change |
|------|--------|
| `apps/nlp/Dockerfile` | Rewrote: uv from ghcr.io, `uv pip install --system`, CUDA stripping, distroless production stage with correct PYTHONPATH |
| `apps/nlp/pyproject.toml` | Added `[tool.uv.extra-build-dependencies]` for editdistpy/setuptools |
| `apps/nlp/uv.lock` | Regenerated with updated dependency versions |
| `apps/smr/Dockerfile` | Rewrote: uv from ghcr.io, `uv sync --frozen`, removed wget, Python-based healthcheck |
| `apps/smr/.dockerignore` | **Created**: Excludes VCS, Python artifacts, tests, IDE files, env files |
| `apps/stt-v2/docker/Dockerfile` | Rewrote: 8 stages (builder, ml-builder, gpu-builder, runtime, ml-runtime-cpu, ml-runtime, worker, worker-cpu), uv for CPU stages, selective binary copy |
| `apps/stt-v2/docker/Dockerfile.apple` | Rewrote: uv-based builder, separate ml-builder-apple stage, proper multi-stage |
| `apps/stt-v2/Makefile` | Added `docker-build-ml-cpu`, `docker-build-worker-cpu` targets, updated CI build |

### Key Design Decisions

1. **NLP uses `uv pip install` instead of `uv sync`**: The `editdistpy` package (transitive dep of `symspellpy`) requires `pkg_resources` at build time but doesn't declare it. `uv sync` uses build isolation which breaks this. `uv pip install --system` works around it.

2. **STT-v2 new `ml-runtime-cpu` target**: Previously there was no way to run ML inference without the NVIDIA CUDA base image. The new target uses `python:3.11-slim` with CPU-only PyTorch, suitable for development, testing, and CPU-based production deployments.

3. **Distroless for NLP production**: Kept `gcr.io/distroless/python3-debian12:nonroot` for the smallest attack surface. Required explicit `PYTHONPATH` since distroless doesn't include `/usr/local/lib/python3.11/site-packages` in default path.

4. **Commit-pinned image tagging**: Replaced `latest`-only tagging in GitLab CI with a multi-tag strategy: every image gets a commit SHA tag (`a1b2c3d4`), a branch-SHA tag (`main-a1b2c3d4`), and `latest` as a convenience alias. Semver releases (`v1.0.0`) additionally get the version tag (`1.0.0`). This ensures every running container is traceable to the exact commit that built it.

---

## Change History

| Date | Description | Files |
|------|-------------|-------|
| 2026-03-23 | Initial optimization of all Python Dockerfiles | See files changed above |
| 2026-03-23 | Replace `latest`-only tagging with commit-pinned multi-tag strategy | `.gitlab-ci.yml`, `apps/stt-v2/Makefile`, `apps/stt-v2/scripts/validate-build.sh` |
