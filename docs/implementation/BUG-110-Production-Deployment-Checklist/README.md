# BUG-110: Create Production Deployment Checklist for Agentic ALaaS Solution

| | |
|---|---|
| **Status** | `Pending` |
| **Type** | docs (change-request) |
| **Source** | https://github.com/ArcaAI/ALaaSv3.0/issues/110 (labels: documentation, ALaaS; opened 2025-07-14; no comments) |
| **Severity** | Low to Medium (release-process risk; no runtime defect) |
| **Still applicable on dev-2.2?** | Yes as a gap, but the checklist content must be rewritten for the current GitOps deployment. |
| **Date** | 2026-10-06 |

## 1. Requirement Analysis

Deliver `PRODUCTION_DEPLOYMENT_CHECKLIST.md` in the repo root covering: pre-deployment gates, infrastructure, configuration/secrets, build and packaging, release/rollout (canary, rolling vs blue/green), validation (smoke, EMR integration, agent registration, audio capture), monitoring/alerting, rollback (code, DB migrations, cache) and post-deployment. Acceptance: each section present with actionable steps, references to existing automation, version/branch conventions, approvals (QA, Security, Product) and a tested rollback.

## 2. Current State Evaluation (read 2026-10-06)

No file named `PRODUCTION_DEPLOYMENT_CHECKLIST.md` exists in either repo. The material is spread over:

| Topic | Where it lives now |
|---|---|
| Release mechanics, tag grammar, `vX.Y.Z` prod tag, digest-only promotion | `docs/operations/release-runbook.md` (sections 4, 5, 7), `docs/operations/versioning.md`; rule `09-infrastructure-devops.md` "Release Versioning" and "Environments, promotion" |
| CI -> registry -> promote -> Argo -> k3s flow, manifest CI gates, prerequisites outside Git | `hope-v2-deployment/docs/deployment-runbook.md` sections 2, 4, 5 (1171 lines) |
| Rollout safety, zero downtime, how to verify a gapless rollout | `hope-v2-deployment/docs/zero-downtime-deployments.md` sections 2, 6 |
| First deploy / bootstrap credentials / endpoint corrections | `docs/operations/day-one-deployment.md` (has a section 4 "Checklist"), `hope-v2-deployment/docs/first-deployment-2026-09-01.md` |
| EKS day-1 inventory | `hope-v2-deployment/docs/aws-eks/day-1-checklist.md` (derived, not executed on a cluster) |
| Monitoring, alerting, SLOs, retention | `hope-v2-deployment/docs/observability-{alerting,slos,retention}.md` |
| Backups / restore | `hope-v2-deployment/docs/database-backup-restore.md`, `docs/operations/storage/minio-phi-backup.md` |

Facts that make the issue text obsolete or in need of reinterpretation:

- Only `dev` is real. `staging` and `prod` overlays exist as files but have no namespace and no Argo Application (rule 09, "Only `dev` is real"). A production checklist would describe an environment that has not been stood up.
- Deployment is Git-only: promotion by `promote-dev/staging/prod` jobs pinned by digest, with a fail-closed freshness stamp (TASK-990). "VM build", "canary/proxy checks", "blue/green" and manual DNS/LB/SSL steps from the issue do not match this model (Traefik behind cloudflared, one node).
- Rollback is Git/digest based. Prisma migrations are roll-forward only (rule 02: never edit a committed migration), so "database migration rollback" cannot be a checklist step; the only recovery is restore from backup.
- The "agentic ALaaS solution" is now ALaaS (separate repo, `ALaaSv3.0`) calling HOPE; a release touches both repos plus the SDK family, which is published locally by the owner per `docs/operations/vox-sdk-release/`.

## 3. Root Cause / Gap

Documentation gap: the operational knowledge exists but there is no single ordered, sign-off style checklist that an engineer or approver can execute for a production rollout, and no statement of the approval gates (QA, security, product).

## 4. Implementation Plan

1. Tests first: docs have no unit tests; define verification up front instead: every command and path in the checklist exists (run `ls`/`pnpm run --help` style existence checks, as `docs/development-patterns-and-standards.md` already does), and each link resolves.
2. Order of work: (a) decide location (OD-1); (b) write a thin checklist that LINKS to the runbooks above instead of copying them; sections mirror the issue but are re-expressed as: pre-flight (branch `dev-2.2` state, ticket README evidence, gates), release train tag (`ALL-x.y.z`) and prod tag (`vX.Y.Z`), `promote-prod` manual job and stamp, Argo sync verification, smoke test (`hope-smoke-test` Job, `pnpm stack:dev:doctor` equivalent), monitoring check, rollback (re-run promote with `PROMOTE_ALLOW_STALE=true`, restore from backup for data), post-deploy sign-off; (c) have the owner dry-run it on `dev` once.
3. Verification: dry run on the `dev` cluster following only the checklist; record the transcript in this README.

## 5. Risks / Open Questions (owner decisions)

- OD-1: Location. The issue says repo root; HOPE keeps docs under `docs/operations/` and cluster runbooks in `hope-v2-deployment`. Recommend `hope-v2-deployment/docs/production-deployment-checklist.md` with a pointer from `docs/operations/release-runbook.md`.
- OD-2: Write it now for a prod that does not exist, or defer until a prod namespace is stood up? A checklist never executed is the same risk as the unvalidated `aws-eks` day-1 list.
- OD-3: Who are the named approvers (QA, Security, Product) and is there a formal gate?
- OD-4: Database-change policy for prod (backup before migrate? maintenance window?). `db-migrate` runs as a PreSync Job today.
- Not verified: current content of `staging`/`prod` overlays beyond file existence.

## 6. Implementation Summary

Not started.

## 7. Change History

| Date | Change |
|---|---|
| 2026-10-06 | Created from ALaaSv3.0#110 after review of hope-v2 `dev-2.2` and `hope-v2-deployment` (main). |
