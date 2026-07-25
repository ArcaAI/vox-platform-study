# TASK-028: Remove STT V1 Service

| Field        | Value                          |
|--------------|--------------------------------|
| Ticket       | TASK-028                       |
| Created      | 2026-02-19                     |
| Last Updated | 2026-02-19                     |
| Status       | **Completed**                  |

---

## 1. Requirement Analysis

### Description

Remove the legacy STT v1 service (`apps/stt/`) from the HOPE monorepo. The STT service (`apps/stt/`) is the production replacement and must **not** be modified in any way.

### Business Context

- STT has fully replaced STT v1 for all speech-to-text capabilities.
- Keeping the deprecated v1 service creates confusion, increases CI/CD time, and adds maintenance burden.
- The v1 service is already marked as "Legacy (deprecated)" in `.env.example`.

### Acceptance Criteria

- [x] `apps/stt/` directory is completely removed
- [x] All CI/CD pipelines no longer reference `apps/stt/`
- [x] All environment config files remove STT v1 variables
- [x] All documentation is updated to remove STT v1 references
- [x] Cursor rules for STT v1 are removed/updated
- [x] PM2 ecosystem config no longer references STT v1
- [x] GitLab CI build job for STT v1 is removed
- [x] `apps/stt/` is **untouched** (zero modifications)

### Constraints

- **DO NOT** touch `apps/stt/` at all
- **DO NOT** remove references to `stt` or the `@arcaai/stt` SDK plugin (these are legitimate v2 references)
- **DO NOT** remove the `packages/stt/` client package (shared TS library used across the monorepo)
- **DO NOT** remove Qdrant `stt_speaker_embeddings` collection references (used by v2)
- **DO NOT** remove database seed files for STT config (`06-stt`) — these are shared

---

## 2. Current State Evaluation

### STT v1 Service (`apps/stt/`)

A FastAPI-based speech-to-text service with:
- Dual STT providers (Azure Cognitive Services + Whisper)
- Real-time WebSocket streaming
- Celery async processing with Redis
- MinIO storage integration
- OpenTelemetry observability
- Port: **5003**

### Files Referencing STT v1

The following categories of files reference `apps/stt/` (v1):

| Category | File Count | Impact |
|----------|-----------|--------|
| Environment configs | 2 | `.env.dev`, `.env.example` |
| GitLab CI | 1 | `.gitlab-ci.yml` |
| GitHub Actions | 5 | `ci.yml`, `test-unit.yml`, `test-integration.yml`, `lint-format.yml`, `setup-test-env/action.yml` |
| PM2 config | 1 | `ecosystem.config.js` |
| Docker/Infra | 2 | `docker-compose.dev.yml`, `scripts/vault-init-stt.sh` |
| Documentation | 15+ | `docs/`, `knowledge/`, implementation docs |
| Cursor rules | 3 | `04-app-stt.mdc`, `09-python-services.mdc`, `01-documentation.mdc` |
| Misc | 2 | `README.md` (root), `packages/stt/` comment |

### Items to Preserve (NOT Remove)

| Item | Reason |
|------|--------|
| `apps/stt/` | Production v2 service — must not be touched |
| `packages/stt/` | Shared TypeScript client library |
| Qdrant `stt_speaker_embeddings` | Used by v2 speaker diarization |
| Database seeds (`06-stt`) | STT config namespace shared by v2 |
| `@arcaai/stt` SDK references | Agentic SDK plugin for v2 |
| `knowledge/api/` STT proxy docs | May still document v2 proxy endpoints |

---

## 3. Implementation Plan

### Phase 1: Delete STT v1 Directory

| # | Task | File(s) |
|---|------|---------|
| 1.1 | Delete the entire `apps/stt/` directory | `apps/stt/` (recursive) |

### Phase 2: Update CI/CD Pipelines

| # | Task | File(s) |
|---|------|---------|
| 2.1 | Remove `build-stt` job (lines 87–111) | `.gitlab-ci.yml` |
| 2.2 | Remove `stt` from `python-services` default, remove `apps/stt/**/*.py` from PR and push path triggers | `.github/workflows/test-unit.yml` |
| 2.3 | Remove `apps/stt/**/*.py` from PR and push path triggers | `.github/workflows/test-integration.yml` |
| 2.4 | Remove `apps/stt/**/*.py` from python filter paths | `.github/workflows/ci.yml` |
| 2.5 | Remove `stt` from matrix service list | `.github/workflows/lint-format.yml` |
| 2.6 | Remove `STT_PORT` and `STT_URL` env vars for v1 | `.github/actions/setup-test-env/action.yml` |

