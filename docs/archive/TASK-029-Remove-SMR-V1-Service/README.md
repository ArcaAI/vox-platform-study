# TASK-029: Remove SMR V1 Service

| Field        | Value                          |
|--------------|--------------------------------|
| Ticket       | TASK-029                       |
| Created      | 2026-02-19                     |
| Last Updated | 2026-02-19                     |
| Status       | **Completed**                  |

---

## 1. Requirement Analysis

### Description

Remove the legacy SMR v1 service code (`apps/smr/src/smr/`) from the HOPE monorepo. The SMR service (`apps/smr/src/smr/`) is the production replacement and must **not** be modified in any way.

Both v1 and v2 coexisted inside `apps/smr/` as separate Python packages:
- **v1**: `src/smr/` — Medical conversation summarization (port 5005)
- **v2**: `src/smr/` — General-purpose text generation API (port 5006)

### Business Context

- SMR (TASK-023) fully replaces v1 for all text generation capabilities.
- v1 was a medical-domain-specific summarization monolith with 1,500+ LoC in `summary_service.py`, 14 department-specific prompt files, Celery + PostgreSQL dependencies, and 40+ packages.
- v2 is a clean, general-purpose service with multi-provider support (Ollama, Azure OpenAI, AWS Bedrock), Redis Streams task management, ~18 core dependencies, and 285 passing tests at 98% coverage.
- Keeping the deprecated v1 code creates confusion, inflates the dependency footprint, and adds maintenance burden.

### Acceptance Criteria

- [x] `apps/smr/src/smr/` directory completely removed (63 source files)
- [x] `apps/smr/tests/` directory removed (23 v1 test files)
- [x] `apps/smr/migrations/` directory removed (Alembic + PostgreSQL migrations)
- [x] All v1 runner scripts removed (`run_dev.py`, `run_dev.sh`, `run_tests.py`, `run_celery_worker.py`)
- [x] All v1 documentation removed (`apps/smr/docs/` — 18 files)
- [x] All v1 config artifacts removed (`alembic.ini`, `pytest.ini`, `env.production.example`, etc.)
- [x] `Dockerfile` updated to use v2 entrypoint and port
- [x] `pyproject.toml` updated to remove v1 deps and point at v2
- [x] API gateway controller updated from `/api/v1/*` to `/api/v2/*` routes
- [x] Monorepo `package.json` test scripts updated for v2 test paths
- [x] `.vscode/launch.json` updated for v2
- [x] Cursor rules updated for v2
- [x] `apps/smr/src/smr/` is **untouched** (zero modifications)

### Constraints

- **DO NOT** touch `apps/smr/src/smr/` at all
- **DO NOT** modify v2 test files in `apps/smr/src/smr/tests/`
- **DO NOT** remove environment variables for SMR (port 5006, `SMR_URL`, etc.) — these serve v2

---

## 2. Current State Evaluation

### SMR v1 Service (`apps/smr/src/smr/`)

A FastAPI-based medical conversation summarization service with:

| Aspect | v1 Detail |
|--------|-----------|
| Purpose | Medical-domain summarization with 14 specialty prompt files |
| Architecture | Monolith — `summary_service.py` (1,793 LoC) |
| Task management | Celery + Redis + PostgreSQL (dual source of truth) |
| Database | PostgreSQL via SQLAlchemy + Alembic migrations |
| Providers | Single provider at a time (Azure OpenAI or Ollama) |
| Dependencies | 40+ packages (87 dependency lines in pyproject.toml) |
| Port | 5005 (v1) / 5006 (v2) — both could run simultaneously |
| API prefix | `/api/v1/` |

### SMR Service (`apps/smr/src/smr/`)

| Aspect | v2 Detail |
|--------|-----------|
| Purpose | General-purpose text generation |
| Architecture | Clean separation, provider-agnostic registry |
| Task management | Redis Streams only (no PostgreSQL) |
| Database | None (Redis Streams for task state) |
| Providers | Ollama, Azure OpenAI, AWS Bedrock — all simultaneously |
| Dependencies | ~14 core packages |
| Port | 5006 |
| API prefix | `/api/v2/` |
| Tests | 285 tests, 98% coverage |

### Files Referencing SMR v1

| Category | Files Affected | Action |
|----------|---------------|--------|
| V1 source code | 63 files in `src/smr/` | Delete |
| V1 tests | 23 files in `tests/` | Delete |
| V1 migrations | 4 files in `migrations/` | Delete |
| V1 documentation | 18 files in `docs/` | Delete |
| V1 runner scripts | 4 files (`run_dev.py`, etc.) | Delete |
| V1 config artifacts | 5 files (`alembic.ini`, etc.) | Delete |
| V1 example scripts | 4 files in `examples/` | Delete |
| Dockerfile | 1 file | Update entrypoint, port |
| pyproject.toml | 1 file | Rewrite for v2 |
| API gateway controller | 1 file | Update routes v1 → v2 |
| package.json | 1 file | Update test script paths |
| launch.json | 1 file | Update debug config |
| Cursor rules | 1 file (`.cursor/rules/06-app-smr.mdc`) | Rewrite for v2 |

