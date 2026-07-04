# PgBouncer Cutover & Rollback Runbook

| Field | Value |
|---|---|
| Ticket | TASK-302 Stream C — Phase 3 preparation |
| Audience | DBA + on-call SRE |
| Status | Ready (cutover **not yet executed**) |
| Last updated | 2026-05-24 |
| Reference plan | [`03-pgbouncer-rollout.md`](./03-pgbouncer-rollout.md) §3 |
| Reference validation | [`03-pgbouncer-validation-report.md`](./03-pgbouncer-validation-report.md) (Phase 1: PASS) |

> **Why this exists**: this stream (Phase 2A) lands the configuration
> and code changes that switch HOPE to PgBouncer transaction mode. It
> deliberately stops at the deploy boundary. This runbook is the
> hand-off — every step required to actually cut staging then production
> over, validate, and (if needed) roll back.

---

## 0. Pre-flight checklist (before any cutover)

Run through these once per environment (staging, then prod):

- [ ] Phase 1 validation report says **PASS** for transaction mode.
- [ ] HA blueprint §10 reflects the validated config (image tag
      `edoburu/pgbouncer:v1.25.1-p0`, `MAX_PREPARED_STATEMENTS=200`,
      `SERVER_RESET_QUERY_ALWAYS=1`, etc.).
- [ ] `userlist.txt` exists on every PG node and contains:
        - `hope_app` (app user)
        - `hope_admin` (pgbouncer admin user; in `admin_users`)
        - `hope_metrics` (in `stats_users`; for `pgbouncer-exporter`)
      → secret material lives in `/etc/pgbouncer/userlist.txt`,
        mode `0640`, owned by `pgbouncer:pgbouncer`.
      → the example `userlist.txt.example` shipped with the
        HA bundle is for reference only; do **not** commit the real file.
- [ ] PG `pg_hba.conf` allows `hope_app` to connect from the pgbouncer
      host on `scram-sha-256` over TLS.
- [ ] Prometheus is scraping `pgbouncer-exporter` (Grafana shows the
      "PgBouncer — HOPE Production" dashboard with live data).
- [ ] On-call SRE acknowledged the maintenance window.

---

## 1. Staging cutover (Task 3A.1)

```zsh
# 1. Set secrets on every staging API host (or in your secret manager):
export DATABASE_URL='postgresql://hope_app:****@10.10.1.250:6432/hope?sslmode=require&schema=core'
export DIRECT_URL='postgresql://hope_app:****@10.10.1.250:5000/hope?sslmode=require&schema=core'
export PRISMA_PG_MAX=5

# 2. Bring up pgbouncer + monitoring on every HA node:
for host in db0-staging db1-staging db2-staging; do
  ssh "$host" 'cd ~/postgres-ha && docker compose --profile pgbouncer --profile monitoring up -d'
done

# 3. Verify pool stats on each node:
for host in db0-staging db1-staging db2-staging; do
  PGPASSWORD="$ADMIN_PG_PASSWORD" psql \
    "host=$host port=6432 user=hope_admin dbname=pgbouncer sslmode=require" \
    -c 'SHOW POOLS;'
done

# 4. Rolling-restart API pods (one at a time; wait for /health between).

# 5. Smoke-test:
POOLED_HOST=10.10.1.250 \
ADMIN_PG_PASSWORD="$ADMIN_PG_PASSWORD" \
APP_PG_PASSWORD="$APP_PG_PASSWORD" \
./scripts/smoke-pgbouncer.sh
```

**Done when**: smoke script exits 0 and `SHOW POOLS` shows
`pool_mode=transaction`, `cl_waiting=0`, `maxwait=0` on every node.

---

## 2. 7-day staging soak (Task 3A.2)

Daily, capture and log:

```zsh
# SHOW POOLS snapshot
PGPASSWORD="$ADMIN_PG_PASSWORD" psql \
  "host=10.10.1.250 port=6432 user=hope_admin dbname=pgbouncer sslmode=require" \
  -c 'SHOW POOLS;'  | tee -a docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-soak-log.md

# Grafana p95 query latency vs pre-cutover baseline
# (PromQL: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])))

# Error log scan (last 24 h) for the three blocker patterns:
grep -E 'prepared statement does not exist|sorry, too many clients|P1017' \
  /var/log/api-gateway/*.log
```

**Acceptance rubric** (must hold for 7 consecutive days):

| Metric | Threshold |
|---|---|
| `prepared statement does not exist` count | **0** |
| `sorry, too many clients` count | **0** |
| Prisma `P1017` (connection lost) count | **0** |
| API p95 latency vs pre-cutover baseline | ≤ +15 % |
| `cl_waiting` peak per day | < 5 for ≤ 1 minute total |

If any acceptance criterion fails: investigate root cause; do not
proceed to production. Document in the soak log.

---

## 3. Pre-warm + rolling restart (Tasks 3B.1, 3B.2)

### 3.1 Pre-warm pools

