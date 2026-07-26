# TASK-217: Dev & Test Infrastructure Consolidation and Refactor

- **Ticket**: TASK-217
- **Created**: 2026-02-23
- **Last Updated**: 2026-02-23
- **Status**: Completed

---

## 1. Requirement Analysis

### Business Context

The HOPE monorepo completed a migration from Kafka to Redis for all job queues and event streaming (SDK-205). However, the test infrastructure, CI/CD pipelines, shell scripts, and documentation were never cleaned up to reflect this change. Additionally, the test infrastructure lacks a convenience shell script (like `start-infra.sh` for dev), and there are significant configuration drifts between dev and test environments that can mask bugs.

### Goals

1. **Remove all stale Kafka artifacts** from test infra, CI workflows, scripts, and env files
2. **Align test infrastructure** with dev infrastructure (bucket names, Redis auth, Qdrant init, image versions)
3. **Create `start-test-infra.sh`** shell script mirroring `start-infra.sh` for test infrastructure management
4. **Update CI/CD pipelines** (GitHub Actions + GitLab CI) to remove Kafka and align service versions
5. **Update pnpm scripts** to use the new test infra shell script and remove Kafka workarounds
6. **Update documentation** and env files to remove all Kafka references

### Acceptance Criteria

- [ ] No Kafka containers, env vars, or references in any infrastructure or CI file
- [ ] `pnpm docker:test:up` and `pnpm docker:test:down` use the new `start-test-infra.sh` script
- [ ] `start-test-infra.sh` supports `--up`, `--stop`, `--logs`, `--status`, `--validate` flags
- [ ] MinIO bucket names match between dev and test
- [ ] Redis auth configuration matches between dev and test
- [ ] Qdrant init container exists in test infra
- [ ] Docker image versions are pinned and consistent across dev, test, and CI
- [ ] GitHub Actions workflows use matching service versions (no Kafka)
- [ ] All tests pass with the updated infrastructure
- [ ] `.env.test` and `setup-test-env` action have no Kafka references

---

## 2. Current State Evaluation

### 2.1 Dev Infrastructure (Working Correctly)

**Files:**
- `infrastructure/docker/docker-compose.yml` -- Core services (PostgreSQL 18, Redis 8, MinIO)
- `infrastructure/docker/docker-compose.dev.yml` -- Extended services (Vault, Qdrant + init)
- `scripts/start-infra.sh` -- Convenience script with `--all`, `--stop`, `--logs`, `--status`

**Services (Dev):**

| Service | Image | Port | Auth | Persistence | Init |
|---------|-------|------|------|-------------|------|
| PostgreSQL | `postgres:18-alpine` | 5432 | `postgres/postgres` | Named volume | -- |
| Redis | `redis:8-alpine` | 6379 | Password (`REDIS_PASSWORD`) | None | -- |
| MinIO | `minio/minio:RELEASE.2025-04-22T22-12-26Z` | 9000/9001 | `minio_admin/minio_admin` | -- | 5 buckets: `mlflow`, `recordings`, `generated-audio`, `documents`, `backups` |
| Vault | `hashicorp/vault:1.15` | 8200 | Root token | Named volume | -- |
| Qdrant | `qdrant/qdrant:v1.16` | 6333/6334 | None | Named volume | `init-qdrant-collections.py` creates 2 collections |

### 2.2 Test Infrastructure (Needs Refactoring)

**Files:**
- `tests/docker-compose.test.yml` -- All test services in one file
- No convenience shell script (uses raw `docker compose` commands)

**Services (Test):**

| Service | Image | Port | Auth | Persistence | Init | Issue |
|---------|-------|------|------|-------------|------|-------|
| PostgreSQL | `postgres:18-alpine` | 5433 | `test/test` | tmpfs | -- | OK |
| Redis | `redis:8-alpine` | 6380 | **None** | tmpfs | -- | **Missing auth** |
| **Kafka** | `apache/kafka:4.0.0` | 9093 | -- | -- | -- | **STALE - must remove** |
| MinIO | `minio/minio:latest` | 9002/9003 | `test/testpassword` | tmpfs | 2 buckets: `hope-private`, `hope-public` | **Unpinned image, wrong buckets** |
| Qdrant | `qdrant/qdrant:v1.16` | 6335/6336 | None | tmpfs | **None** | **Missing init container** |
| Vault | -- | -- | -- | -- | -- | **Missing entirely** |