---

## 3. Implementation Plan

### Phase 1: Delete V1 Source Code

| # | Task | File(s) |
|---|------|---------|
| 1.1 | Delete entire `apps/smr/src/smr/` directory | 63 files: main.py, api/, core/, models/ (14 prompt files), services/ (including 1,793-LoC summary_service.py), infrastructure/, tasks/, db.py, celery_app.py, utils.py |
| 1.2 | Delete `apps/smr/tests/` directory | 23 files: unit tests, integration tests, fixtures, conftest files |
| 1.3 | Delete `apps/smr/migrations/` directory | 4 files: Alembic env, script template, initial schema migration |
| 1.4 | Delete `apps/smr/alembic.ini` | Alembic configuration |

### Phase 2: Delete V1 Scripts and Artifacts

| # | Task | File(s) |
|---|------|---------|
| 2.1 | Delete `run_dev.py` | V1 development server runner |
| 2.2 | Delete `run_dev.sh` | V1 development shell script |
| 2.3 | Delete `run_tests.py` | V1 test runner with custom discovery |
| 2.4 | Delete `run_celery_worker.py` | V1 Celery worker launcher |
| 2.5 | Delete `scripts/run_tests.sh` | V1 test shell script |
| 2.6 | Delete `debug_ollama.py` | V1 Ollama debugging tool |
| 2.7 | Delete `pytest.ini` | V1 pytest configuration (replaced by pyproject.toml) |
| 2.8 | Delete `env.production.example` | V1 production env template |
| 2.9 | Delete `langflow-api.md` | V1 Langflow integration doc |
| 2.10 | Delete `examples/` directory | 4 v1 integration test examples |

### Phase 3: Delete V1 Documentation

| # | Task | File(s) |
|---|------|---------|
| 3.1 | Delete entire `apps/smr/docs/` directory | 18 files: getting-started, api-reference, prompt-engineering, database-schema, observability-guide, environment-configuration, security-headers-guide, deployment-guide, prompts guides, testing docs, prompt templates |

### Phase 4: Update Configuration Files

| # | Task | File(s) | Change |
|---|------|---------|--------|
| 4.1 | Update Dockerfile | `apps/smr/Dockerfile` | Entrypoint: `smr.main` → `uvicorn smr.main:app`, port 5005 → 5006, remove v1 OTel env vars, update labels to v2.0.0 |
| 4.2 | Rewrite pyproject.toml | `apps/smr/pyproject.toml` | Name: `summary-agent` → `smr`, remove 30+ v1 deps (Celery, SQLAlchemy, Alembic, OpenTelemetry, etc.), add `openai` + `boto3` for providers, update all tool paths to `smr` |
| 4.3 | Update package.json | `package.json` | Test scripts: `apps/smr/tests/` → `apps/smr/src/smr/tests/`, coverage source: `apps/smr/src/smr` → `apps/smr/src/smr`, lint/format paths: remove `apps/smr/tests/` |
| 4.4 | Update launch.json | `.vscode/launch.json` | Debug config: `smr.main:app` → `smr.main:app`, port 3000 → 5006, cwd to `apps/smr/src` |

### Phase 5: Update API Gateway

| # | Task | File(s) | Change |
|---|------|---------|--------|
| 5.1 | Update SMR controller routes | `apps/api/src/modules/smr/smr.controller.ts` | Replace all v1 routes (`/api/v1/health`, `/api/v1/summary/sync`, `/api/v1/summary/async`, `/api/v1/jobs/*`, etc.) with v2 routes (`/api/v2/health`, `/api/v2/generate`, `/api/v2/tasks/*`, `/api/v2/providers`) |

### Phase 6: Update Cursor Rules

| # | Task | File(s) | Change |
|---|------|---------|--------|
| 6.1 | Rewrite SMR rule for v2 | `.cursor/rules/06-app-smr.mdc` | Complete rewrite: v1 medical summarization → v2 text generation, updated project structure, technology stack, API endpoints, configuration, and development commands |

---

## 4. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Accidentally modifying smr | Low | High | Verified with `git diff --name-only -- apps/smr/src/smr/` returning empty |
| Breaking CI/CD by removing too much | Low | High | Only v1-specific entries removed; all v2 paths preserved |
| Missing provider SDKs in pyproject.toml | Medium | Medium | Added `openai` and `boto3` to dependencies after test run revealed they're required |
| V2 tests failing after v1 removal | Low | High | Verified: 285/285 tests pass in fresh conda env |