```zsh
for n in pg-node1 pg-node2 pg-node3; do
  PGPASSWORD="$ADMIN_PG_PASSWORD" psql \
    "host=$n port=6432 user=hope_admin dbname=pgbouncer sslmode=require" \
    -c 'RELOAD;'
done

# Verify sv_idle ≥ min_pool_size (5):
for n in pg-node1 pg-node2 pg-node3; do
  PGPASSWORD="$ADMIN_PG_PASSWORD" psql \
    "host=$n port=6432 user=hope_admin dbname=pgbouncer sslmode=require" \
    -At -c "SELECT pool_mode, sv_idle FROM pgbouncer.pools WHERE database='hope';"
done
```

### 3.2 Rolling restart of API pods

For each pod (one at a time):

```zsh
# 1. Drain (LB de-register / Kubernetes cordon).
# 2. Restart the API process (docker compose restart, systemctl, kubectl rollout, etc.).
# 3. Wait for the readiness probe (~30 s).
# 4. Verify the new pod is using the pooler:
PGPASSWORD="$ADMIN_PG_PASSWORD" psql \
  "host=10.10.1.250 port=6432 user=hope_admin dbname=pgbouncer sslmode=require" \
  -c 'SHOW CLIENTS;' | grep -F "<pod_ip>"
# 5. Re-register with LB.
```

**Done when**: `SHOW POOLS` shows `sv_active` rising as traffic
gradually shifts to the new pods.

---

## 4. Rollback (Task 3C.1)

PgBouncer cutover is **config-only** — no schema change, no migration.
The rollback is the inverse environment change. Per Phase 1 §8.2,
expected rollback time is **≤ 5 minutes** for a rolling restart.

### 4.1 Trigger conditions

Roll back **immediately** if any of the following fire during cutover
or the first 24 h post-cutover:

- `PgBouncerMaxWaitHigh` alert: client wait > 1 s sustained
- API error budget for `P1017` exceeded
- Schema corruption detected (`_prisma_migrations` shows duplicate
  rows or out-of-order applied versions)
- Connection refusals from PG > 1 % of attempts

### 4.2 Procedure

```zsh
# 1. Flip DATABASE_URL back to the HAProxy R/W direct endpoint:
export DATABASE_URL='postgresql://hope_app:****@10.10.1.250:5000/hope?sslmode=require&schema=core'
# DIRECT_URL stays the same (it was already direct).

# 2. Rolling-restart API pods.

# 3. Confirm via SHOW CLIENTS that no traffic remains on the pooler:
PGPASSWORD="$ADMIN_PG_PASSWORD" psql \
  "host=10.10.1.250 port=6432 user=hope_admin dbname=pgbouncer sslmode=require" \
  -c 'SHOW CLIENTS;'   # expect ≤ pgbouncer-exporter only

# 4. PgBouncer can keep running (it's idle now) or be stopped:
for host in db0 db1 db2; do
  ssh "$host" 'docker compose -p postgres-ha stop pgbouncer'
done

# 5. Run smoke against the direct path:
POOLED_HOST=10.10.1.250 POOLED_PORT=5000 ADMIN_PG_PASSWORD=... APP_PG_PASSWORD=... \
  ./scripts/smoke-pgbouncer.sh   # step 2 (SHOW POOLS) will fail loudly — that is expected on rollback
```

### 4.3 Mandatory rollback rehearsal

Before the **production** cutover, execute steps 4.2.1 → 4.2.3 in
**staging** as a dry run. Document the result in the soak log:

```markdown
## YYYY-MM-DD — Rollback rehearsal (staging)

- Trigger: dry run (no real incident)
- Steps executed: 4.2.1, 4.2.2, 4.2.3
- Time-to-rollback: <elapsed>
- API smoke after rollback: PASS / FAIL
- Re-cut to pooled state: <elapsed>
- Notes: …
```

---

## 5. Production cutover (Task 3D)

> ⛔ **STOP** — orchestrator coordinates the actual production deploy.
> Stream C delivers the artefacts and rehearses the runbook; it does
> not push to prod.

When the orchestrator schedules the window:

1. Announce in `#engineering` 48 h ahead (template in plan §3D.1).
2. Execute steps 3.1 → 3.2 (pre-warm + rolling restart) against prod.
3. Run `scripts/smoke-pgbouncer.sh` with prod credentials.
4. Spot-check Grafana for 30 min post-cutover.
5. 24 h soak with hourly Grafana checks; page-out on the alert rules
   from §2A.5.3.
6. Sign-off: append a line to plan §"Change History" with DBA + SRE
   names, date, and any deviations.

---

## 6. Appendix — Quick-reference commands

| Goal | Command |
|---|---|
| Pool-mode + per-pool counts | `psql -h <host> -p 6432 -U hope_admin pgbouncer -c 'SHOW POOLS;'` |
| Cumulative stats since start | `psql -h <host> -p 6432 -U hope_admin pgbouncer -c 'SHOW STATS;'` |
| Currently connected clients | `psql -h <host> -p 6432 -U hope_admin pgbouncer -c 'SHOW CLIENTS;'` |
| Server backends + their last SQL | `psql -h <host> -p 6432 -U hope_admin pgbouncer -c 'SHOW SERVERS;'` |
| Reload pgbouncer config (no restart) | `psql -h <host> -p 6432 -U hope_admin pgbouncer -c 'RELOAD;'` |
| Pause/resume (graceful drain) | `PAUSE;` … `RESUME;` |
| Per-pod current pool size | `SHOW STATS;` then `total_xact_count / N_pods` |