### 2.3 CI/CD Infrastructure

**GitHub Actions (3 workflows affected):**

| Workflow | Kafka Present | Redis Version | MinIO Version | Issues |
|----------|---------------|---------------|---------------|--------|
| `test-integration.yml` | Yes (2 jobs) | `redis:8-alpine` | `minio/minio:latest` | Kafka stale, Redis version mismatch (7 vs 8) |
| `test-e2e.yml` | Yes (1 job) | `redis:8-alpine` | -- | Kafka stale, Redis version mismatch, PG version mismatch (16 vs 18) |
| `setup-test-env/action.yml` | Yes (7 env vars) | -- | -- | Kafka inputs/outputs/env vars |

**GitLab CI:**
- `.gitlab-ci.yml` -- Build-only pipeline, no test stage. No Kafka references. No changes needed for this task.

### 2.4 Scripts & Env Files

| File | Kafka References | Issue |
|------|------------------|-------|
| `scripts/start-infra.sh` | Lines 70, 86-87 (help text) | Mentions Kafka in `--all` description |
| `package.json` | Lines 67-69, 74 (`KAFKA_ENABLED=false`) | 4 test scripts set dead env var |
| `.env.test` | Line 9 (comment) | Comment mentions Kafka port 9093 |
| `.github/actions/setup-test-env/action.yml` | Lines 39-45, 66-68, 107-116 | Full Kafka config section |

### 2.5 Gap Summary

| Aspect | Dev | Test | CI (GitHub Actions) | Aligned? |
|--------|-----|------|---------------------|----------|
| Kafka | Removed | **Present** | **Present** | NO |
| Redis version | 8-alpine | 8-alpine | **7-alpine** | NO |
| Redis auth | Password | **No password** | **No password** | NO |
| PostgreSQL version | 18-alpine | 18-alpine | 18-alpine (integration), **16-alpine (e2e)** | PARTIAL |
| MinIO image | Pinned release | **`latest`** | **`latest`** | NO |
| MinIO buckets | 5 domain buckets | **2 generic buckets** | -- | NO |
| Qdrant | v1.16 + init | v1.16, **no init** | -- | NO |
| Vault | v1.15 | **Missing** | -- | NO |
| Shell script | `start-infra.sh` | **None** | -- | NO |

---

## 3. Implementation Plan

### Phase 1: Remove Kafka Artifacts (Clean Sweep)

**Priority: Critical | Estimated effort: Small**

#### Task 1.1: Remove Kafka from `tests/docker-compose.test.yml`

- Delete the `kafka-test` service block (lines 93-132)
- Remove Kafka from the header comment (line 10)
- Update the port mapping table in the header

#### Task 1.2: Remove Kafka from GitHub Actions Workflows

**`test-integration.yml`:**
- Remove `kafka` service container from `integration-tests-typescript` job (lines 164-189)
- Remove `kafka` service container from `integration-tests-python` job (lines 287-312)
- Remove `kafka-port` and `kafka-enabled` from `setup-test-env` usage (lines 200-201, 366-367)
- Update header comments (lines 5-6, 9-10)

**`test-e2e.yml`:**
- Remove `kafka` service container from `e2e-tests` job (lines 140-165)
- Remove `kafka-port` and `kafka-enabled` from `setup-test-env` usage (lines 175-177)
- Update header comments (lines 5-6, 9-10)

#### Task 1.3: Remove Kafka from `setup-test-env` Composite Action

- Remove `kafka-port` input (lines 39-41)
- Remove `kafka-enabled` input (lines 42-45)
- Remove `kafka-brokers` output (lines 66-68)
- Remove entire Kafka Configuration section (lines 107-116)
- Update header comments (lines 13-14, 22-23)

#### Task 1.4: Remove Kafka from `package.json` Scripts

- Remove `KAFKA_ENABLED=false` prefix from 4 scripts:
  - `test:unit`
  - `test:unit:watch`
  - `test:unit:ui`
  - `test:coverage`

#### Task 1.5: Remove Kafka from `scripts/start-infra.sh`

