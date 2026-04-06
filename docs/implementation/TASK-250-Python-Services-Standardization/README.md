# TASK-250: Python Services Standardization

**Ticket**: TASK-250
**Type**: Infrastructure / Refactor
**Created**: 2026-03-30
**Updated**: 2026-03-30
**Status**: In Progress

---

## Requirement Analysis

### Description

Standardize the three Python AI services (`nlp`, `smr`, `stt-v2`) to share a unified foundation:
- Same package manager conventions and `pyproject.toml` structure
- Same local development environment setup (conda `arcaenv`)
- Same dependency versions for shared packages
- A shared Docker base image optimized for building all services

### Business Context

The three Python services evolved independently, resulting in divergent tooling, version pins, project structure, and Docker build strategies. This creates:
- **Maintenance burden**: each service requires different mental models and workflows
- **Dependency conflicts**: micro-version mismatches in shared packages (OTel, ruff) can cause subtle runtime differences across environments
- **Docker build inefficiency**: each service pulls and compiles the same base packages independently, wasting CI/CD time and storage
- **Onboarding friction**: new developers must learn three slightly different setups instead of one

### Acceptance Criteria

- [ ] All three services use identical `pyproject.toml` structure (build-system, metadata, tool configs)
- [ ] Shared dependency versions are aligned across all services (zero micro-mismatches)
- [ ] All services use the same linting/formatting/type-checking toolchain (ruff + black + mypy)
- [ ] A shared Docker base image (`hope-python-base`) exists for CPU-only services
- [ ] All service Dockerfiles derive from the shared base image
- [ ] All existing tests still pass after changes
- [ ] `setup-python-env.sh` works correctly with the updated `pyproject.toml` files
- [ ] Docker builds succeed for all three services

### Relationship to Other Tickets

- **TASK-246** (Completed): Docker image size optimization — this ticket builds on that work by introducing a shared base image layer
- **TASK-247** (CI/CD Pipeline): The standardized Docker base image will simplify CI workflows

---

## Current State Evaluation

### Evidence Summary

A thorough audit of all three services was performed (2026-03-30). Below is a side-by-side comparison of every dimension.

### 1. pyproject.toml Structure

| Aspect | NLP | SMR | STT-v2 |
|--------|:---:|:---:|:------:|
| `[build-system]` declared | **MISSING** | `setuptools>=75.0` | `setuptools>=75.0` |
| `authors` | **MISSING** | Present | Present |
| `license` | **MISSING** | `MIT` | `MIT` |
| `classifiers` | **MISSING** | Present | Present |
| `keywords` | **MISSING** | Present | Present |
| `[project.urls]` | **MISSING** | Present | Present |
| `[tool.setuptools.packages.find]` | **MISSING** | Present | Present |
| `[tool.setuptools.package-data]` | **MISSING** | Present | Present |
| `[tool.uv]` (non-standard) | Present | Absent | Absent |
| `[dependency-groups]` (redundant) | Present | Absent | Absent |

**Verdict**: NLP is a minimal skeleton. SMR and STT-v2 are mature. NLP must be upgraded to match.

### 2. Dependency Versions (Shared Packages)

| Package | NLP | SMR | STT-v2 | Target |
|---------|-----|-----|--------|--------|
| `fastapi` | `>=0.133.0` | `>=0.133.0` | `>=0.133.0` | `>=0.133.0` |
| `uvicorn[standard]` | `>=0.41.0` | `>=0.41.0` | `>=0.41.0` | `>=0.41.0` |
| `pydantic` | `>=2.12.5` | `>=2.12.5` | `>=2.12.5` | `>=2.12.5` |
| `pydantic-settings` | `>=2.13.1` | `>=2.13.1` | `>=2.13.1` | `>=2.13.1` |
| `httpx` | `>=0.28.1` | `>=0.28.1` | `>=0.28.1` | `>=0.28.1` |
| `opentelemetry-api` | `>=1.39.1` | **`>=1.39.0`** | `>=1.39.1` | `>=1.39.1` |
| `opentelemetry-sdk` | `>=1.39.1` | **`>=1.39.0`** | `>=1.39.1` | `>=1.39.1` |
| `otel-instr-fastapi` | `>=0.60b1` | `>=0.60b1` | `>=0.60b1` | `>=0.60b1` |
| `otel-exporter` | **`otlp>=1.39.0`** | `otlp-proto-grpc>=1.39.0` | `otlp-proto-grpc>=1.39.0` | `otlp-proto-grpc>=1.39.0` |
| `prometheus-instrumentator` | `>=7.1.0` | `>=7.1.0` | `>=7.1.0` | `>=7.1.0` |
| `prometheus-client` | **MISSING** | `>=0.24.1` | `>=0.24.1` | `>=0.24.1` |
| `structlog` | **MISSING** | `>=25.5.0` | `>=25.5.0` | `>=25.5.0` |
| `python-dotenv` | **MISSING** | `>=1.2.0` | `>=1.2.0` | `>=1.2.0` |
| `orjson` | **MISSING** | `>=3.11.7` | `>=3.11.7` | `>=3.11.7` |
| `python-multipart` | `>=0.0.22` | Not listed | `>=0.0.22` | `>=0.0.22` |
| `aiofiles` | `>=25.1.0` | Not listed | `>=25.1.0` | `>=25.1.0` |
| `numpy` | `>=2.0.0` | Not listed | `>=2.0.0` | `>=2.0.0` |

