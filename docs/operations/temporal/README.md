# HOPE Temporal — Operator Runbook (DR/backup) — TASK-730 Task 6

| | |
|---|---|
| **Status** | **DRAFT — forked on an unmade decision.** `temporal-hosting-decision.md` (TASK-730 Task 1) has not been signed off. This runbook is structured as two paths so both are ready the moment that decision lands; sections that genuinely don't depend on the choice are written once. |
| **Scope** | Backup/restore + daily operational checks for the durable-workflow substrate `HarnessDocWorkflow` (and future Temporal workflows) run on. **Explicitly an ops runbook, never a console CRUD screen or admin UI feature** — design.md's YAGNI ledger: *"DR/backup as console CRUD (ops tooling + at most a read-only status page)."* |
| **Modeled on** | `docs/operations/vault/README.md`'s section shape (architecture / bootstrap / privileged commands / daily ops / rotation-or-backup / CI integration) |
| **Depends on** | `docs/implementation/TASK-730-Harness-Infra-Productionization/temporal-hosting-decision.md` — read that first; it decides which half of this document is load-bearing |

---

## 1. Architecture at a glance

**Current production state (verified 2026-08-16, `arca/hope-v2-deployment` @ `bb2f96f4c`):**
neither path below is what's actually running today. `hope-harness`/`hope-harness-worker` connect
to a Temporal server on an unmanaged VM (`TEMPORAL_ADDRESS=10.10.1.10:7233`), which has:

- No documented backup procedure anywhere in this repo or the deployment repo.
- No monitoring — the deployment repo's `TemporalDown` alert scrapes `hope-temporal:9090` (an
  in-cluster Deployment that exists but that harness does not talk to), not the VM.
- No HA.

**This document exists to close that gap by describing what the target state looks like once
Task 1's decision is made — it does not claim the current VM instance is backed up, because it
is not.**

### 1.1 Local dev (unaffected by the Task 1 decision)

```
docker-compose.dev.yml (`temporal` profile)
  temporal-admin-tools  → schema setup, one-shot (temporalio/admin-tools:1.31.2)
  temporal               → temporalio/server:1.31.2, shares hope-postgres
                            (databases: temporal, temporal_visibility)
  temporal-create-namespace → idempotent `default` namespace bootstrap
  temporal-ui            → temporalio/ui:2.34.0
```

Local dev is disposable by design (`pnpm infra:dev:up` with `-v` recreates it from empty) — this
runbook's backup/restore procedures do not apply to it. `scripts/temporal-volume-hop.sh`
(TASK-702) is the only local-dev Temporal runbook that matters, and it's a version-upgrade
procedure, not a backup one.

### 1.2 Option A — self-hosted in k3s (if Task 1 chooses this)

```
arca/hope-v2-deployment: deployment/k8s/base/temporal.yaml
  hope-temporal     Deployment (temporalio/auto-setup:1.25.1) + Service (7233 grpc, 8233 http, 9090 metrics)
  hope-temporal-ui  Deployment (temporalio/ui:2.34.0) + Service (8080 http)
  Persistence: hope-postgres (same instance the app DB uses), databases `temporal` + `temporal_visibility`
  Postgres creds: hope-secrets → TEMPORAL_DB_HOST / TEMPORAL_DB_USER / TEMPORAL_DB_PASSWORD
```

This manifest already exists in the deployment repo (deployed, currently disconnected from
harness — see `temporal-hosting-decision.md` §2.1). Choosing Option A means harness's
`TEMPORAL_ADDRESS` moves from the VM to `hope-temporal:7233`, and this section's procedures become
load-bearing for production.

**Open item, unresolved by this ticket:** whether the platform's existing Postgres HA/backup story
(Patroni-managed TimescaleDB HA on VMs `10.10.1.200-202`, per `observability-config.yaml`'s
`patroni` scrape job) already covers Temporal's two databases, or whether they need their own
procedure. §2 below assumes the latter (worst case) until someone confirms otherwise — do not
assume coverage exists without checking `docs/operations/storage/` (currently only
`minio-phi-backup.md`, no Postgres-specific runbook) and the platform Postgres's own ops docs,
which this ticket did not have in its required-reading scope.

### 1.3 Option B — Temporal Cloud (if Task 1 chooses this)

No in-cluster Temporal Deployment at all. `hope-harness`/`hope-harness-worker` connect to a
Temporal Cloud namespace over mTLS. Persistence, HA, and Temporal's own backup/DR are Temporal,
Inc.'s responsibility under their SLA — this repo's operational surface shrinks to credential
rotation and namespace configuration (§2.2/§3.2 below).

---

## 2. Backup procedure

### 2.1 Local dev