- Update help text on line 70: remove "Kafka" from `--all` description
- Update hint text on lines 86-87: remove "Kafka" from extended services message

#### Task 1.6: Remove Kafka from `.env.test`

- Remove Kafka port reference from header comment (line 9)

---

### Phase 2: Align Test Infrastructure with Dev

**Priority: High | Estimated effort: Medium**

#### Task 2.1: Fix Redis Auth in Test Infrastructure

**`tests/docker-compose.test.yml` -- Update `redis-test` service:**
- Add `REDIS_PASSWORD` environment variable (use `test_redis_pass`)
- Add `--requirepass` to the Redis command
- Update healthcheck to include password

**`.env.test` -- Update Redis section:**
- Set `REDIS_PASS=test_redis_pass`
- Update `REDIS_URL=redis://:test_redis_pass@localhost:6380`

**`.github/actions/setup-test-env/action.yml`:**
- Update `REDIS_PASS` to `test_redis_pass`
- Update `REDIS_URL` to include password

#### Task 2.2: Align MinIO Bucket Names

**`tests/docker-compose.test.yml` -- Update `minio-createbuckets` service:**
- Replace `hope-private` and `hope-public` with the same 5 buckets as dev:
  - `mlflow`, `recordings`, `generated-audio`, `documents`, `backups`
- Add public policy for `recordings` and `generated-audio` (matching dev)

#### Task 2.3: Pin MinIO Image Version

**`tests/docker-compose.test.yml`:**
- Change `minio/minio:latest` to `minio/minio:RELEASE.2025-04-22T22-12-26Z` (matching dev)
- Change `minio/mc:latest` to a pinned version (e.g., `minio/mc:RELEASE.2025-04-22T22-12-26Z` or latest stable)

**`.github/workflows/test-integration.yml`:**
- Pin MinIO service container image to same version

#### Task 2.4: Add Qdrant Init Container to Test Infrastructure

**`tests/docker-compose.test.yml` -- Add new service:**
- Add `qdrant-init-test` service (mirrors `qdrant-init` from `docker-compose.dev.yml`)
- Mount the same `init-qdrant-collections.py` script
- Set `QDRANT_HOST=qdrant-test` and `QDRANT_PORT=6333`
- Add `depends_on: qdrant-test`

#### Task 2.5: Fix PostgreSQL Version in E2E Workflow

**`.github/workflows/test-e2e.yml`:**
- Change `postgres:16-alpine` to `postgres:18-alpine` (matching dev and integration workflow)
- Add `POSTGRES_INITDB_ARGS` to match integration workflow
- Improve healthcheck options to match integration workflow

#### Task 2.6: Fix Redis Version in GitHub Actions

**`.github/workflows/test-integration.yml`:**
- Change `redis:8-alpine` to `redis:8-alpine` in both jobs

**`.github/workflows/test-e2e.yml`:**
- Change `redis:8-alpine` to `redis:8-alpine`

---

### Phase 3: Create Test Infrastructure Shell Script

**Priority: High | Estimated effort: Medium**

#### Task 3.1: Create `scripts/start-test-infra.sh`

Create a new shell script mirroring `start-infra.sh` with the following features:

```
Usage: ./scripts/start-test-infra.sh [OPTIONS]

Options:
  (none)       Start test infrastructure services
  --stop       Stop all test services and remove volumes
  --logs       Follow logs from all test services
  --status     Show status of test services
  --validate   Verify all services are healthy and initialized
  --help       Show this help message

Environment:
  Uses .env.test file from project root
```

**Key design decisions:**
- Uses `tests/docker-compose.test.yml` (single file, unlike dev which has core + extended)
- Loads `.env.test` instead of `.env`
- `--stop` includes `-v` flag (always remove volumes since test data is ephemeral)
- `--validate` is a new feature that checks:
  - All containers are running and healthy
  - PostgreSQL accepts connections
  - Redis responds to PING (with auth)
  - MinIO buckets exist
  - Qdrant collections exist
- Colored output matching `start-test-service.sh` style

#### Task 3.2: Update `package.json` Docker Test Scripts

Replace raw `docker compose` commands with the new script:

```json
"docker:test:up": "./scripts/start-test-infra.sh",
"docker:test:down": "./scripts/start-test-infra.sh --stop",
"docker:test:logs": "./scripts/start-test-infra.sh --logs",
"docker:test:status": "./scripts/start-test-infra.sh --status",
"docker:test:validate": "./scripts/start-test-infra.sh --validate"
```

#### Task 3.3: Update `test:setup` Script

Update to include validation:

```json
"test:setup": "pnpm docker:test:up && pnpm docker:test:validate && pnpm test:db:push && pnpm test:db:seed"
```

---

### Phase 4: Update Documentation & Environment Files

**Priority: Medium | Estimated effort: Small**

#### Task 4.1: Update `.env.test` Comments

- Remove all Kafka port references from comments
- Add Qdrant port to the port mapping comment
- Ensure all port mappings are accurate

#### Task 4.2: Update `scripts/start-infra.sh` Help Text

- Remove "Kafka" from all help/hint messages
- Update to say "Vault, Qdrant" only

#### Task 4.3: Update `.github/actions/setup-test-env/action.yml` Comments

- Remove Kafka from the port mapping table in the header
- Remove Kafka from the usage example
- Add Qdrant port to the mapping table

#### Task 4.4: Update `docker-compose.dev.yml` Project Name

