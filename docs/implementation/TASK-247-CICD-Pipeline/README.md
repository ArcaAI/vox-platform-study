# TASK-247: CI/CD Pipeline Rebuild

| Field | Value |
|-------|-------|
| Ticket | TASK-247 |
| Created | 2026-03-23 |
| Updated | 2026-03-23 |
| Status | **Completed** |

---

## Requirement Analysis

### Description

Rebuild the GitLab CI/CD pipeline from a build-only configuration (2 stages) into a full-lifecycle pipeline with linting, type-checking, testing, building, and security scanning stages for all apps and services in the monorepo.

### Business Context

The existing pipeline only builds Docker images and mirrors to GitHub. There is no CI-level quality gate — broken code, type errors, lint violations, and security vulnerabilities can reach production undetected.

### Acceptance Criteria

- [x] Pipeline has stages: install, validate, test, build, scan, notify
- [x] TypeScript linting (ESLint via Turborepo) runs on TS changes
- [x] TypeScript type-checking runs on TS changes
- [x] Python linting (ruff) runs on Python changes
- [x] API unit tests (Vitest) run on API/package changes
- [x] Package unit tests (Vitest) run on package changes
- [x] SDK/UI unit tests (Vitest) run on frontend package changes
- [x] Python tests (pytest) run per-service: stt-v2, smr, nlp
- [x] Docker builds depend on successful tests (DAG)
- [x] Trivy container scanning after builds
- [x] Trivy source code scanning on MRs
- [x] MR pipelines supported (lint + test + scan, no builds)
- [x] Duplicate pipelines prevented (branch + MR)
- [x] Auto-cancel on new commits to same MR
- [x] Change-path detection with corrected package directory names
- [x] GitHub backup preserved
- [x] Modular file structure (.gitlab/ci/*.yml)

---

## Current State Evaluation

### Previous Pipeline

- **Stages**: `build`, `github-backup` (2 stages only)
- **Jobs**: 7 Docker build jobs + 1 backup job
- **Gaps**: No lint, no type-check, no tests, no security scanning, no MR pipeline support
- **Bugs**: Incorrect package paths in `rules:changes` (missing 's' suffixes, wrong directory names)

### Bugs Fixed

| Old Path | Corrected Path |
|----------|---------------|
| `packages/application/**/*` | `packages/applications/**/*` |
| `packages/domain/**/*` | `packages/domains/**/*` |
| `packages/exception/**/*` | `packages/exceptions/**/*` |
| `packages/vox/**/*` | `packages/agentic-sdk-v2/**/*` |

---

## Implementation Summary

### Architecture

The pipeline follows a 6-stage lifecycle with DAG-based parallelism:

```
install → validate → test → build → scan → notify
```

#### Pipeline Types

| Type | Trigger | Behavior |
|------|---------|----------|
| `release` | Tag `v*` | Full pipeline (all stages, all services) |
| `merge_request` | MR open/update | Lint + test + source scan (no Docker builds) |
| `main` | Push to default branch | Lint + test + build (changed) + container scan + backup |
| `feature` | Push to devops/* | Lint + test + build |

#### Stage Details

| Stage | Jobs | Duration (est.) |
|-------|------|-----------------|
| **install** | `install-node` — pnpm cache warming | ~30s (cached) |
| **validate** | `lint-ts`, `typecheck`, `lint-python` — parallel | ~1-2min |
| **test** | `test-api`, `test-packages`, `test-sdk`, `test-stt-v2`, `test-smr`, `test-nlp` — DAG parallel | ~2-5min |
| **build** | 7 Docker build jobs — parallel after respective tests | ~5-15min |
| **scan** | Trivy container scans (per image) + source code scan | ~2-3min |
| **notify** | `github-backup` | ~30s |

#### DAG Dependencies

```
install-node
├── lint-ts → test-api → build-api → scan-api
│           → test-packages → build-database
│           → test-sdk → build-ui-playground → scan-ui-playground
│
├── typecheck → build-api (also)
│             → build-ui-playground (also)
│
└── lint-python → test-stt-v2 → build-stt-v2 → scan-stt-v2
               │              → build-stt-v2-worker
               → test-smr → build-smr → scan-smr
               → test-nlp → build-nlp → scan-nlp

scan-source (no dependencies, runs parallel)
github-backup (last stage, tags + main only)
```

### File Structure

```
.gitlab-ci.yml                  # Main: workflow, stages, defaults, variables, includes
.gitlab/ci/
  templates.yml                 # .node-base, .python-base, .build-template
  rules.yml                     # .rules-always, .rules-api, .rules-*, .rules-any-*
  install.yml                   # install-node (cache warming, pull-push policy)
  validate.yml                  # lint-ts, typecheck, lint-python
  test.yml                      # test-api, test-packages, test-sdk, test-stt-v2, test-smr, test-nlp
  build.yml                     # build-api, build-ui-playground, build-nlp, build-smr, build-stt-v2, build-stt-v2-worker, build-database
  scan.yml                      # scan-api, scan-ui-playground, scan-stt-v2, scan-smr, scan-nlp, scan-source
  notify.yml                    # github-backup
```

### Key Design Decisions

1. **Modular files over monolith**: 8 included files vs 1 giant file. Each file owns one concern — easier to review, edit, and debug.

2. **`needs` with `optional: true`**: Build jobs depend on test jobs via DAG, but use `optional: true` so the pipeline doesn't break if change-path rules skip the dependency.

3. **MR pipelines skip Docker builds**: Building images on every MR push is wasteful. MRs get lint + test + source scan. Builds only happen on main/tags/devops.

4. **Trivy over GitLab templates**: Trivy is open-source, doesn't require GitLab Ultimate license. Covers both container scanning and source code SAST/secret detection.

5. **`auto_cancel: on_new_commit: interruptible`**: Superseded MR pipeline runs are automatically cancelled, saving runner capacity.

6. **`fallback_keys` for caching**: When a branch-specific pnpm cache misses, it falls back to the main branch cache instead of a cold install.

7. **Separate Python test jobs (not matrix)**: Each Python service has different requirements, test paths, and potentially different base images. Explicit jobs are clearer than a matrix with conditional logic.

8. **Build template exports `IMAGE` via dotenv**: The `.build-template` writes the primary image tag to `build.env`, which scan jobs consume via `artifacts: reports: dotenv`. This ensures scans always target the exact image that was just built.

### Caching Strategy

| Cache | Key | Policy | Used By |
|-------|-----|--------|---------|
| pnpm store | `pnpm-lock.yaml` (file hash) | `pull-push` in install, `pull` elsewhere | All Node.js jobs |
| Turbo cache | Turborepo's built-in | Via Turborepo | build/test commands |
| pip cache (stt-v2) | `pip-stt-v2` | `pull-push` | test-stt-v2 |
| pip cache (smr) | `pip-smr` | `pull-push` | test-smr |
| pip cache (nlp) | `pip-nlp` | `pull-push` | test-nlp |
| Docker layers | Registry-based (mode=max, zstd) | Via BuildKit | All build jobs |

### Security Scanning Coverage

| Scanner | Scope | Stage | Trigger |
|---------|-------|-------|---------|
| Trivy container scan | Each built Docker image | scan | After builds (main/tags) |
| Trivy filesystem scan | Source code (vuln + secrets + misconfig) | scan | All pipeline types |

---

## Change History

| Date | Description | Files Modified |
|------|-------------|----------------|
| 2026-03-23 | Initial pipeline rebuild: 6 stages, modular structure, full test coverage, Trivy scanning | `.gitlab-ci.yml`, `.gitlab/ci/*.yml` (8 files) |
