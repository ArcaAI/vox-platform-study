# TASK-412 — Documentation Realignment & Rules Refresh

- **Ticket:** TASK-412
- **Created:** 2026-07-04
- **Updated:** 2026-07-04
- **Status:** Completed
- **Type:** docs / infrastructure

## Requirement Analysis

Following a repository cleanup (removal of temp files, the `knowledge/` folder, and `apps/admin`; relocation of old tickets to `docs/archive/` and `research/` to `docs/research/`; deprecation of `apps/ui-playground` with no further development plan), all documentation and Cursor rules had drifted from reality. Scope:

1. Rewrite all `packages/*` README files — stale information completely removed, content verified against current code.
2. Create/update documentation for `scripts/`, `tests/`, `infrastructure/`, `deployment/`.
3. Deep review producing aligned documents in `docs/`: high-level architecture, data flow, core business domains, a traceability matrix, and an inventory of development patterns and standards.
4. Review and update all rules in `.cursor/rules` except `_karpathy.mdc` — context-triggered (globs), best-practice-backed, specific to this monorepo.
5. A comprehensive development guide for engineers.

## Current State Evaluation (before)

- Root README and multiple package READMEs linked to the removed `knowledge/` folder and listed removed apps (`admin`, `tts`, `mlflow`).
- Package READMEs documented nonexistent APIs (`ValidationException`, `validateEmail`, `session.create()`, `getPrismaClient`), wrong structures, and dead links.
- `scripts/`, `tests/`, `infrastructure/` (top level), `infrastructure/single-deployment/`, and `packages/eslint-plugin-arcaai-internal/` had no README at all.
- Cursor rules taught deprecated patterns (`startTransaction()/endTransaction()`), fictional commands (`make dev-up`, `start-dev.sh`), removed apps/ports, and the Tailwind v3 preset approach.
- No architecture overview, data/domain-model doc, traceability matrix, patterns inventory, or development guide existed in `docs/`.

## Implementation Plan

Executed as parallel agent waves (all content verified against source code before writing):

- Wave 1 (parallel): 3 agents for package READMEs (backend, audio/SDK, UI/tooling/config); 1 agent for directory docs; 1 agent for architecture + traceability + docs alignment; 1 agent for the patterns/standards inventory.
- Wave 2 (parallel, consuming Wave 1 outputs): 1 agent rewriting `.cursor/rules`; 1 agent writing the development guide + root README.
- Finalization: stale-reference sweep, fixes, this ticket document.

## Implementation Summary

### 1. Package READMEs (21 files: 20 rewritten, 1 created)

All `packages/*/README.md` rewritten and verified against code, each stamped "Last updated: 2026-07-04". `packages/eslint-plugin-arcaai-internal/README.md` created (documents both custom architecture lint rules). Highlights of stale content removed: nonexistent APIs (`ValidationException`, `validateEmail`, `session.create()`), dead `docs/agentic-sdk-v2` and `docs/implementation` links, wrong component inventories (`@arcaai/ui`: actual 57 shadcn primitives), outdated bundle-size claims, DaisyUI claims, "future plugin packages" that shipped long ago, and the broken `pnpm gen-dev-token -- -l` invocation style.

### 2. Directory documentation (6 files)

- `scripts/README.md` (new) — all 22 scripts + `chaos/`, grouped, with pnpm alias mapping and common workflows.
- `tests/README.md` (new) — shared test tree, suite-to-command matrix, unit/integration/e2e/contract/cross-tenant placement.
- `infrastructure/README.md` (new) — compose files/profiles/ports, `pnpm infra:*` mapping, grafana, pointers.
- `infrastructure/single-deployment/README.md` (new) — Vault HA blueprint inventory and when-to-use table.
- `deployment/README.md` (rewritten) — real k3s/ArgoCD manifests, environments, bootstrap, CI flow.
- `infrastructure/docker/README.md` (link fixes only).

### 3. Architecture & alignment docs in `docs/`