- Change `name: hope-stt-dev` to `name: hope-infra-dev` (it's no longer STT-specific)

---

## 4. Files to Modify (Complete List)

### Phase 1 (Kafka Removal)

| # | File | Action |
|---|------|--------|
| 1 | `tests/docker-compose.test.yml` | Remove `kafka-test` service, update comments |
| 2 | `.github/workflows/test-integration.yml` | Remove Kafka service containers (2 jobs), update comments |
| 3 | `.github/workflows/test-e2e.yml` | Remove Kafka service container, update comments |
| 4 | `.github/actions/setup-test-env/action.yml` | Remove Kafka inputs, outputs, env vars, update comments |
| 5 | `package.json` | Remove `KAFKA_ENABLED=false` from 4 scripts |
| 6 | `scripts/start-infra.sh` | Remove Kafka from help text |
| 7 | `.env.test` | Remove Kafka from comments |

### Phase 2 (Alignment)

| # | File | Action |
|---|------|--------|
| 8 | `tests/docker-compose.test.yml` | Fix Redis auth, fix MinIO buckets, pin MinIO image, add Qdrant init |
| 9 | `.env.test` | Update `REDIS_PASS` and `REDIS_URL` |
| 10 | `.github/actions/setup-test-env/action.yml` | Update Redis auth config |
| 11 | `.github/workflows/test-integration.yml` | Fix Redis version (8), pin MinIO, update Redis auth |
| 12 | `.github/workflows/test-e2e.yml` | Fix PostgreSQL version (18), fix Redis version (8) |

### Phase 3 (New Script)

| # | File | Action |
|---|------|--------|
| 13 | `scripts/start-test-infra.sh` | **CREATE** -- New test infra management script |
| 14 | `package.json` | Update `docker:test:*` scripts to use new script, add `docker:test:validate` |

### Phase 4 (Documentation)

| # | File | Action |
|---|------|--------|
| 15 | `.env.test` | Update all comments (ports, services) |
| 16 | `scripts/start-infra.sh` | Update help text |
| 17 | `.github/actions/setup-test-env/action.yml` | Update header comments |
| 18 | `infrastructure/docker/docker-compose.dev.yml` | Rename project `hope-stt-dev` -> `hope-infra-dev` |

---

## 5. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Removing Kafka breaks a hidden dependency | High | Search entire codebase for `kafka` imports; the `KAFKA_ENABLED=false` pattern confirms app code already handles absence |
| Redis auth change breaks tests | Medium | Update `.env.test` and `setup-test-env` action simultaneously; test locally before pushing |
| MinIO bucket rename breaks integration tests | Medium | Search for `hope-private`/`hope-public` references in test code; update any hardcoded bucket names |
| Qdrant init script path differs in test context | Low | Mount same script from `infrastructure/docker/scripts/`; use relative path from compose file |
| GitHub Actions service containers don't support all compose features | Low | Keep service container config simple; complex init (Qdrant, MinIO buckets) handled in workflow steps |

---

## 6. Testing Strategy

### Local Validation

1. Run `pnpm docker:test:up` -- verify all containers start without Kafka
2. Run `./scripts/start-test-infra.sh --validate` -- verify all services healthy
3. Run `pnpm test:unit` -- verify unit tests pass without `KAFKA_ENABLED=false`
4. Run `pnpm test:integration` -- verify integration tests pass with aligned infra
5. Run `pnpm test:e2e` -- verify E2E tests pass

### CI Validation

1. Push to a feature branch and verify GitHub Actions workflows succeed
2. Verify no Kafka containers appear in CI logs
3. Verify Redis 8, PostgreSQL 18, and pinned MinIO versions in CI logs

---

## 7. Execution Order

```
Phase 1 (Kafka Removal)     ──── Can be done as a single commit
  1.1 docker-compose.test.yml
  1.2 GitHub Actions workflows
  1.3 setup-test-env action
  1.4 package.json
  1.5 start-infra.sh
  1.6 .env.test

Phase 2 (Alignment)         ──── Can be done as a single commit
  2.1 Redis auth
  2.2 MinIO buckets
  2.3 MinIO image pinning
  2.4 Qdrant init
  2.5 PostgreSQL version (e2e)
  2.6 Redis version (CI)

Phase 3 (New Script)        ──── Can be done as a single commit
  3.1 Create start-test-infra.sh
  3.2 Update package.json
  3.3 Update test:setup

Phase 4 (Documentation)     ──── Can be done as a single commit
  4.1-4.4 Comment/doc updates
```

Each phase can be committed independently and should be tested before proceeding to the next.

---

## 8. Implementation Summary

### Files Modified (12 files)

| # | File | Changes |
|---|------|---------|
| 1 | `tests/docker-compose.test.yml` | Removed Kafka service; added Redis auth; pinned MinIO image; aligned bucket names with dev (5 domain buckets); added Qdrant healthcheck and init container; fixed MinIO healthcheck |
| 2 | `.github/workflows/test-integration.yml` | Removed Kafka service containers from both TS and Python jobs; upgraded Redis 7 -> 8; pinned MinIO image; removed Kafka from setup-test-env usage; updated header comments |
| 3 | `.github/workflows/test-e2e.yml` | Removed Kafka service container; upgraded Redis 7 -> 8; upgraded PostgreSQL 16 -> 18 with aligned config; removed Kafka from setup-test-env usage; updated header comments |
| 4 | `.github/actions/setup-test-env/action.yml` | Removed Kafka inputs, outputs, and env vars; added Redis password auth; updated port mapping comments |
| 5 | `package.json` | Removed `KAFKA_ENABLED=false` from 4 test scripts; updated `docker:test:*` scripts to use `start-test-infra.sh`; added `docker:test:validate`; updated `test:setup` to include validation |
| 6 | `scripts/start-infra.sh` | Removed Kafka from help text and hint messages |
| 7 | `.env.test` | Removed Kafka from port mapping comments; added Redis password and updated Redis URL; updated CI usage comments; added Qdrant to port mapping |
| 8 | `infrastructure/docker/docker-compose.dev.yml` | Renamed project from `hope-stt-dev` to `hope-infra-dev` |

### Files Created (1 file)

| # | File | Purpose |
|---|------|---------|
| 9 | `scripts/start-test-infra.sh` | New convenience script for managing test infrastructure with `--stop`, `--logs`, `--status`, `--validate` flags |

### Key Changes Summary

1. **Kafka fully removed** from all test infra, CI workflows, env files, and scripts
2. **Redis auth aligned** -- test Redis now uses `--requirepass test_redis_pass` matching dev pattern
3. **MinIO aligned** -- pinned image version, same 5 domain buckets as dev with matching policies
4. **Qdrant aligned** -- added healthcheck and init container reusing the same `init-qdrant-collections.py` script
5. **PostgreSQL aligned** -- E2E workflow upgraded from 16 to 18 with proper healthcheck config
6. **Redis version aligned** -- CI workflows upgraded from 7-alpine to 8-alpine
7. **New `start-test-infra.sh`** -- mirrors `start-infra.sh` with `--validate` for health verification
8. **pnpm scripts updated** -- all `docker:test:*` now use the shell script; added `docker:test:validate`

---

## 9. Change History

*To be updated when subsequent changes are made.*