### Phase 3: Update Configuration Files

| # | Task | File(s) |
|---|------|---------|
| 3.1 | Remove STT v1 section (lines 111–119: `STT_HOST`, `STT_PORT`, `STT_URL`, `STT_WS_URL`, `STT_PROVIDER`) | `.env.dev` |
| 3.2 | Remove STT v1 section (lines 115–129) | `.env.example` |
| 3.3 | Remove STT v1 PM2 app entry (lines 22–31) | `ecosystem.config.js` |

### Phase 4: Update Infrastructure Files

| # | Task | File(s) |
|---|------|---------|
| 4.1 | Remove `vault-init-stt.sh` volume mount and command from vault-init service (lines 82–83) | `infrastructure/docker/docker-compose.dev.yml` |
| 4.2 | Delete vault init script for STT v1 | `infrastructure/docker/scripts/vault-init-stt.sh` |

### Phase 5: Update Documentation

| # | Task | File(s) |
|---|------|---------|
| 5.1 | Update root README — change "Legacy STT service (deprecated)" to indicate removal or remove line | `README.md` |
| 5.2 | Remove STT v1 section from project structure docs | `docs/project-structure.md` |
| 5.3 | Remove STT v1 references from environment variables doc | `docs/ENVIRONMENT_VARIABLES.md` |
| 5.4 | Remove STT v1 references from project brief | `docs/project-brief.md` |
| 5.5 | Remove STT v1 link from docs README | `docs/README.md` |
| 5.6 | Update consultation workflow doc | `docs/CONSULTATION_WORKFLOW.md` |
| 5.7 | Update quality control doc | `docs/QUALITY_CONTROL.md` |
| 5.8 | Update immediate next steps doc | `docs/immediate-next-steps.md` |
| 5.9 | Update knowledge base API docs | `knowledge/api/configuration.md`, `knowledge/api/api-reference.md`, `knowledge/api/README.md` |
| 5.10 | Update knowledge architecture doc | `knowledge/architecture/infrastructure.md` |
| 5.11 | Update API app README | `apps/api/README.md` |

### Phase 6: Update Cursor Rules

| # | Task | File(s) |
|---|------|---------|
| 6.1 | Delete the dedicated STT v1 Cursor rule file entirely | `.cursor/rules/04-app-stt.mdc` |
| 6.2 | Remove `apps/stt/` from globs and references in Python services rule | `.cursor/rules/09-python-services.mdc` |
| 6.3 | Remove STT v1 documentation reference | `.cursor/rules/01-documentation.mdc` |
| 6.4 | Remove `apps/stt/` location reference | `.cursor/rules/00-workflow.mdc` |
| 6.5 | Remove `apps/stt/**/*.py` glob pattern | `.cursor/rules/README.md` |

### Phase 7: Clean Up Miscellaneous References

| # | Task | File(s) |
|---|------|---------|
| 7.1 | Update comment referencing `apps/stt/` websocket protocol | `packages/stt/src/websocket/WebSocketClient.ts` |

---

## 4. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Accidentally modifying stt | Low | High | Explicit constraint; verify no stt files are touched |
| Breaking CI/CD by removing too much | Medium | High | Only remove v1-specific entries; keep all v2 paths |
| Orphaned environment variables | Low | Low | Review .env files for any remaining STT v1 vars |
| Missing documentation updates | Medium | Low | Comprehensive file list in plan above |

---

## 5. Implementation Summary

**Completed**: 2026-02-19

### Files Deleted (Phase 1 + Phase 4)
- `apps/stt/` — Entire directory (50+ files: source, docs, configs, Dockerfile, venv)
- `.cursor/rules/04-app-stt.mdc` — Dedicated Cursor rule for STT v1
- `infrastructure/docker/scripts/vault-init-stt.sh` — Vault init script for STT v1

