# TASK-414 — Known-Issues Remediation (Post-Cleanup Residuals)

- **Ticket:** TASK-414
- **Created:** 2026-07-04
- **Updated:** 2026-07-04
- **Status:** Completed
- **Type:** bugfix / infrastructure / refactor

## Requirement Analysis

TASK-412 (documentation realignment) surfaced 11 code-side stale leftovers and inconsistencies that documentation alone could not fix. This ticket remediates them. Source list: `docs/implementation/TASK-412-Documentation-Realignment/README.md`, section "Known issues flagged for engineering follow-up".

## Implementation Plan (disposition per issue)

| # | Issue | Action |
|---|---|---|
| 1 | Root `package.json` dead `dev:admin` script (`@arcaai/admin` removed) | Remove script; sweep for other `@arcaai/admin` references |
| 2 | `tests/contracts/tts.contract.test.ts` + TTS schemas target removed service | Delete test, remove TTS schemas, update doc mentions |
| 3 | Orphaned `infrastructure/docker/mlflow/` Dockerfile; legacy FedL Prisma models; MinIO `mlflow` bucket | Remove orphaned Dockerfile folder. **FedL model + MinIO bucket removal parked to backlog** (user decision 2026-07-04): `docs/backlog/FEDL-MLFLOW-LEGACY-2026-07-04.md` — schema stays until discussed |
| 4 | Duplicate `components:` keys in `deployment/k3s/overlays/{dev,prod}/kustomization.yaml` (invalid YAML) | Merge into single valid list, preserve entries, validate parse/kustomize build |
| 5 | Deploy-flow contradiction: overlay comments claim in-repo tag updates; CI writes to separate `hope-deployments` repo; ArgoCD Image Updater examples track `:latest` which CI never pushes; missing `nlp` image alias | Correct comments to real flow; align or remove Image Updater annotations in `.example` files (minimal honest fix); fix `nlp` alias if annotations kept |
| 6 | No Postgres manifest in `k3s/base` while config points at `hope-postgres` | Do not create a manifest; document external-provisioning expectation in `configmap.yaml` comment + `deployment/README.md` |
| 7 | `infrastructure/SECURITY_DEPLOYMENT_GUIDE.md` links to `../research/...` (moved to `docs/research/`) | Fix links, verify targets |
| 8 | Live architecture-lint violations: `consultation.service.ts:615`, `platform-metrics.service.ts:101` (direct `databaseService.client`) | Refactor through domain repositories (TDD; no edits to generated files); verify lint/tests/build |
| 9 | `config-eslint/package.json` `files` lists `nest.js` (actual `nestjs.js`); `config-rollup` `types` points to nonexistent `base.d.ts` | Fix package metadata to match files on disk |
| 10 | Stale JSDoc `session.create` in `packages/agentic-sdk-v2/src/index.ts`; stale `modelPath` option in `packages/stt/assets/README.md` | Correct to real APIs (`session.open`, `features.modelId`) |
| 11 | `.gitlab-ci.yml` header lists ui-playground as active; `build-harness` needs nonexistent `test-harness` job; `lint-python` skips harness | Fix header wording; add `test-harness` job only if suite passes locally; include harness in `lint-python` only if clean |

Execution: issues 4–6 and 8+11 delegated to two parallel agents; issues 1, 2, 3 (partial), 7, 9, 10 fixed directly.

## Implementation Summary

All 11 issues remediated except the explicitly deferred data-destructive part of issue 3.

### Repo hygiene (issues 1, 2, 3-partial, 7, 9, 10)

- **1** — `dev:admin` removed from root `package.json` (JSON validated; no other `@arcaai/admin` references remain).
- **2** — `tests/contracts/tts.contract.test.ts` deleted; TTS schemas + type exports removed from `tests/contracts/schemas.ts` (no other consumers, verified by grep); contract suite green afterwards (48 tests, STT + SMR); `tests/README.md`, `docs/traceability-matrix.md`, `docs/development-guide.md` notes updated.
- **3 (partial)** — orphaned `infrastructure/docker/mlflow/` (Dockerfile + requirements.txt) deleted; rows removed from `infrastructure/README.md` and `infrastructure/docker/README.md`. `MLFLOW_*` entries in `env.stt-dev.example` retained — `apps/stt-v2` settings still read them. **FedL Prisma models + MinIO `mlflow` bucket:** kept, parked to `docs/backlog/FEDL-MLFLOW-LEGACY-2026-07-04.md` for discussion (user decision 2026-07-04 — no removal without approval).
- **7** — 15 stale `../research/...` links in `infrastructure/SECURITY_DEPLOYMENT_GUIDE.md` fixed to `../docs/research/...`; every target verified to exist.
- **9** — `config-eslint` `files`: `nest.js` → `nestjs.js`; `config-rollup` nonexistent `"types": "base.d.ts"` removed; both READMEs' defect notes cleared.
- **10** — `@arcaai/vox` `src/index.ts` JSDoc corrected to `session.open()` (no `doctorId`); `packages/stt/assets/README.md` fictional `modelPath` option replaced with the real `features.modelId` mechanism (verified against `STTOptions` / `resolveLocalWhisperModel`).

### Deployment manifests (issues 4–6, agent-executed, validated)

