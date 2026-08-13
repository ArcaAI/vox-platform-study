# TASK-596 — ArcaAI Production Deployment Readiness Playbook

**Status**: Review
**Classification**: docs (informed by a live infrastructure/deployment gap audit)
**Scope**: ArcaAI tenant's day-1 production launch on k3s + ArgoCD + Rancher
**Created**: 2026-07-31

## 1. Requirement Analysis

The ask: a best-practices playbook/checklist for getting "everything production-ready on day one" for ArcaAI's launch, on the k3s/Rancher/ArgoCD stack this platform actually uses. This is deliberately **grounded in what this repo currently contains**, not generic Kubernetes advice — every item below cites the file(s) that back the claim. Where the real answer lives outside this repo (a separate `hope-deployments` repo — see §2), the item says so explicitly rather than guessing.

This document is a checklist, not a finished implementation — no code was changed to produce it (aside from the seed-script fix from the prior session). Treat every ❌/⚠️ row as a candidate for its own ticket.

## 2. Current State Evaluation — headline findings

**The single biggest finding: the in-repo k3s + ArgoCD manifest tree no longer exists.** `deployment/k3s/base/` and `overlays/{dev,prod}` were deleted on 2026-07-24 (commit `1de5b8c1`, −2622 lines), and `deployment/README.md` documents why: stale service names (`stt-v2`), `:latest`-tagged images, and secrets injected via a materialized k8s `Secret` (forbidden for PHI per TASK-558 §9.2 L7). **The live deploy path now lives in a separate `hope-deployments` repo that ArgoCD watches** — this repo only writes image tags into it via CI. That means most of `.claude/rules/09-infrastructure-devops.md`'s description of the k3s base is now **stale/aspirational**, describing a tree that no longer exists here.

Practical consequence for this playbook: everything under "GitOps Topology," "Networking/Ingress," and "Scaling & Resilience" below cannot be verified from this codebase at all. Those sections tell you what to go verify in `hope-deployments` / on the live cluster, not what's wrong with a manifest I can point you to.

Other headline gaps, expanded in the tables below:
- **No `deploy-production` CI job exists.** `prod-*` branches build and tag images; nothing ships them anywhere.
- **Storage credentials are not Vault-backed for any tenant, including ArcaAI** — every tenant runs on plaintext env-fallback S3 credentials today. This is the same subsystem behind the `"http://"` endpoint bug fixed earlier this session.
- **MinIO backup covers only metadata**, not actual object data — meaning patient recordings/attachments currently have no backup path at all.
- **Vault's own production pre-cutover checklist is entirely unchecked** (root-token revocation, alerting, Raft snapshots).
- **ArcaAI's own day-1 seed (TASK-593) is still in progress**, and was deliberately scoped down from a full clone to "one doctor per department" — Global's demo consultations/DNA/audit logs are not cloned.

## 3. Playbook / Checklist

Priority key: **P0** = blocks a responsible day-1 launch · **P1** = fix within the first week · **P2** = harden after launch, not urgent.

### A. GitOps Topology (ArgoCD + Rancher + k3s)

| # | Item | Status | Finding | Action | Priority |
|---|---|---|---|---|---|
| A1 | k3s workload manifests (api, guardrail, smr, nlp, harness, tts, stt, stt-worker, admin-console, redis, db-migrate) | ❌ Absent here | Deleted 2026-07-24 (`1de5b8c1`); live path is the external `hope-deployments` repo | Confirm `hope-deployments` actually has complete, current manifests for every workload before day-1 — this is the largest single unknown | **P0** |
| A2 | ArgoCD `Application`/`ApplicationSet` manifests | ❌ Absent here | Zero hits repo-wide for `kind: Application`/`argoproj.io`; would live in `hope-deployments` or a bootstrap repo | Verify sync policy is actually configured as documented (dev: auto-sync+prune+self-heal from `main`; prod: manual sync from `prod`) — the in-repo description is prose only now | **P0** |
| A3 | Rancher-specific config | ⚠️ Prose-only | Used only as the k3s installer + ingress controller on a homelab VM (`docs/research/deployments/deploy-vm400-master.md`); no Rancher project/cluster/fleet manifests anywhere | If Rancher's project/cluster RBAC or fleet features are meant to be part of the production posture, verify that setup live — nothing to audit here | P1 |
| A4 | Post-sync health verification | ❌ Absent | No ArgoCD PostSync hooks anywhere; only `smoke-pgbouncer-staging` exists, and it's staging-only, PgBouncer-specific | Add a PostSync hook or CI post-deploy job that curls each service's `/api/v1/health` before declaring a prod sync healthy | **P0** (manual check acceptable for day-1; automate after) |

