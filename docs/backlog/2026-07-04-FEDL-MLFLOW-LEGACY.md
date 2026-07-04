# Parked — Legacy FedL Schema Models + MinIO `mlflow` Bucket

- **Source:** TASK-412 known issue #3 → TASK-414 disposition (2026-07-04). Removal explicitly deferred by decision on 2026-07-04: keep the schema, discuss before any removal.
- **Status:** **Parked** — needs product/engineering discussion; any removal is data-destructive (DROP-table migration / bucket deletion) and requires explicit approval.

## Context

The federated-learning (FedL) feature was retired, but its artifacts remain:

1. **Prisma models** — `packages/database/src/prisma/db_main/fedl.prisma`: `FedlClient`, `FedlRound`, `FedlUpdate`, `FedlModelVersion` + enum `FedlRoundStatus`. No app or application service consumes them (verified in TASK-412's architecture review); they are documented as legacy in `docs/architecture/data-and-domain-model.md`.
2. **Generated domain trios** — entities/factories/mappers/models/repositories for the four models under `packages/domains/src/*/generated/core/` (kept in sync by the generator drift gates).
3. **Live references outside the schema** — `packages/database/src/prisma/db_main/seed/01-policy.ts` (RBAC policy seeds over FedL resources) and `packages/tools/src/utils/schemaCoverage.ts`; historical migration `20260320044312` (stays regardless).
4. **MinIO `mlflow` bucket** — still created by the init containers in `infrastructure/docker/docker-compose.yml` and `tests/docker-compose.test.yml`; `apps/stt-v2` still reads `MLFLOW_TRACKING_URI`/`MLFLOW_DB_*` settings (`src/stt_v2/core/config/settings.py`), though no MLflow server exists in the repo (the orphaned image folder was removed in TASK-414).

## Decision points for the discussion

1. Is FedL permanently retired, or plausibly revived (in which case the schema stays as-is)?
2. If retired: do any environments hold FedL rows or `mlflow` bucket objects that need export/retention before deletion (PHI/compliance review)?
3. Does stt-v2's MLflow settings surface go too (code change in `apps/stt-v2`), or does experiment tracking return in another form?

## Scope when picked up (only after approval)

1. Remove `fedl.prisma` + regenerate domain trios (`pnpm gen:*`); clean seed policies and `schemaCoverage` references; migration with `DROP TABLE` (requires explicit approval per project DB-safety rules).
2. Remove `mlflow` bucket creation from both compose init containers; decide on bucket data in shared/dev environments.
3. Optionally strip MLflow settings from stt-v2 config + `env.stt-dev.example`.
4. Update `docs/architecture/data-and-domain-model.md` (model count/groups), traceability matrix, and allow-lists in `packages/database` if affected.

- **Effort:** M (schema + generators + seeds + compose + docs), plus coordination for data retention sign-off.