Not backed up. Disposable. If you need a durable local snapshot for debugging, the raw mechanism
is a `pg_dump` of the `temporal`/`temporal_visibility` databases inside the `hope-postgres`
container (same technique as §2.2's Postgres steps, pointed at `localhost:5432`) — this is a
manual, ad hoc convenience, not a procedure this runbook maintains.

### 2.2 Option A — self-hosted (Postgres-backed)

Temporal's durable state lives entirely in two Postgres databases (`temporal`, `temporal_visibility`)
inside `hope-postgres` — there is no separate Temporal-native backup mechanism to learn; back up
Postgres correctly and Temporal's state is backed up.

```bash
# Prerequisite: confirm which Postgres backup story already covers this instance before assuming
# none exists — see §1.2's open item. The steps below are the FALLBACK if nothing does.

# 1. Logical backup of both Temporal databases (custom format, restorable independently of the
#    app `hope`/`vox` database — do not conflate the three; a Temporal-only restore must not touch
#    application data).
pg_dump --format=custom --no-owner --no-privileges \
  --dbname="$TEMPORAL_DB_HOST" --username="$TEMPORAL_DB_USER" temporal \
  --file=/backup/temporal-$(date +%Y%m%d%H%M).dump
pg_dump --format=custom --no-owner --no-privileges \
  --dbname="$TEMPORAL_DB_HOST" --username="$TEMPORAL_DB_USER" temporal_visibility \
  --file=/backup/temporal-visibility-$(date +%Y%m%d%H%M).dump

# 2. Verify the dump restores into a scratch database before trusting it (same discipline as
#    packages/database's own migration-baselining procedure, `.claude/rules/02-database-prisma.md`).
createdb temporal_restore_check
pg_restore --dbname=temporal_restore_check /backup/temporal-$(date +%Y%m%d%H%M).dump
dropdb temporal_restore_check
```

**Retention.** Not decided by this document — align with whatever the platform Postgres backup
retention already is (§1.2's open item), or, if none exists, a starting default of daily dumps
retained 14 days + weekly dumps retained 90 days is a reasonable floor consistent with
`docs/operations/storage/minio-phi-backup.md`'s retention posture for the platform's other
durable stores — **confirm this against that document's actual numbers before treating it as
policy**, this runbook does not re-derive them.

**Workflow history retention (separate from backup).** Temporal's own retention period (how long
a COMPLETED workflow's history stays queryable before Temporal itself deletes it, independent of
any Postgres-level backup) is namespace-scoped and defaults to Temporal's own default if never
set explicitly. This is a namespace-configuration concern, not a backup concern — record the
chosen retention period here once Task 2 sets it in the deployment repo's namespace-creation step.
**Not yet configured/verified as of this document's authoring.**

### 2.3 Option B — Temporal Cloud

No self-managed backup — Temporal, Inc. owns persistence/DR under their SLA. What HOPE still owns:

- **Export/audit procedure**: periodically export completed-workflow history for the
  clinical-documentation audit trail, if that is a compliance requirement independent of
  Temporal Cloud's own retention (Temporal Cloud namespaces have a configurable retention period,
  same concept as §2.2's namespace retention above, but enforced by the vendor).
- **Credential rotation**: the mTLS client certificate `hope-harness`/`hope-harness-worker` use to
  authenticate to the Temporal Cloud namespace — rotation cadence and procedure follow whatever
  HOPE's existing certificate-rotation practice is (no existing precedent in this repo to point to
  — Vault's `docs/operations/vault/README.md` §Secret rotation covers *application* secrets, not
  mTLS client certs for an external SaaS; this is a genuinely new rotation surface Option B
  introduces).
- **Vendor SLA reference**: record Temporal Cloud's published availability/DR SLA here once a
  namespace exists, so an on-call engineer has one place to check "is this an incident we can fix,
  or one we wait on the vendor for."

---

## 3. Restore procedure

### 3.1 Option A — self-hosted

```bash
# 1. Confirm the target Postgres instance is the one hope-temporal's Deployment env
#    (TEMPORAL_DB_HOST/TEMPORAL_DB_USER/TEMPORAL_DB_PASSWORD, from hope-secrets) actually points at
#    — restoring into the wrong instance silently orphans the live Deployment.

# 2. Stop hope-temporal and hope-harness-worker before restoring (a worker actively polling the
#    task queue during a restore can observe a half-restored visibility store and misbehave —
#    Temporal's own operational guidance for a persistence-store restore is to stop consumers
#    first; this is not unique to HOPE's setup).
kubectl -n hope-v2-<env> scale deployment hope-temporal --replicas=0
kubectl -n hope-v2-<env> scale deployment hope-harness-worker --replicas=0

# 3. Restore both databases from the chosen backup.
pg_restore --clean --if-exists --dbname=temporal /backup/temporal-<timestamp>.dump
pg_restore --clean --if-exists --dbname=temporal_visibility /backup/temporal-visibility-<timestamp>.dump

# 4. Bring hope-temporal back first, confirm health (§4), THEN hope-harness-worker.
kubectl -n hope-v2-<env> scale deployment hope-temporal --replicas=1
# ... health check (§4) ...
kubectl -n hope-v2-<env> scale deployment hope-harness-worker --replicas=1
```