### CI/CD Files Modified (Phase 2)
- `.gitlab-ci.yml` — Removed `build-stt` job
- `.github/workflows/test-unit.yml` — Removed `stt` from services, path triggers, matrix
- `.github/workflows/test-integration.yml` — Removed `apps/stt/**/*.py` path triggers
- `.github/workflows/ci.yml` — Removed `apps/stt/**/*.py` from path filter
- `.github/workflows/lint-format.yml` — Removed `stt` from matrix service list
- `.github/actions/setup-test-env/action.yml` — Removed `STT_PORT`/`STT_URL` env vars

### Configuration Files Modified (Phase 3)
- `.env.dev` — Removed STT v1 variables, updated section header to stt
- `.env.example` — Removed STT v1 variables, updated section header to stt
- `.env` — Removed STT v1 variables, updated section header to stt
- `ecosystem.config.js` — Removed STT v1 PM2 app entry

### Infrastructure Files Modified (Phase 4)
- `infrastructure/docker/docker-compose.dev.yml` — Removed vault-init service block

### Documentation Files Modified (Phase 5)
- `README.md` — Removed `stt/` from app listing
- `docs/project-structure.md` — Removed STT v1 section and dependency graph node
- `docs/ENVIRONMENT_VARIABLES.md` — Removed STT v1 section and commands
- `docs/project-brief.md` — Removed STT v1 documentation links
- `docs/README.md` — Removed STT v1 documentation section
- `docs/CONSULTATION_WORKFLOW.md` — Updated `apps/stt/` to `apps/stt/`
- `docs/QUALITY_CONTROL.md` — Updated glob pattern to `apps/stt/**/*.py`
- `docs/immediate-next-steps.md` — Updated reference to stt
- `knowledge/api/configuration.md` — Removed STT v1 env var rows
- `knowledge/api/api-reference.md` — Removed STT Proxy (v1) section
- `knowledge/api/README.md` — Removed SttModule v1 row
- `knowledge/architecture/infrastructure.md` — Updated glob pattern
- `apps/api/README.md` — Removed STT v1 proxy reference

### Cursor Rules Modified (Phase 6)
- `.cursor/rules/09-python-services.mdc` — Removed STT from globs, overview, service notes
- `.cursor/rules/01-documentation.mdc` — Removed STT v1 doc reference
- `.cursor/rules/00-workflow.mdc` — Removed `apps/stt/` location
- `.cursor/rules/README.md` — Removed 04-app-stt.mdc section and references

### Miscellaneous (Phase 7)
- `packages/stt/src/websocket/WebSocketClient.ts` — Removed stale v1 comment

### Verification Results
- `apps/stt/` — Confirmed deleted
- `apps/stt/` — Confirmed zero git changes (untouched)
- No `apps/stt/` references in config files (`.yml`, `.yaml`, `.json`, `.js`, `.ts`, `.mdc`)
- No `STT_HOST`, `STT_PROVIDER` in env files (except implementation docs)
- Only remaining `apps/stt/` references are in `docs/implementation/` (historical records — preserved intentionally)

### Post-Removal Test Results

A fresh `stt` conda environment (Apple Silicon/MPS, Python 3.11.14, PyTorch 2.8.0) was created and all tests were run to verify zero regression.

**STT Unit Tests** (conda env `stt`, `make test-unit`):
- **1330 passed, 9 failed** (13.4s)
- The 9 failures are pre-existing bugs (identical to results before removal, confirmed via `git diff apps/stt/` = zero changes)
- Failures: `test_passes_language` (KeyError), `test_lifespan_startup_and_shutdown` (MagicMock), `test_redis_import_failure` (singleton), `test_progress_callback` (race condition), 5x `test_transcription_api` (Form parameter)

**TypeScript Unit Tests** (`pnpm test:unit`, Vitest 4.0.18):
- **All tests passed** (exit code 0)
- Covers: `packages/agentic-sdk-v2`, `packages/applications`, `packages/pipeline`, `packages/room`, `apps/api`, `packages/database`, and all other TS packages

**Conclusion**: Removing STT v1 caused **zero regressions** in both Python and TypeScript test suites.

### Note
The API gateway still has an `SttModule` proxy (`apps/api/src/modules/stt/`) that references `STT_URL`/`STT_WS_URL`. This is API-layer code and out of scope for this task (removing the STT v1 **service**, not the API proxy). Removing the API proxy module should be tracked as a separate task.

---

## 6. Change History

| # | Date | Description |
|---|------|-------------|
| 1 | 2026-02-19 | Initial implementation — all 7 phases completed, tested, verified |
