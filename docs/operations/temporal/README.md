# Temporal — operator runbook (backup/restore, daily ops)

Backup/restore and daily operational checks for the durable-workflow substrate
`HarnessDocWorkflow` (and future Temporal workflows) run on. This is explicitly an ops runbook,
never a console CRUD screen or admin UI feature. The hosting decision is made and live: Temporal
runs self-hosted in the k3s cluster (`hope-v2-dev`), and `hope-harness`/`hope-harness-worker`
connect to it at `hope-temporal:7233` (`arca/hope-v2-deployment`'s `deployment/k8s/base/config/harness.env`)
— not the unmanaged VM instance this runbook originally described as the live path.

## Layout

This directory holds only this file.

## How it works

### Local dev (Docker Compose `temporal` profile)

```
docker-compose.dev.yml (`temporal` profile)
  temporal-admin-tools     -> schema setup, one-shot (temporalio/admin-tools, default 1.31.2)
  temporal                 -> temporalio/server, default 1.31.2, shares hope-postgres
                              (databases: temporal, temporal_visibility)
  temporal-create-namespace -> idempotent `default` namespace bootstrap
  temporal-ui              -> temporalio/ui, default 2.53.1
```

Local dev is disposable by design (`pnpm infra:dev:up` with `-v` recreates it from empty) — this
runbook's backup/restore procedures do not apply to it. `scripts/temporal-volume-hop.sh` is the
only local-dev Temporal runbook that matters, and it is a version-upgrade procedure, not a backup
one.

### In-cluster (self-hosted, live)

```
arca/hope-v2-deployment: deployment/k8s/base/temporal.yaml
  hope-temporal     Deployment (temporalio/auto-setup:1.25.1) + Service (7233 grpc, 8233 http, 9090 metrics)
  hope-temporal-ui  Deployment (temporalio/ui:2.34.0) + Service (8080 http)
  Persistence: the SAME in-cluster Postgres server the app database uses — one Postgres server,
    four logical databases (hope, temporal, temporal_visibility, mlflow); see
    .claude/rules/09-infrastructure-devops.md "Cluster Deploys"
  Postgres creds: hope-secrets -> TEMPORAL_DB_HOST / TEMPORAL_DB_USER / TEMPORAL_DB_PASSWORD
```

Temporal's durable state lives entirely in the `temporal` and `temporal_visibility` databases on
that shared Postgres instance — there is no separate Temporal-native backup mechanism to learn,
and no separate external Postgres HA cluster in the picture: back up that Postgres server
correctly and Temporal's state is backed up. This repo does not yet document that server's own
backup/restore procedure (there is no Postgres-specific runbook under
[`../storage/`](../storage/), only [`../storage/minio-phi-backup.md`](../storage/minio-phi-backup.md))
— confirm what exists before assuming the fallback procedure below is unnecessary.

## Commands

### Backup (fallback procedure — confirm the platform Postgres backup story first)

```bash
# Logical backup of both Temporal databases (custom format, restorable independently of the
# app `hope`/`vox` database on the same server — do not conflate the three; a Temporal-only
# restore must not touch application data).
pg_dump --format=custom --no-owner --no-privileges \
  --dbname="$TEMPORAL_DB_HOST" --username="$TEMPORAL_DB_USER" temporal \
  --file=/backup/temporal-$(date +%Y%m%d%H%M).dump
pg_dump --format=custom --no-owner --no-privileges \
  --dbname="$TEMPORAL_DB_HOST" --username="$TEMPORAL_DB_USER" temporal_visibility \
  --file=/backup/temporal-visibility-$(date +%Y%m%d%H%M).dump

# Verify the dump restores into a scratch database before trusting it.
createdb temporal_restore_check
pg_restore --dbname=temporal_restore_check /backup/temporal-$(date +%Y%m%d%H%M).dump
dropdb temporal_restore_check
```

### Restore

```bash
# 1. Confirm the target Postgres instance is the one hope-temporal's Deployment env
#    (TEMPORAL_DB_HOST/TEMPORAL_DB_USER/TEMPORAL_DB_PASSWORD, from hope-secrets) actually points
#    at — restoring into the wrong instance silently orphans the live Deployment.

# 2. Stop hope-temporal and hope-harness-worker before restoring (a worker actively polling the
#    task queue during a restore can observe a half-restored visibility store and misbehave).
kubectl -n hope-v2-dev scale deployment hope-temporal --replicas=0
kubectl -n hope-v2-dev scale deployment hope-harness-worker --replicas=0

# 3. Restore both databases from the chosen backup.
pg_restore --clean --if-exists --dbname=temporal /backup/temporal-<timestamp>.dump
pg_restore --clean --if-exists --dbname=temporal_visibility /backup/temporal-visibility-<timestamp>.dump

# 4. Bring hope-temporal back first, confirm health, THEN hope-harness-worker.
kubectl -n hope-v2-dev scale deployment hope-temporal --replicas=1
# ... health check below ...
kubectl -n hope-v2-dev scale deployment hope-harness-worker --replicas=1
```

**This procedure is authored, not drilled.** No restore rehearsal has been run against a real
backup. Treat it as a starting point to validate on the next scheduled DR drill, not a tested
runbook.

### Daily ops / health checks

`hope-harness` (FastAPI) and `hope-harness-worker` (the Temporal worker, a separate process per
`.claude/rules/06-python-services.md` the Temporal section) report on Temporal reachability differently by
design — do not conflate the two:

```bash
# 1. Harness FastAPI's own view — best-effort connect, comes up even if Temporal is down
#    (apps/harness/src/harness/main.py, lifespan). A "harness.temporal_unavailable" log line here
#    is a symptom, not a crash.
kubectl -n hope-v2-dev logs deploy/hope-harness --tail=50 | grep -i temporal

# 2. Worker health — hard-requires Temporal. Heartbeat-file liveness probe
#    (arca/hope-v2-deployment's base/harness-worker.yaml).
kubectl -n hope-v2-dev get pod -l app=hope-harness-worker

# 3. Temporal server reachability: cross-reference the local-dev Grafana dashboard
#    (infrastructure/grafana/dashboards/harness-temporal.json) and the local Prometheus rules
#    (infrastructure/docker/configs/prometheus/rules/harness-temporal.rules.yml). In-cluster, the
#    `TemporalDown` alert (arca/hope-v2-deployment's base/alert-rules.yaml, `up{job="temporal"} == 0`)
#    now watches the connected instance, since harness points at hope-temporal:7233 — but see the
#    observability README's gotcha on Alertmanager receivers before expecting this to page anyone.

# 4. Duplicate-execution / 5xx / latency report — scripts/harness-availability-report.py.
#    Requires a reachable Temporal server.
~/miniconda3/envs/arcaenv/bin/python scripts/harness-availability-report.py --address <TEMPORAL_ADDRESS> --since-days 30
```

## Gotchas

- **No CI job runs any part of this runbook.** No `.gitlab/ci/*.yml` job invokes
  `pg_dump`/`pg_restore`/a Temporal backup step — this is a manual, operator-run procedure,
  deliberately not automated into CI. If a scheduled backup job is added (e.g. a Kubernetes
  `CronJob` running the `pg_dump` steps above on a schedule), record it here and in
  `arca/hope-v2-deployment`'s own manifest tree.
- **Workflow history retention** (how long a completed workflow's history stays queryable in
  Temporal itself, independent of any Postgres-level backup) is namespace-scoped and not
  documented as configured here — record the chosen retention period once it is set in the
  deployment repo's namespace-creation step.
- **A Temporal-only restore must not touch the app `hope`/`vox` database** even though all three
  databases now share one Postgres server — restore `temporal`/`temporal_visibility` by name, not
  by pointing a whole-instance restore at the server.

## Related

- [`../../../.claude/rules/06-python-services.md`](../../../.claude/rules/06-python-services.md) — Temporal workflow/activity rules, replay compatibility
- [`../../../.claude/rules/09-infrastructure-devops.md`](../../../.claude/rules/09-infrastructure-devops.md) — the shared in-cluster Postgres server and cluster topology
- [`../observability/README.md`](../observability/README.md) — alert rules (including `TemporalDown`) and why they don't yet page anyone
- [`../storage/minio-phi-backup.md`](../storage/minio-phi-backup.md) — the platform's other durable-store backup runbook, for retention-policy comparison
