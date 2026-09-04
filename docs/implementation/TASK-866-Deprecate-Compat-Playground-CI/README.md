# TASK-866 — Deprecate compat-playground CI, scripts, and release tags

| | |
|---|---|
| **Status** | Review |
| **Type** | infrastructure |
| **Packages** | `.gitlab/ci/**`, `.github/services.json`, `scripts/`, `packages/utils` (version grammar), `tests/contracts` |
| **Created** | 2026-09-04 |

## 1. Requirement Analysis

Owner directive (2026-09-04):

> As we are deprecating the compat-playground, review and update all scripts and CI pipelines to ignore and disable any activities related to compat-playground.

Restated:

| # | Requirement |
|---|---|
| R-1 | No GitLab job tests, builds, scans, signs, or SBOMs `compat-playground`. |
| R-2 | Promotion and image-fetch do not include `compat-playground`. |
| R-3 | `COMPAT-` is no longer a valid service release-tag prefix. |
| R-4 | Aggregate repo scripts (`lint` / `test` / `build` / `typecheck`) skip `@arcaai/compat-playground`. |
| R-5 | The app stays on disk (local `pnpm compat:*` remains the opt-in). This ticket does not delete `apps/compat-playground`. |

## 2. Current State Evaluation

- Dedicated jobs: `test-compat-playground`, `build-compat-playground`, `scan-compat-playground`, `sbom-compat-playground`, `sign-compat-playground`.
- Inventory: `.github/services.json` (`promotable: true`), `.gitlab/ci/promote.sh` `SERVICES=`, `SERVICE_TAG_PREFIXES` includes `COMPAT`.
- Aggregate: `pnpm turbo lint` / `turbo run test|build|typecheck` still pick up the workspace. Root vitest already excludes it.
- Precedent: vLLM hold (2026-09-02) — leading-dot hidden jobs, drop the services.json entry, keep YAML for re-enable.

## 3. Implementation Plan

Follow the vLLM hold pattern. Hide jobs (do not delete). Drop inventory entries. Filter aggregate scripts. Update the services-manifest / version-grammar / dockerfile-build-info contracts so they stay bidirectional.

## 4. Implementation Summary

Followed the vLLM hold pattern (leading-dot hidden jobs, inventory drop, YAML kept for re-enable). The app stays in the tree; local `pnpm compat:*` is the only remaining activity.

### What is now disabled

| Surface | Change |
|---|---|
| GitLab jobs | `test-` / `build-` / `scan-` / `sbom-` / `sign-compat-playground` renamed with a leading dot — never instantiated |
| Image inventory | Dropped from `.github/services.json` and `promote.sh` `SERVICES=` |
| Release tags | `COMPAT` removed from `SERVICE_TAG_PREFIXES`; `COMPAT-1.0.0` is rejected |
| Aggregate scripts | `pnpm lint` / `lint:fix` / `test` / `build` / `build:apps` / `typecheck` and CI `lint-ts` skip `@arcaai/compat-playground` |
| Env inventory | `scripts/env-consumer-inventory.py` no longer scans the app |

### Verification

```
Test Files  3 passed (3)
     Tests  76 passed (76)
```

Files: `packages/utils/src/__tests__/version-grammar.test.ts`, `tests/contracts/services-manifest.contract.test.ts`, `tests/contracts/dockerfile-build-info.test.ts`.

### Files changed

- `.gitlab/ci/{test,build,scan,publish,rules,validate}.yml`, `.gitlab/ci/promote.sh`, `.gitlab-ci.yml`
- `.github/services.json`
- `packages/utils/src/version-grammar.ts` + test
- `package.json`, `scripts/env-consumer-inventory.py`
- `tests/contracts/dockerfile-build-info.test.ts`
- Docs: `docs/operations/versioning.md`, `docs/development-guide.md`, `docs/development-patterns-and-standards.md`, `apps/compat-playground/README.md`

### Out of scope (app not deleted)

`apps/compat-playground` source, Dockerfile, and `pnpm compat:*` remain as a local opt-in.

## 5. Change History

| Date | Change |
|---|---|
| 2026-09-04 | Ticket opened. Disable CI/scripts for deprecated `apps/compat-playground`. |
| 2026-09-04 | Hidden CI jobs, dropped inventory/COMPAT prefix, filtered aggregate scripts. 76 contract/grammar tests green. |