---

## 5. Implementation Summary

### What Was Implemented

The complete removal of SMR v1 legacy code from `apps/smr/`, leaving only the v2 service intact.

### Verification Results

A **brand-new conda environment** (`smr-test`, Python 3.11.14) was created to verify the removal did not break v2:

| Check | Result |
|-------|--------|
| Fresh `pip install -e "apps/smr[dev,test]"` | All dependencies resolved cleanly |
| All `smr` module imports | 16/16 modules import successfully |
| `import smr` (v1) | Correctly raises `ImportError` — v1 is gone |
| `create_app()` | Builds cleanly: "SMR — Text Generation Service v2.0.0", 11 routes |
| **Unit tests** | **285 passed, 0 failed** |
| **Coverage** | **98%** (857 stmts, 13 missed) |
| Duration | 2.69s |
| Temporary env cleanup | `conda env remove -n smr-test` completed |

### Files Deleted (121 files, ~31,500 lines)

| Category | Count | Lines Removed |
|----------|-------|---------------|
| V1 source (`src/smr/`) | 63 | ~13,900 |
| V1 tests (`tests/`) | 23 | ~7,500 |
| V1 documentation (`docs/`) | 18 | ~7,800 |
| V1 migrations (`migrations/`) | 4 | ~193 |
| V1 scripts & artifacts | 13 | ~1,800 |
| **Total deleted** | **121** | **~31,200** |

### Files Modified (7 files)

| File | Change Summary |
|------|---------------|
| `apps/smr/Dockerfile` | Entrypoint → `uvicorn smr.main:app`, port → 5006, labels → v2.0.0 |
| `apps/smr/pyproject.toml` | Rewritten: name `smr`, 14 core deps (from 40+), all paths → `smr` |
| `apps/api/src/modules/smr/smr.controller.ts` | 12 v1 routes → 6 v2 routes (health, generate, tasks, stream, providers) |
| `package.json` | 5 test/lint/format scripts updated for v2 paths |
| `.vscode/launch.json` | Debug config → `smr.main:app` on port 5006 |
| `.cursor/rules/06-app-smr.mdc` | Complete rewrite for v2 architecture |
| `apps/smr/src/smr/main.py` | **NOT modified by this task** (pre-existing diff from TASK-023) |

### Dependency Changes (pyproject.toml)

**Removed (v1-only)**:
- `sqlalchemy[asyncio]`, `alembic`, `asyncpg` (PostgreSQL)
- `celery`, `rq`, `async-timeout` (job queue)
- `aiohttp`, `asyncio-mqtt`, `aiofiles` (async extras)
- `opentelemetry-*` (7 packages — observability)
- `ollama`, `tiktoken`, `nltk` (v1-specific NLP)
- `qdrant-client` (vector DB)
- `websockets`, `python-multipart`, `pyyaml`
- `python-json-logger`, `python-dateutil`, `uuid7`, `psutil`

**Added (required by v2 providers)**:
- `openai>=1.10.0` (Azure OpenAI provider)
- `boto3>=1.34.0` (AWS Bedrock provider)

**Kept (shared)**:
- `fastapi`, `uvicorn[standard]`, `pydantic`, `pydantic-settings`
- `httpx`, `redis`, `structlog`, `python-dotenv`
- `orjson`, `sse-starlette`, `prometheus-client`, `prometheus-fastapi-instrumentator`

### API Gateway Route Changes

| V1 Route (removed) | V2 Route (added) | Method |
|---------------------|-------------------|--------|
| `api/v1/health` | `api/v2/health` | GET |
| `api/v1/summary/sync` | `api/v2/generate` | POST |
| `api/v1/summary/async` | *(handled by `stream: true` in generate)* | — |
| `api/v1/summary/feedback` | *(removed — v2 has no feedback)* | — |
| `api/v1/presummary` | *(removed — v1-specific)* | — |
| `api/v1/jobs/:jobId` (GET) | `api/v2/tasks/:taskId` | GET |
| `api/v1/jobs/:jobId` (DELETE) | `api/v2/tasks/:taskId/cancel` | POST |
| `api/v1/jobs` | *(removed — v2 tasks are ephemeral)* | — |
| `api/v1/models/info` | `api/v2/providers` | GET |
| `api/v1/sse/health` | *(removed — folded into health)* | — |
| `api/v1/sse/jobs/:jobId` | `api/v2/tasks/:taskId/stream` | GET |

---

## 6. Change History

| # | Date | Description |
|---|------|-------------|
| 1 | 2026-02-19 | Initial implementation — complete removal of SMR v1, verification with fresh conda env (285/285 tests pass, 98% coverage) |
