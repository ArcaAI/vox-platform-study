# k6 Application-Shape Load (Task 1.15 — Optional)

This directory holds the k6 load-test script for Phase 1 Task 1.15 (the
**optional** application-shape load test that complements `pgbench`).

## Status

**Not executed in this rig run.** Justification:

* Task 1.15 is explicitly marked optional in
  [03-pgbouncer-rollout.md §1.15](../../../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md).
* The headline pgbench rubric (Task 1.14) was comfortably exceeded
  (pooled / direct = **0.999**, target ≥ 0.85).
* k6 with PostgreSQL requires the `xk6-sql` extension; the developer
  workstation that ran Phase 1 does not have a pre-built `k6` with this
  extension on `$PATH`.

If/when the orchestrator (or a follow-up ticket) wants to run this:

```zsh
# 1. Build a k6 binary with the SQL extension (once):
docker run --rm -u "$(id -u):$(id -g)" \
  -v "$PWD:/xk6" \
  grafana/xk6:latest build latest \
    --with github.com/grafana/xk6-sql@latest \
    --with github.com/grafana/xk6-sql-driver-postgres@latest \
    --output ./k6-sql

# 2. Run against the rig (rig must be `pnpm pgbv:up` first):
./k6-sql run packages/database/tests/pgbouncer-validation/k6/hope-shape.js
```

## What `hope-shape.js` simulates

A simplified HOPE-style request mix per virtual user:

| Step | Description | Frequency |
|---|---|---|
| 1 | `BEGIN; set_config('app.tenant_id', …, true); SELECT … LIMIT 20; COMMIT;` | every iteration |
| 2 | `BEGIN; UPDATE … SET resourceStatus = …; COMMIT;` | every 10th iteration |
| 3 | `BEGIN; INSERT INTO audit … ; COMMIT;` | every 5th iteration |

The script targets `DATABASE_URL` (port 6532 — the pooler) by default.

## Why pgbench is sufficient for now

The PgBouncer-specific failure modes (DISCARD ALL, prepared-statement
collision, advisory-lock survival, GUC leak) are already exhaustively
covered by the Vitest suite (Tasks 1.7 – 1.13) and the pgbench TPC-B
workload (Task 1.14). The k6 script's marginal value is realistic
HOPE-shape transaction mix, which would tighten the latency numbers
but cannot flip the GO/NO-GO verdict on its own.