### 3. Dev/Test/Lint Toolchain

| Tool | NLP | SMR | STT-v2 | Target |
|------|:---:|:---:|:------:|--------|
| `ruff` | `>=0.15.7` | `>=0.15.4` | `>=0.15.4` | `>=0.15.7` |
| `black` | **MISSING** | `>=26.1.0` | `>=26.1.0` | `>=26.1.0` |
| `mypy` | **MISSING** | `>=1.19.1` | `>=1.19.1` | `>=1.19.1` |
| `pre-commit` | **MISSING** | `>=4.5.1` | `>=4.5.1` | `>=4.5.1` |
| `isort` | **MISSING** | Not listed | `>=8.0.0` | **Drop** (ruff `I` rules handle import sorting) |
| `pytest` | `>=9.0.2` | `>=9.0.2` | `>=9.0.2` | `>=9.0.2` |
| `pytest-asyncio` | **MISSING** | `>=1.3.0` | `>=1.3.0` | `>=1.3.0` |
| `pytest-cov` | **MISSING** | `>=7.0.0` | `>=7.0.0` | `>=7.0.0` |
| `pytest-mock` | **MISSING** | `>=3.15.1` | `>=3.15.1` | `>=3.15.1` |
| `pytest-xdist` | **MISSING** | `>=3.8.0` | `>=3.8.0` | `>=3.8.0` |

### 4. Tool Configuration (`[tool.*]` sections in pyproject.toml)

| Config Section | NLP | SMR | STT-v2 | Target |
|---------------|:---:|:---:|:------:|--------|
| `[tool.ruff]` | **MISSING** | Full | Full | Standardize from SMR |
| `[tool.ruff.lint]` | **MISSING** | Full | Full | Standardize from SMR |
| `[tool.ruff.lint.per-file-ignores]` | **MISSING** | Full | Full | Standardize from SMR |
| `[tool.black]` | **MISSING** | Full | Full | Standardize from SMR |
| `[tool.mypy]` | **MISSING** | Full | Full | Standardize from SMR |
| `[tool.pytest.ini_options]` | Minimal | Full | Full | Standardize from SMR |
| `[tool.coverage.run]` | **MISSING** | Full | Full | Standardize from SMR |
| `[tool.coverage.report]` | **MISSING** | Full | Full | Standardize from SMR |

### 5. Docker Build

| Aspect | NLP | SMR | STT-v2 |
|--------|-----|-----|--------|
| Base image | `python:3.11-slim-trixie` | `python:3.11-slim-trixie` | `python:3.11-slim-bookworm` |
| uv source | `ghcr.io/astral-sh/uv:0.8.13` | `ghcr.io/astral-sh/uv:0.8.13` | `ghcr.io/astral-sh/uv:python3.11-bookworm-slim` |
| uv sync flag | `--locked` | `--frozen` | `--locked` |
| User GID | `1001` | `1001` | `1000` |
| User UID | `1001` | `1001` | `1000` |
| Non-root user | `nlpuser:nlpuser` | `smr:hope` | `app:app` |
| Group naming | `nlpuser` | `hope` | `app` |
| Entrypoint style | `python -m nlp.main` | `python -m uvicorn smr_v2.main:app ...` | `uvicorn stt_v2.main:app ...` |
| HEALTHCHECK | Python urllib | Python urllib | Python urllib |
| Cleanup strategy | `strip --strip-unneeded` .so | `strip --strip-unneeded` .so + `.pyc` removal | Full cleanup (see TASK-246) |