### B. CI/CD Pipeline

| # | Item | Status | Finding | Action | Priority |
|---|---|---|---|---|---|
| B1 | Production deploy job | ❌ Absent | `.gitlab/ci/deploy.yml` has `deploy-staging`, `sync-argocd` (staging-gated), `smoke-pgbouncer-staging` only. `prod-*` branches build+tag images (`build.yml:22`) but nothing writes them into `hope-deployments`'s prod values | Add a `deploy-production` job mirroring `deploy-staging`, with its own `environment: production` block and approval gate | **P0** |
| B2 | Gitleaks scan | ❌ Disabled | `scan-gitleaks` is fully commented out in `.gitlab/ci/scan.yml` despite the job header claiming "MUST pass"; `.gitleaks.toml` is live and unused | Re-enable before go-live — secret-leakage scanning matters on a PHI platform | **P0** |
| B3 | Trivy container scans | ⚠️ Advisory-only, partial coverage | `allow_failure: true` on every scan job; CRITICAL check itself is `\|\| echo` (never fails); no scan job exists for guardrail, harness, tts, admin-console, database, or stt-worker images | Add missing service coverage; make CRITICAL findings blocking before prod promotion | P1 |
| B4 | Image tagging hygiene | ⚠️ Partial | Semver expansion (`1.2.3`→`1.2`→`1`) documented but not implemented; `hope-python-base` still publishes `:latest`; per-service Dockerfiles default `ARG BASE_IMAGE=...:latest` (CI overrides correctly, but a manual/local build would silently pull `latest`) | Fix the Dockerfile default at minimum; low urgency since CI already overrides it | P2 |
| B5 | `ui-playground` build job | ❌ Absent, but likely fine | Pipeline docs still reference it as "built + deployed"; the app itself is DEPRECATED per `07-react-ui.mdc` | Remove the stale CI reference rather than building the dead app | P2 |
| B6 | Formal promotion gate (dev→staging→prod) | ❌ Absent | Promotion is branch-naming convention only — no pipeline step confirms staging was validated before a prod cut | At minimum, a manual pre-cut checklist; consider a required-approval step once B1 exists | P1 |
| B7 | Rollback mechanism | ❌ Absent (implicit only) | No automated rollback; "revert the commit in `hope-deployments`, let ArgoCD self-heal" is the only path, and it's undocumented as a runbook | Write the rollback runbook down and rehearse it once before go-live | **P0** |

### C. Secrets & Credentials (Vault)

| # | Item | Status | Finding | Action | Priority |
|---|---|---|---|---|---|
| C1 | Vault HA in the live deploy path | ⚠️ Disconnected | HA blueprint (3-node Raft + Transit auto-unseal) exists in `infrastructure/single-deployment/` but the live cluster path is the separate `hope-deployments` repo | Verify Vault HA is actually running and correctly unsealed against the real production cluster — cannot be confirmed from this repo | **P0** |
| C2 | Production pre-cutover checklist | ❌ Entirely unchecked | `docs/operations/vault/README.md`'s own checklist (root-token revocation, alerting wired, AppRole file contract, `rotate-secret-id.sh` in the pipeline, Raft snapshot CronJob) is all `[ ]` | Work through this checklist — it already exists, it's just not done | **P0** |
| C3 | Vault backup | ❌ Absent | No Raft snapshot CronJob exists anywhere in-repo | Add one before go-live — Vault itself currently has no backup | **P0** |
| C4 | GitLab branch protection | ❌ Gap | `dev`/`staging` are unprotected branches, so `hope-ci-deploy`'s Vault OIDC `bound_claims.ref` scoping is nominal, not enforced — anyone who can push to `dev`/`staging` can mint deploy credentials | Protect those branches before go-live | **P0** |
| C5 | Tenant storage credentials | ❌ Env-fallback for everyone | `TenantStorageConfig.credentialsRef` is written as a Vault **path** only (never seeded with real JSON — `scripts/vault-seed-secrets.sh` explicitly refuses to seed it); every tenant, including ArcaAI, silently falls back to plaintext `S3_ACCESS_KEY`/`S3_SECRET_KEY` env vars. Same subsystem as the `"http://"` bug fixed this session | Either populate `platform/storage/minio` in Vault with real credentials before day-1, or explicitly accept env-tier for launch with a documented fast-follow date | **P0** |
| C6 | Vault-kv descriptor coverage | ⚠️ 4 gaps | `HARNESS_INTERNAL_SERVICE_TOKEN`, `STORAGE_ACCESS_KEY_PEPPER`, `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_ACCOUNT_KEY` have no descriptor | Add descriptors so these are governed like every other secret | P1 |