- **4** — duplicate `components:` keys merged in both overlay kustomizations. Both duplicate lists held the identical single entry (`../../components/registry`), so effective activation is unchanged — proven by byte-identical `kubectl kustomize` renders (kustomize v5.6.0) before/after; strict duplicate-key YAML validation passes on all 21 files under `deployment/`.
- **5** — overlay comments now describe the real flow (CI pushes `dev-<sha8>`/`staging-<sha8>`/`sha-<sha8>`/semver — never `latest`; staging deploys via the separate `hope-deployments` repo; overlay tags updated manually/by promotion). Dev bootstrap example: dead Image Updater CR (digest strategy on `regexp:^latest$`) removed with explanatory note; updater install marked optional. Prod bootstrap example: Image Updater kept (semver tags are a real automatable stream), constrained with `allowTags: regexp ^X.Y.Z$`, missing `nlp` alias added. `deployment/README.md` aligned.
- **6** — external `hope-postgres` provisioning documented: comment in `k3s/base/configmap.yaml` (options: alias Service per the `hope-lmstudio` pattern, or real host in config+secrets) and a "Database provisioning" subsection in `deployment/README.md` (includes the `hope-db-migrate` PreSync-Job connectivity constraint). No Postgres manifest invented.

### Code + CI (issues 8, 11, agent-executed, TDD)

- **8** — both `databaseService.client` violations eliminated by routing through the domain layer: new `ConsultationRepository.findCreatedInRange(rangeStart, rangeEnd, tenantId?)` (exact projection/filters preserved, incl. cross-tenant SUPER_ADMIN read when `tenantId` falsy) and four aggregate methods — `AudioRecordingRepository.sumDurationForTenant`, `SummaryMetaRepository.countGeneratedSince`, `MediaRepository.sumSizeForTenant`, `TenantBucketRepository.sumConfiguredQuotaBytes`. Services now inject repositories; `CoreDatabaseService` removed from both constructors. Tests written first (7 new tests, RED→GREEN); 4 existing app test files updated. Evidence: zero `databaseService` matches in both files; zero `no-restricted-syntax` diagnostics in the package lint; `@arcaai/domains` 1299 passed, `@arcaai/applications` 5789 passed; both packages build. Note: custom methods live in `repositories/generated/core/*.ts` — the de-facto sanctioned pattern (repositories are generate-once scaffolds hand-extended by convention; CI drift gates cover data-models/entities/factories only).
- **11** — `.gitlab-ci.yml` header marks ui-playground DEPRECATED (build jobs untouched); new `test-harness` job in `.gitlab/ci/test.yml` mirroring the smr/guardrail pattern (justified by local run: 638 passed; hermetic — no DB/Redis; installs `.[test,eval,rag]` because tests import `qdrant_client` at collection) with a `.rules-harness` template in `rules.yml`; `lint-python` now covers `apps/harness/src/` (justified by local ruff: all checks passed) and `.rules-any-python` triggers on harness paths.

### Post-remediation doc/rule alignment

`.cursor/rules/06-python-services.mdc` (harness CI pitfall → hermetic-suite guidance), `.cursor/rules/09-infrastructure-devops.mdc` (CI gate table), `docs/development-patterns-and-standards.md` (inconsistencies 1, 5, 7 marked remediated; CI tables), `docs/development-guide.md` (harness CI row).

## Newly Discovered Issues (found during remediation — need decisions, not fixed here)

> **Follow-up:** tracked in [TASK-416 — K3s Image Pipeline Fixes](../TASK-416-K3s-Image-Pipeline-Fixes/README.md) (status Pending, plan awaiting approval).

Found by the deployment review while fixing issues 4–6 (all pre-date TASK-414; confirmed via `kubectl kustomize` renders):

1. **Overlay `newTag` pins never take effect.** The `registry` component's `newName` rewrite runs before the overlay `images:` blocks, whose entries still match the original `hope-v2/*` names — so every service renders as `registry.taphuynh.dev/arca/hope-v2/*:latest` in both dev and prod, and `latest` is a tag CI never pushes. Fix requires matching the rewritten names in the overlays (changes rendered output; dev auto-syncs from `main`, so needs deliberate review). Caveat comments added in both overlays + README "Known gap" note.
2. **`guardrail` image is unmanaged everywhere** — not rewritten by the registry component, not pinned by any overlay, not tracked by Image Updater; renders as an unpullable unqualified docker.io name.
3. **`nlp.yaml` exists but is not registered in `k3s/base/kustomization.yaml`** — no NLP workload renders; overlay/Image-Updater `nlp` entries are inert until registered.

## Change History

| Date | Description | Files |
|---|---|---|
| 2026-07-04 | Ticket opened; remediation executed (2 parallel agents + direct fixes); all 11 issues closed except deferred FedL/mlflow-bucket data removal; 3 newly discovered deployment gaps recorded. Status → Completed. | ~30 files: root `package.json`, `tests/contracts/*`, `infrastructure/{README.md,docker/README.md,SECURITY_DEPLOYMENT_GUIDE.md}`, `packages/{config-eslint,config-rollup}/{package.json,README.md}`, `packages/agentic-sdk-v2/src/index.ts`, `packages/stt/assets/README.md`, `deployment/**` (6), `packages/applications` services+tests (6), `packages/domains` repositories+tests (7), `.gitlab-ci.yml` + `.gitlab/ci/*` (4), rules/docs alignment (4) |
| 2026-07-04 (later) | Ticket renumbered TASK-413 → TASK-414 (user resolved numbering collision; dependency audit keeps TASK-413). All 30+ TASK-413 references in remediation code/docs/CI/deployment comments updated to TASK-414, incl. renaming `platform-consumption-aggregates.task413.test.ts` → `.task414.test.ts`. FedL/mlflow removal parked to `docs/backlog/FEDL-MLFLOW-LEGACY-2026-07-04.md` (user decision: keep schema, discuss first). Deployment gaps spun out into follow-up ticket TASK-416 (Pending). | ticket references across `packages/{applications,domains}`, `.gitlab/ci/*`, `deployment/**`, docs/rules; `docs/backlog/FEDL-MLFLOW-LEGACY-2026-07-04.md` (new); `docs/implementation/TASK-416-K3s-Image-Pipeline-Fixes/README.md` (new) |