- `docs/architecture/overview.md` (new) — system context, C4 + sequence mermaid diagrams, verified service topology (ports 8861–8868 + data plane), gateway module inventory, DDD layering, deployment topologies.
- `docs/architecture/data-and-domain-model.md` (new) — 69-model entity groups, multi-tenancy mechanics, soft delete, SysEvent/audit, PHI encryption, Postgres/MinIO/Qdrant/Redis lifecycle.
- `docs/traceability-matrix.md` (new) — 24 capability rows: capability → service → packages → Prisma models → routes → tests.
- `docs/development-patterns-and-standards.md` (new, 500 lines) — verified pattern inventory with exemplar paths; includes 10 known internal inconsistencies and a 20-item quick-reference card.
- `docs/README.md` rewritten as the docs-tree index; stale references fixed across `docs/research/` and `docs/operations/` (archive left untouched as historical record).

### 4. Cursor rules (13 rewritten + index; `_karpathy.mdc` untouched)

All rules corrected against the verified pattern docs and current best practices (NestJS 11, Prisma 7, React 19, Tailwind v4, Zustand v5, FastAPI/pydantic-settings, Temporal, ArgoCD GitOps): `00`/`01` remain alwaysApply with corrected facts; `02`–`09` auto-attach via globs to their layer/service directories; `09-infrastructure.mdc` renamed to `09-infrastructure-devops.mdc`; `10`/`11` scoped to frontend globs; `12` converted to Agent Requested. Key corrections: extended-client-only Prisma access (`getExtendedPrismaClient`), `runInTransaction` over deprecated `startTransaction()`, `session.open()` SDK API, Tailwind v4 CSS-first tokens, real infra commands (`pnpm infra:*`, `dev:stack`, `dev:doctor`), lint-encoded architecture rules with the only-warn caveat.

### 5. Development guide

- `docs/development-guide.md` (new, 302 lines) — prerequisites, verified first-time setup, daily dev loop, ports reference, project layout, database workflows, all test suites with exact commands, code-quality gates, ticket workflow, deployment overview, 11 troubleshooting entries, documentation map.
- Root `README.md` rewritten (structure tree, verified quick start, key commands, docs table, corrected tech stack).

### Files changed

45 modified + 10 created (see `git status`); no code, configs, or scripts were modified — documentation and `.cursor/rules` only. Nothing committed.

### Known issues flagged for engineering follow-up (not fixed here)

> **Follow-up:** all 11 items below were remediated in [TASK-414](../TASK-414-Known-Issues-Remediation/README.md) (2026-07-04), except the FedL-model/MinIO-bucket removal, which was moved to the backlog for discussion (`docs/backlog/FEDL-MLFLOW-LEGACY-2026-07-04.md`).

1. Root `package.json` still defines `dev:admin` targeting the removed `@arcaai/admin`.
2. `tests/contracts/tts.contract.test.ts` (+ TTS schemas) target a removed service.
3. `infrastructure/docker/mlflow/` is an orphaned Dockerfile; legacy FedL Prisma models and the MinIO `mlflow` bucket have no consuming app.
4. `deployment/k3s/overlays/{dev,prod}/kustomization.yaml` each contain a duplicate `components:` key (invalid YAML mapping).
5. Deploy-flow contradiction: ArgoCD ImageUpdater tracks `:latest` tags that CI never pushes; CI `deploy-staging` writes to a separate `hope-deployments` repo while overlay comments claim in-repo tag updates.
6. No Postgres manifest in `k3s/base` although configs point at `hope-postgres`.
7. `infrastructure/SECURITY_DEPLOYMENT_GUIDE.md` still links to `../research/...` (folder moved to `docs/research/`).
8. Live lint violations: `consultation.service.ts:615`, `platform-metrics.service.ts:101` (direct `databaseService.client`, warnings due to only-warn).
9. `config-eslint/package.json` `files` lists `nest.js` (file is `nestjs.js`); `config-rollup` `types` points to nonexistent `base.d.ts`.
10. Stale JSDoc in `packages/agentic-sdk-v2/src/index.ts` (`session.create`) and `packages/stt/assets/README.md` (`modelPath`).
11. `.gitlab-ci.yml` header still lists ui-playground as an active build target; harness has no `test-harness` CI job though `build-harness` references one.

## Change History

| Date | Description | Files |
|---|---|---|
| 2026-07-04 | Initial realignment: all package READMEs, directory docs, architecture/traceability/patterns docs, Cursor rules rewrite, development guide, root README. | 55 files (45 modified, 10 created) |