### 6. Other Inconsistencies

| Aspect | NLP | SMR | STT-v2 |
|--------|:---:|:---:|:------:|
| `.python-version` file | `3.11` | `3.11` | **MISSING** |
| Makefile | No | No | Yes |
| Logging library | stdlib `logging` | `structlog` | `structlog` |
| Test location | `tests/` (top-level) | `src/smr_v2/tests/` | `tests/` (top-level) |
| `package.json` scripts style | Direct `conda run` | Direct `conda run` | `make -C` delegation |

---

## Implementation Plan

### Design Decisions

#### D1: Drop `isort` in favor of ruff's `I` rules
**Rationale**: ruff already includes isort-compatible import sorting via `"I"` in its rule set. Running a separate `isort` is redundant and adds configuration surface. SMR already does not use `isort`. STT-v2 will have it removed.

#### D2: Standardize on `tests/` at project root (not inside `src/`)
**Rationale**: NLP and STT-v2 both use `tests/` at project root. SMR is the outlier with `src/smr_v2/tests/`. The top-level `tests/` pattern is the more common Python convention and is what `setup-python-env.sh` already expects. SMR's test location will remain as-is for now (moving tests is high-risk for a standardization ticket) but `testpaths` in `pyproject.toml` will be configured correctly for each service.

#### D3: Shared Docker base image
**Rationale**: All three CPU-only services share the same foundation: Python 3.11, uv, non-root user, health-check pattern, cleanup logic. A shared `hope-python-base` image eliminates duplication and ensures consistency. Services only add their own `pyproject.toml`, `uv.lock`, and `src/` on top.

**Base image choice**: `python:3.11-slim-trixie` (Debian Trixie is newer, NLP and SMR already use it; STT-v2 will be migrated from bookworm).

#### D4: Standardize non-root user as `hope:hope` (UID/GID 1001)
**Rationale**: Currently each service uses a different user/group name and inconsistent UID/GID. A unified `hope:hope` user with UID/GID 1001 simplifies volume mounts and security policies.

#### D5: Standardize uv sync flag as `--frozen`
**Rationale**: `--frozen` is stricter than `--locked` — it refuses to update the lockfile at all, which is the correct behavior for Docker builds. Both flags work with existing lockfiles, but `--frozen` makes the intent explicit.

#### D6: Standardize entrypoint as `python -m uvicorn`
**Rationale**: Calling uvicorn via `python -m` ensures the correct Python interpreter is used from the venv. This is what SMR does. NLP uses `python -m nlp.main` which runs uvicorn internally — this is also fine but less transparent for Docker orchestrators that expect to see the uvicorn process.