### D. Data Layer — HA & Backup/DR (Postgres, MinIO, Temporal)

| # | Item | Status | Finding | Action | Priority |
|---|---|---|---|---|---|
| D1 | Postgres HA topology | ⚠️ Real but unconfirmed as prod's backing | Patroni+etcd+HAProxy+Keepalived+PgBouncer+pgBackRest is fully documented with real configs, but only under `docs/research/` — explicitly a homelab/Proxmox track, manual SSH steps, no Terraform/Ansible IaC | Confirm with whoever owns the production cluster that THIS is what backs ArcaAI production — do not assume day-1 traffic hits a single-node Postgres | **P0** |
| D2 | Postgres restore drill | ❌ Never tested | Retention policy is configured (`full=2`, `diff=7`) but restore is "documented procedure only" | Run one real restore drill before day-1 — an untested backup is not a backup | **P0** |
| D3 | MinIO object-data backup | ❌ Absent | Backup automation covers only `.minio.sys` metadata; actual PHI recordings/attachments have **no backup path documented at all** | This is the scariest gap on this list for a healthcare platform — add bucket replication/versioning or an object-level backup job before go-live | **P0** |
| D4 | MinIO HA topology | ⚠️ Unconfirmed | The only in-repo MinIO deployment doc describes a single node (VM 402) | Confirm production object storage isn't a single point of failure; upgrade to distributed MinIO if it is | **P0** |
| D5 | Temporal backup/retention | ❌ Absent | No persistence-store backup story found anywhere; Temporal isn't even in the main dev compose | Lower urgency than PHI data, but confirm this assumption with the team | P1 |

### E. Networking, Ingress, TLS

| # | Item | Status | Finding | Action | Priority |
|---|---|---|---|---|---|
| E1 | TLS termination, ingress class, DNS/hostname routing | ❓ Cannot audit | Would live in the deleted k3s tree or `hope-deployments` | Confirm these are correctly configured for ArcaAI's production hostname wherever the live manifests now live | **P0** |

### F. Scaling & Resilience

| # | Item | Status | Finding | Action | Priority |
|---|---|---|---|---|---|
| F1 | Resource requests/limits, PDBs, HPAs | ❓ Cannot audit | Deleted with the k3s tree; nothing in-repo to inspect | Verify these exist in `hope-deployments`'s manifests | P1 |
| F2 | Liveness/readiness probe paths — **landmine** | ⚠️ Likely wrong if copied literally | The only surviving example probe manifest (`deployment/vault-agent/reference-deployment.yaml`) hardcodes `/api/health/live` and `/api/health/ready` — paths that only resolve for **guardrail** (it double-mounts at both `/api` and `/api/v1`). Every other service (api, smr, nlp, harness, tts, stt) only serves health at `/api/v1/health(...)`. The file's own instruction says "copy this shape per service — nothing else changes," which would silently break probes for 6 of 7 services if followed literally | Verify the *actual* probe paths in `hope-deployments`'s manifests per service — do not trust the vault-agent reference file as-is | **P0** |

### G. Observability

| # | Item | Status | Finding | Action | Priority |
|---|---|---|---|---|---|
| G1 | App-service metrics (ServiceMonitor/PrometheusRule) | ❌ Absent for apps | Only Vault has monitoring wired in k3s; Prometheus/Grafana for app services are dev-compose-only profiles | Wire at least API + STT + SMR dashboards before go-live — they're the request-critical path | P1 |
| G2 | Alert routing | ❌ Absent | No Alertmanager route/receiver config anywhere (no Slack/PagerDuty) — even Vault's alerts have nowhere to go | Wire at least one working alert route — an unrouted alert is a silent alert | **P0** |
| G3 | Log aggregation | ⚠️ Built but off | `LoggingService`'s Loki transport exists in code but ships `LOKI_ENABLED=false` in `.env.prod`; no Loki/Promtail/Vector deployment exists in-repo; Python services log structured JSON to stdout assuming an undefined cluster log agent | Confirm whatever log capture the cluster has actually retains stdout; flip `LOKI_ENABLED=true` if a Loki instance exists | P1 |

### H. Rollback & Promotion Path

Covered in B6/B7 above — consolidate into one written runbook and rehearse it once before day-1. **P0.**

### I. ArcaAI Tenant-Specific Day-1 Data Readiness