**Known gap this ticket does not close:** this procedure is authored, not drilled. No restore
rehearsal has been run against a real backup (local infra was down for the whole of this ticket's
execution session, and there is no cluster access from it either). Treat this as a starting
procedure to validate on the next scheduled DR drill, not as a tested runbook — see the same
caveat the vault README carries for its own emergency procedures.

### 3.2 Option B — Temporal Cloud

Restore is a Temporal Cloud support/SLA action, not a HOPE-operated procedure — engage Temporal,
Inc. support per their documented incident process. HOPE's side of a Temporal Cloud incident is
limited to: confirming the mTLS credential is still valid (§2.3), and communicating impact
(harness FastAPI stays up per its best-effort-connect design, §4; the worker cannot process new
documentation workflows for the duration).

---

## 4. Daily ops / health checks

Applies to whichever option is live. Both `hope-harness` (FastAPI) and `hope-harness-worker`
(the Temporal worker, a separate process per `.claude/rules/06-python-services.md` §Temporal)
report on Temporal reachability differently by design — do not conflate the two:

```bash
# 1. Harness FastAPI's own view — best-effort connect, comes up even if Temporal is down
#    (apps/harness/src/harness/main.py:28-56 lifespan). A "temporal_unavailable" log line here is
#    a symptom, not a crash.
kubectl -n hope-v2-<env> logs deploy/hope-harness --tail=50 | grep -i temporal

# 2. Worker health — hard-requires Temporal. Heartbeat-file liveness probe
#    (arca/hope-v2-deployment's base/harness-worker.yaml): a wedged worker ages the heartbeat file
#    out and fails its own livenessProbe within ~45-60s (three consecutive 15s misses).
kubectl -n hope-v2-<env> get pod -l app=hope-harness-worker

# 3. Temporal server reachability from the harness side, TODAY, is only knowable indirectly (no
#    dedicated /health endpoint check documented here yet) — cross-reference the Grafana dashboard
#    from TASK-730 Task 5 (infrastructure/grafana/dashboards/harness-temporal.json, local dev; a
#    cluster-side equivalent is a Task 5 follow-on, not built by this ticket) and the
#    HarnessTemporalDown / HarnessWorkerTaskFailures alert rules
#    (infrastructure/docker/configs/prometheus/rules/harness-temporal.rules.yml, local; the
#    cluster-side TemporalDown rule already exists in arca/hope-v2-deployment's
#    base/alert-rules.yaml but currently watches the WRONG Temporal instance — see
#    temporal-hosting-decision.md and this ticket's README.md §2.10 finding 5 before trusting it).

# 4. Duplicate-execution / 5xx / latency report (the assessment's three decisive availability
#    signals) — scripts/harness-availability-report.py. Requires a reachable Temporal server;
#    was NOT run during this ticket's authoring session (local infra was down) — run it against a
#    real environment before using its numbers to inform the D1 mandatory-harness decision.
~/miniconda3/envs/arcaenv/bin/python scripts/harness-availability-report.py --address <TEMPORAL_ADDRESS> --since-days 30
```

---

## 5. CI integration

No CI job in this repo runs any part of this runbook today (verified: no `.gitlab/ci/*.yml` job
references `pg_dump`/`pg_restore`/Temporal backup). This is a manual/operator-run procedure, same
posture as `docs/operations/vault/README.md`'s privileged commands — deliberately not automated
into CI, consistent with `design.md`'s YAGNI ledger excluding DR/backup from becoming a console
CRUD or automated feature. If a scheduled backup job is added later (e.g. a Kubernetes `CronJob`
running §2.2's `pg_dump` steps on a schedule), record it here and in
`arca/hope-v2-deployment`'s own manifest tree — out of scope for this ticket (Task 2's territory,
itself gated on Task 1).

---

## 6. Open items carried forward (not resolved by this ticket)

- Whether the platform's existing Postgres HA/backup story already covers Temporal's two databases
  under Option A (§1.2, §2.2).
- Workflow history retention period — not yet configured/verified for either option (§2.2).
- No restore rehearsal has been run against either option (§3.1's caveat).
- Temporal Cloud's specific SLA terms, once a namespace exists under Option B (§2.3).
- A scheduled/automated backup job does not exist yet under Option A (§5) — this runbook documents
  the manual procedure only.