#### D7: NLP's `torch` moves to optional `[ml]` extras
**Rationale**: NLP currently lists `torch>=2.1.0` as a production dependency, forcing a ~700MB download for every Docker build. Torch should be optional (like STT-v2's `[ml]` extras) since NLP can run with just CPU-based transformers inference.

---

### Phase 1: Shared pyproject.toml Template (Priority: P0)

Create a reference template that all services conform to. This is not a shared file — each service maintains its own `pyproject.toml` — but the structure, tool configs, and shared dependency versions must be identical.

#### Task 1.1: Define the canonical pyproject.toml structure

Every service's `pyproject.toml` must contain these sections in this order:

```toml
[build-system]                          # setuptools>=75.0, wheel
[project]                               # name, version, description, authors, license, etc.
[project.optional-dependencies]         # dev, test, lint, ml (service-specific)
[project.urls]                          # Homepage, Repository
[project.scripts]                       # CLI entry points
[tool.setuptools.packages.find]         # where = ["src"]
[tool.setuptools.package-data]          # py.typed, *.yaml, etc.
[tool.black]                            # line-length=100, target-version=["py311"]
[tool.mypy]                             # python_version="3.11", strict settings
[tool.pytest.ini_options]               # minversion, addopts, testpaths, asyncio_mode
[tool.coverage.run]                     # source, omit
[tool.coverage.report]                  # exclude_lines
[tool.ruff]                             # line-length=100, target-version="py311"
[tool.ruff.lint]                        # select, ignore
[tool.ruff.lint.per-file-ignores]       # __init__.py, tests/**/*
```

Sections that must **NOT** appear:
- `[dependency-groups]` (use `[project.optional-dependencies]` instead)
- `[tool.uv]` (uv-specific; makes pyproject.toml non-portable)
- `[tool.isort]` (handled by ruff `I` rules)

#### Task 1.2: Align NLP's pyproject.toml

**Files modified**: `apps/nlp/pyproject.toml`

Changes:
1. Add `[build-system]` with `requires = ["setuptools>=75.0", "wheel"]`
2. Add `authors`, `license`, `classifiers`, `keywords`, `[project.urls]`
3. Remove `[dependency-groups]` section (redundant with `[project.optional-dependencies]`)
4. Remove `[tool.uv]` section
5. Move `torch>=2.1.0` from production deps to new `[ml]` optional extra
6. Add missing shared deps: `structlog>=25.5.0`, `python-dotenv>=1.2.0`, `orjson>=3.11.7`, `prometheus-client>=0.24.1`
7. Replace `opentelemetry-exporter-otlp` with `opentelemetry-exporter-otlp-proto-grpc>=1.39.0`
8. Add `[tool.setuptools.packages.find]` and `[tool.setuptools.package-data]`
9. Add full `[tool.black]`, `[tool.mypy]`, `[tool.ruff]`, `[tool.coverage.*]` configs
10. Expand `[project.optional-dependencies]` with proper `dev`, `test`, `lint` groups
11. Regenerate `uv.lock`

#### Task 1.3: Align SMR's pyproject.toml

**Files modified**: `apps/smr/pyproject.toml`

Changes:
1. Bump `opentelemetry-api` and `opentelemetry-sdk` from `>=1.39.0` to `>=1.39.1`
2. Bump `ruff` from `>=0.15.4` to `>=0.15.7`
3. Regenerate `uv.lock`

#### Task 1.4: Align STT-v2's pyproject.toml

**Files modified**: `apps/stt-v2/pyproject.toml`

Changes:
1. Remove `[tool.isort]` section (ruff `I` rules handle this)
2. Remove `isort>=8.0.0` from `[dev]` optional dependencies
3. Bump `ruff` from `>=0.15.4` to `>=0.15.7`
4. Add `.python-version` file with `3.11`
5. Regenerate `uv.lock`

---

### Phase 2: Dev Toolchain Alignment (Priority: P1)

#### Task 2.1: Add missing dev/test/lint deps to NLP

**Files modified**: `apps/nlp/pyproject.toml`

Add to NLP (matching SMR/STT-v2 versions):

```toml
[project.optional-dependencies]
dev = [
    "black>=26.1.0",
    "ruff>=0.15.7",
    "mypy>=1.19.1",
    "pre-commit>=4.5.1",
]
test = [
    "pytest>=9.0.2",
    "pytest-asyncio>=1.3.0",
    "pytest-cov>=7.0.0",
    "pytest-mock>=3.15.1",
    "httpx>=0.28.1",
    "pytest-xdist>=3.8.0",
]
lint = [
    "black>=26.1.0",
    "ruff>=0.15.7",
    "mypy>=1.19.1",
]
```

#### Task 2.2: Standardize root package.json scripts

**Files modified**: `package.json` (root)

Ensure all three services follow the same pattern:

| Script | NLP | SMR | STT-v2 |
|--------|-----|-----|--------|
| `dev:{service}` | `conda run -n arcaenv ... uvicorn` | same | same |
| `py:{service}:test` | `conda run ... pytest apps/{svc}/tests/` | same | **Change from `make -C`** |
| `py:{service}:lint` | `conda run ... ruff check` | same | **Change from `make -C`** |
| `py:{service}:format` | `conda run ... black` | same | **Change from `make -C`** |
| `py:{service}:typecheck` | **Add** `conda run ... mypy` | **Add** | **Add** |

#### Task 2.3: Update setup-python-env.sh

**Files modified**: `scripts/setup-python-env.sh`

Changes:
1. Install NLP with `[dev,test]` extras (currently uses bare `pip install -e`)
2. Add verification for `structlog` import (NLP now depends on it)

---

### Phase 3: Shared Docker Base Image (Priority: P1)

#### Task 3.1: Create `hope-python-base` Dockerfile

**Files created**: `infrastructure/docker/python-base/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1
# ── hope-python-base ────────────────────────────────────────────────────────
# Shared base image for all HOPE Python services (CPU-only).
#
# Provides:
#   - Python 3.11 (slim-trixie)
#   - uv 0.8.13 (fast package installer)
#   - build-essential (for native wheel compilation)
#   - Non-root user: hope:hope (UID/GID 1001)
#   - Standard ENV vars (PYTHONUNBUFFERED, PYTHONDONTWRITEBYTECODE, etc.)
#
# Build:
#   docker build -t hope-python-base infrastructure/docker/python-base/
# ─────────────────────────────────────────────────────────────────────────────

# ── Builder base: Python + uv + build tools ────────────────────────────────
FROM python:3.11-slim-trixie AS builder-base

COPY --from=ghcr.io/astral-sh/uv:0.8.13 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONDONTWRITEBYTECODE=1

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    build-essential

WORKDIR /app

# ── Runtime base: minimal Python runtime ───────────────────────────────────
FROM python:3.11-slim-trixie AS runtime-base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONHASHSEED=random \
    PATH="/app/.venv/bin:$PATH"

RUN groupadd --gid 1001 hope && \
    useradd --uid 1001 --gid hope --shell /usr/sbin/nologin --no-create-home hope

WORKDIR /app
```

#### Task 3.2: Refactor NLP Dockerfile to use shared base

**Files modified**: `apps/nlp/Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1
FROM hope-python-base:latest AS builder-base
FROM hope-python-base:latest AS runtime-base

# ── Builder ────────────────────────────────────────────────────────────────
FROM builder-base AS builder
# (service-specific: uv sync, copy src, cleanup)

# ── Production ─────────────────────────────────────────────────────────────
FROM runtime-base AS production
COPY --from=builder --chown=hope:hope /app/.venv /app/.venv
COPY --chown=hope:hope src/ /app/src/
USER hope
EXPOSE 8864
HEALTHCHECK ...
ENTRYPOINT ["python", "-m", "uvicorn", "--factory", "nlp.app:get_app", ...]
```

#### Task 3.3: Refactor SMR Dockerfile to use shared base

**Files modified**: `apps/smr/Dockerfile`

Same pattern as NLP. Key changes:
- Replace inline `FROM python:3.11-slim-trixie` with `FROM hope-python-base`
- Replace `smr:hope` user with standard `hope:hope`
- Standardize uv sync flag to `--frozen`

#### Task 3.4: Refactor STT-v2 Dockerfile (CPU runtime) to use shared base

**Files modified**: `apps/stt-v2/docker/Dockerfile`

Changes to the `builder` and `runtime` stages only (ML stages keep CUDA base):
- Replace `FROM ghcr.io/astral-sh/uv:python3.11-bookworm-slim` with `FROM hope-python-base` builder-base
- Replace `FROM python:3.11-slim-bookworm AS runtime` with `FROM hope-python-base` runtime-base
- Migrate from bookworm to trixie
- Replace `app:app` (UID 1000) with `hope:hope` (UID 1001)
- Standardize uv sync flag to `--frozen`
- ML stages (`ml-builder`, `ml-runtime`, `worker`) remain unchanged (CUDA base)

#### Task 3.5: Add docker-compose build target for base image

**Files modified**: `infrastructure/docker/docker-compose.dev.yml` (or equivalent)

Add a build step that builds `hope-python-base` before service images.

#### Task 3.6: Standardize .dockerignore

Ensure all three services have identical `.dockerignore` content:

```
__pycache__
*.pyc
*.pyo
.pytest_cache
.mypy_cache
.ruff_cache
.coverage
htmlcov
*.egg-info
.git
.env
.env.*
!.env.example
.venv
venv
node_modules
dist
build
docs
tests
*.md
!README.md
```

---

### Phase 4: Cleanup & Verification (Priority: P2)

#### Task 4.1: Remove stale artifacts from NLP

**Files modified/deleted**:
- Remove `src/nlp.egg-info/` directory (stale editable-install artifact)
- Remove `[tool.uv.extra-build-dependencies]` if no longer needed after build-system alignment

#### Task 4.2: Regenerate all uv.lock files

Run `uv lock` in each service directory after `pyproject.toml` changes:
```bash
cd apps/nlp && uv lock
cd apps/smr && uv lock
cd apps/stt-v2 && uv lock
```

#### Task 4.3: Verify local development setup

Run `./scripts/setup-python-env.sh --install` and confirm all three services install and start.

#### Task 4.4: Verify Docker builds

```bash
# Build base image
docker build -t hope-python-base infrastructure/docker/python-base/

# Build each service
docker build --target production -t hope-nlp apps/nlp/
docker build --target production -t hope-smr apps/smr/
docker build -f apps/stt-v2/docker/Dockerfile --target runtime -t hope-stt-v2 apps/stt-v2/
```

#### Task 4.5: Run all test suites

```bash
pnpm py:nlp:test
pnpm py:smr-v2:test
pnpm py:stt-v2:test
```

#### Task 4.6: Update cursor rule `06-python-services.mdc`

**Files modified**: `.cursor/rules/06-python-services.mdc`

Update to reflect:
- Standardized `pyproject.toml` structure
- New `hope-python-base` Docker image
- Standardized user `hope:hope`
- Dropped `isort` in favor of ruff
- New `py:{service}:typecheck` script
- Updated dev commands table

---

## Implementation Summary

### What Was Built

#### Phase 1: pyproject.toml Standardization
- **NLP** (`apps/nlp/pyproject.toml`): Complete rewrite — added `[build-system]`, authors, license, classifiers, keywords, URLs, `[tool.setuptools]`, full `[tool.black]`/`[tool.mypy]`/`[tool.ruff]`/`[tool.coverage]` configs. Removed `[dependency-groups]` and `[tool.uv]`. Added `structlog`, `python-dotenv`, `orjson`, `prometheus-client`. Replaced `opentelemetry-exporter-otlp` with `opentelemetry-exporter-otlp-proto-grpc`.
- **SMR** (`apps/smr/pyproject.toml`): Bumped `opentelemetry-api`/`sdk` from `>=1.39.0` to `>=1.39.1`. Bumped `ruff` from `>=0.15.4` to `>=0.15.7` in dev and lint extras.
- **STT-v2** (`apps/stt-v2/pyproject.toml`): Removed `[tool.isort]` section. Removed `isort>=8.0.0` from dev deps. Bumped `ruff` from `>=0.15.4` to `>=0.15.7`. Added `.python-version` file.

#### Phase 2: Dev Toolchain Alignment
- **NLP**: Added `dev`, `test`, `lint` optional dependency groups with `black>=26.1.0`, `mypy>=1.19.1`, `pre-commit>=4.5.1`, `pytest-asyncio>=1.3.0`, `pytest-cov>=7.0.0`, `pytest-mock>=3.15.1`, `pytest-xdist>=3.8.0`.
- **Root `package.json`**: Standardized STT-v2 scripts from `make -C` delegation to direct `conda run` commands. Added `py:{service}:typecheck` and `py:{service}:format` scripts for all services.
- **`setup-python-env.sh`**: Updated NLP install from bare `pip install -e` to `pip install -e ".[dev,test]"`. Added `structlog` import verification.

#### Phase 3: Shared Docker Base Image
- **Created** `infrastructure/docker/python-base/Dockerfile` with two stages:
  - `builder-base`: Python 3.11-slim-trixie + uv 0.8.13 + build-essential
  - `runtime-base`: Python 3.11-slim-trixie + `hope:hope` user (UID/GID 1001)
- **NLP Dockerfile**: Refactored to use `hope-python-base`. Standardized user to `hope:hope`. Changed entrypoint to `python -m uvicorn`. Added full cleanup. Changed uv sync to `--frozen`.
- **SMR Dockerfile**: Refactored to use `hope-python-base`. Standardized user to `hope:hope`. Kept `--frozen` flag.
- **STT-v2 Dockerfile**: CPU stages (`builder`, `runtime`) refactored to use `hope-python-base`. Migrated from bookworm to trixie. Standardized user to `hope:hope` (UID 1001). ML stages (`ml-builder`, `ml-runtime`, `worker`) updated user to `hope:hope` but kept CUDA base unchanged. Changed uv sync to `--frozen`.
- **`.dockerignore`**: Standardized across all three services with identical structure (+ `docker/` exclusion for STT-v2).

#### Phase 4: Cleanup
- Removed stale `src/nlp.egg-info/` directory from NLP.
- Regenerated all three `uv.lock` files.
- Updated cursor rule `06-python-services.mdc` to reflect all changes.

### Files Changed

| File | Action | Description |
|------|--------|-------------|
| `apps/nlp/pyproject.toml` | Modified | Full standardization (build-system, metadata, deps, tool configs) |
| `apps/smr/pyproject.toml` | Modified | OTel + ruff version bumps |
| `apps/stt-v2/pyproject.toml` | Modified | Removed isort, bumped ruff |
| `apps/stt-v2/.python-version` | Created | Python 3.11 |
| `apps/nlp/uv.lock` | Regenerated | Updated for new deps |
| `apps/smr/uv.lock` | Regenerated | Updated for version bumps |
| `apps/stt-v2/uv.lock` | Regenerated | Removed isort |
| `package.json` | Modified | Standardized Python scripts |
| `scripts/setup-python-env.sh` | Modified | NLP dev/test extras, structlog check |
| `infrastructure/docker/python-base/Dockerfile` | Created | Shared base image |
| `apps/nlp/Dockerfile` | Modified | Uses hope-python-base |
| `apps/smr/Dockerfile` | Modified | Uses hope-python-base |
| `apps/stt-v2/docker/Dockerfile` | Modified | CPU stages use hope-python-base |
| `apps/nlp/.dockerignore` | Modified | Standardized + added linter caches |
| `apps/smr/.dockerignore` | Modified | Standardized + added linter caches |
| `apps/stt-v2/.dockerignore` | Modified | Standardized + added linter caches |
| `.cursor/rules/06-python-services.mdc` | Modified | Updated to reflect standardization |
| `apps/nlp/src/nlp.egg-info/` | Deleted | Stale artifact |

### Deviations from Plan

1. **torch kept in NLP production deps**: Originally planned to move to `[ml]` extras, but audit showed `torch` is directly imported in 3 NLP service files (`text_classifier.py`, `token_classifier.py`, `medical_suggester.py`). It's a genuine production dependency for NLP inference.
2. **STT-v2 Makefile retained**: Plan considered removing it; decided to keep for backward compatibility since it provides useful targets like `setup-cpu`, `setup-apple`, `setup-gpu` that go beyond what `package.json` scripts offer.
3. **SMR test location unchanged**: Tests remain at `src/smr_v2/tests/` as planned — moving them would be high-risk and out of scope.

---

## Testing Strategy

| Test | Command | Validates |
|------|---------|-----------|
| NLP unit tests | `pnpm py:nlp:test` | No regressions from pyproject.toml changes |
| SMR unit tests | `pnpm py:smr-v2:test` | No regressions from version bumps |
| STT-v2 unit tests | `pnpm py:stt-v2:test` | No regressions from isort removal |
| NLP Docker build | `docker build --target production apps/nlp/` | Dockerfile refactor works |
| SMR Docker build | `docker build --target production apps/smr/` | Dockerfile refactor works |
| STT-v2 Docker build | `docker build -f docker/Dockerfile --target runtime .` | Base image migration works |
| Setup script | `./scripts/setup-python-env.sh --install` | Conda env installs all deps |
| Lint all services | `ruff check apps/{nlp,smr,stt-v2}/src/` | Ruff config standardized |
| Type check | `mypy apps/{nlp,smr,stt-v2}/src/` | Mypy config standardized |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `uv lock` changes transitive deps | Medium | Medium | Run tests after lock regeneration; review lock diff |
| Trixie migration breaks STT-v2 | Low | High | Test STT-v2 Docker build independently; keep bookworm as fallback |
| NLP structlog migration breaks logging | Medium | Medium | This ticket only adds the dependency; logging migration is a separate task |
| Shared base image adds build step | Low | Low | Base image changes infrequently; tag with version for cache stability |
| UID/GID change breaks volume mounts | Low | Medium | Verify existing deployments don't depend on UID 1000 |

---

## Change History

| Date | Description | Files Modified |
|------|-------------|---------------|
| 2026-03-30 | Initial ticket creation with full audit and implementation plan | `docs/implementation/TASK-250-*/README.md` |
| 2026-03-30 | Implementation: Phases 1-4 complete | 18 files (see Implementation Summary) |