| # | Item | Status | Finding | Action | Priority |
|---|---|---|---|---|---|
| I1 | TASK-593 seed scope | ⚠️ In progress, reduced scope | Phase A (frontend config clone + harness override) done; Phase B deliberately scoped down from "full clone" to "one doctor per department" — Global's demo consultations/DNA/audit logs/voice profiles are NOT cloned to ArcaAI | Confirm with the ticket owner whether the reduced scope is acceptable for real day-1 users, or whether more seed data is needed | **P0** |
| I2 | Storage-endpoint bug carryover | ⚠️ Dev fixed, prod unverified | The `"http://"` platform-storage-config bug (this session) was fixed at the seed-script level; the already-broken dev DB row was left as-is per your choice. Production seeds independently | Confirm production's own `MINIO_ENDPOINT`/`S3_ENDPOINT` env var and `TenantStorageConfig` SYSTEM row are correct — do not assume the dev fix carries over | **P0** |

## 4. Prioritized Punch List (P0 items, suggested order)

1. Confirm `hope-deployments` has complete, current manifests for every workload (A1).
2. Add a `deploy-production` CI job with its own environment + approval gate (B1).
3. Protect `dev`/`staging` branches in GitLab so Vault OIDC ref-scoping is real (C4).
4. Re-enable `scan-gitleaks` (B2).
5. Verify per-service liveness/readiness probe paths in the live manifests — do not copy the vault-agent reference literally (F2).
6. Confirm TLS/ingress/DNS for ArcaAI's production hostname (E1).
7. Confirm what Postgres/MinIO topology actually backs production, and that neither is single-node (D1, D4).
8. Run one real Postgres restore drill (D2).
9. Close the MinIO object-data backup gap — PHI recordings currently have none (D3). **⚠️ Designed 2026-08-08 (TASK-622 C.5) — build Tier 1, Tier 2 DEFERRED pending owner sign-off. Design: [`docs/operations/storage/minio-phi-backup.md`](../../operations/storage/minio-phi-backup.md).** Live read-only audit corrects this row's premise in three ways: (a) the backup situation is *worse* than "metadata only" — the `.minio.sys` script from the MinIO deploy doc §13 was **never installed**, so there is no backup of any kind, and no versioning, replication, SSE, object lock, LUKS, or Proxmox vzdump job either; (b) the PHI surface is only **~18.6 GB** — 87% of the 209 GB store is a reproducible `gitlab-registry`, which makes every remediation option affordable; (c) the app's MinIO credential is **root-equivalent** (`hope-v2-dev` svcacct, `ParentUser: minioadmin`, `Policy: implied`), so an app bug or leaked k8s Secret can erase the PHI objects **and** the pgBackRest repo **and** the Vault seal backup — all three live on this same single host. **Tier 1** (nightly `age`-encrypted archives to an off-MinIO destination on `pve-node1`, read-only-scoped credential mirroring `vault-backup-svc`, tested restore) is specified and ready to execute. **Tier 2** (off-site) is deferred because it needs a signed BAA or an off-site drive-rotation commitment — an owner decision, not a cost problem (<$2/month). **Risk accepted during the deferral: loss of the Proxmox host destroys every clinical recording, every attachment, the Postgres backup, and the Vault seal backup simultaneously, with no recovery possible.** Owner sign-off block and Tier-2 decision date: design doc §11; eight owner-only open questions (incl. *is any of this real patient data yet?*): §12.
10. Populate real Vault-backed storage credentials, or explicitly accept env-tier with a fast-follow date (C5).
11. Complete Vault's own pre-cutover checklist, including a Raft snapshot CronJob (C2, C3).
12. Wire at least one Alertmanager route so day-1 incidents actually page someone (G2).
13. Confirm production's `TenantStorageConfig`/`MINIO_ENDPOINT` doesn't carry the same empty-string bug (I2).
14. Resolve ArcaAI's TASK-593 seed-scope question with its owner (I1).
15. Write and rehearse the manual rollback runbook once (B7/H).

## 5. Implementation Summary

This is a living checklist, not a one-time report. Update each row's Status as the gap closes, and spin off a dedicated ticket for any workstream that turns out to be non-trivial (e.g., "wire ArgoCD PostSync smoke tests," "MinIO object-data backup"). Nothing in this document required a code change except where noted (the seed-script fix landed in the prior session, see `05c-platform-storage-config.ts`).

## 6. Change History

- **2026-07-31**: Initial creation, based on a 3-lane gap audit (GitOps/k3s/ArgoCD/Rancher topology; CI/CD pipeline; secrets/backup/observability) plus a review of open items in TASK-577–581, TASK-582–585, TASK-536–539, and TASK-593.
