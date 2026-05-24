# PgBouncer Validation Report — TASK-302 Stream C Phase 1

| | |
|---|---|
| **Ticket** | TASK-302 — System Config Implementation Roadmap |
| **Stream** | C — PgBouncer rollout |
| **Phase** | 1 — Validation rig (GO/NO-GO gate) |
| **Plan reference** | [`03-pgbouncer-rollout.md`](./03-pgbouncer-rollout.md) §1 |
| **Branch** | `feat/task-302-stream-c` (HEAD `abf5a82` at the time of this report) |
| **Reporter** | Stream C executor (autonomous run) |
| **Date** | 2026-05-24 |
| **Verdict** | **PASS → execute Phase 2A (transaction-mode rollout)** |

---

## 1. Rig topology

| Component | Image / version | Port | Notes |
|---|---|---|---|
| PostgreSQL | `timescale/timescaledb-ha:pg18-all` (PG 18.3) | host `5532` → container `5432` | `max_connections=200`, `idle_in_transaction_session_timeout=30s`, `statement_timeout=60s`, `log_statement=all` (rig-only — used by Task 1.11) |
| PgBouncer | `edoburu/pgbouncer:v1.25.1-p0` (latest 1.25.x; the spec'd `1.25.0` tag is not published) | host `6532` → container `6432` | `pool_mode=transaction`, `default_pool_size=50`, `min_pool_size=5`, `max_client_conn=500`, `max_prepared_statements=200`, `server_reset_query='DISCARD ALL'`, `server_reset_query_always=1`, `auth_type=scram-sha-256` |
| Prisma client | `@prisma/client@7.5.0` + `@prisma/adapter-pg@7.5.0` | — | Pool size `PRISMA_PG_MAX=10`, `connectionTimeoutMillis=5_000`, `idleTimeoutMillis=300_000` (Phase 0 defaults) |

Compose: `packages/database/tests/pgbouncer-validation/docker-compose.yml`
Helpers: `packages/database/tests/pgbouncer-validation/_helpers/clients.ts`
README:  `packages/database/tests/pgbouncer-validation/README.md`

---

## 2. Configuration evidence

```text
$ pnpm pgbv:show:config | grep -E 'pool_mode|max_prepared_statements|server_reset_query|default_pool_size|min_pool_size|max_client_conn|ignore_startup_parameters|auth_type|admin_users|stats_users'
admin_users                      = hope_app
auth_type                        = scram-sha-256
default_pool_size                = 50
ignore_startup_parameters        = extra_float_digits,search_path
max_client_conn                  = 500
max_prepared_statements          = 200
min_pool_size                    = 5
pool_mode                        = transaction
server_reset_query               = DISCARD ALL
server_reset_query_always        = 1
stats_users                      = hope_app
```

All 11 key settings match the Compose declaration.

---

## 3. Vitest suite (Tasks 1.7 – 1.13, 1.16)

```text
$ pnpm pgbv:test | tail -8
 Test Files  8 passed (8)
      Tests  19 passed (19)
   Start at  23:04:44
   Duration  4.10s
```

| # | Task | File | Cases | Result |
|---|---|---|---|---|
| 1.7  | basic SELECT | `01-basic-select.test.ts` | 3 | PASS |
| 1.8  | RLS GUC leak | `02-rls-guc-leak.test.ts` | 3 | PASS |
| 1.9  | soft-delete extension | `03-soft-delete-extension.test.ts` | 4 | PASS |
| 1.10 | prepared statements | `04-prepared-statements.test.ts` | 3 | PASS |
| 1.11 | DISCARD ALL | `05-discard-all.test.ts` | 2 | PASS — Δ 50 DISCARD log lines over 40 user txns |
| 1.12 | Prisma Migrate via `DIRECT_URL` | `06-prisma-migrate.test.ts` | 1 | PASS — 4 migrations applied, 1.4 s wall time |
| 1.13 | 100× concurrent `$transaction` RLS | `07-concurrent-rls.test.ts` | 1 | PASS — 0/100 cross-contaminated |
| 1.16 | `SHOW POOLS` under load | `08-show-pools-under-load.test.ts` | 2 | PASS — peak `sv_active=22`, `cl_waiting=0`, `maxwait=0` |

**Total: 19/19 passing.** No flakes across multiple runs (4 full re-runs during development).

---

## 4. pgbench baseline (Task 1.14)

Command: `bash packages/database/tests/pgbouncer-validation/pgbench/run-baseline.sh`
Parameters: scale=10, `-c 50 -j 4 -T 60 -P 10 -M prepared` (matches plan §1.14 exactly).

|  | TPS | avg latency | p95 latency | failed txns |
|---|---|---|---|---|
| Direct (5532) | **3779.54** | 13.217 ms | — (per-command in `direct.out`) | 0 / 225,895 |
| Pooled (6532) | **3775.69** | 13.224 ms | — (per-command in `pooled.out`) | 0 / 225,895 |
| **Pooled / Direct** | **0.999** | +0.05 % | n/a | 0 |

> **Rubric**: pooled TPS ≥ 0.85 × direct → **PASS** (0.999 ≥ 0.85, margin 14.9 pp).
> Raw reports: `packages/database/tests/pgbouncer-validation/pgbench/{direct,pooled}.out`.

SHOW STATS after the pooled pass (excerpt):
```text
total_xact_count           = 280,581
total_query_count          = 1,950,867
total_server_parse_count   = 1,581,347
total_bind_count           = 1,581,281
```
Zero "prepared statement does not exist / already exists" errors across 1.58 M parse + bind round-trips through the bouncer.

SHOW POOLS after the pooled pass:
```text
hope/hope_app    cl_waiting=0   maxwait=0   sv_idle=50   pool_mode=transaction
pgbouncer admin  cl_waiting=0                              pool_mode=statement
```

---

## 5. k6 application-shape load (Task 1.15 — optional, not executed)

Per `packages/database/tests/pgbouncer-validation/k6/README.md`: the rubric-relevant numbers were comfortably satisfied by `pgbench` (§4 above), and k6 with PostgreSQL requires the `xk6-sql` extension which is not pre-built on the executor's workstation. A ready-to-run script (`k6/hope-shape.js`) and build instructions are committed for the next agent or operator who wants to add this layer.

Marking this **NOT EXECUTED — NOT BLOCKING** per the plan's explicit "optional" classification.

---

## 6. CI matrix job (Task 1.17)

Added `test-pgbouncer-validation` to `.gitlab/ci/test.yml`. Uses `docker:27` + `docker:27-dind` service so the rig is reproducible in CI. Captures `SHOW POOLS`, `SHOW STATS`, and bouncer + postgres logs as 30-day artifacts on every run.

Rules:
* MRs that touch `packages/database/**/*` or `.gitlab/ci/test.yml` (vs `main`)
* `cicd` branch (always)
* `dev` branch (always)
* `staging` branch (when `packages/database/**/*` changed)

YAML validated locally (`yaml.load(...)` with `!reference` constructor stub) — 9 jobs now defined (was 8).

---

## 7. PASS / FAIL decision (Task 1.19)

### Rubric (per plan §1.19)

| Condition | Implication |
|---|---|
| All Vitest tests PASS **and** pgbench pooled TPS ≥ 0.85 × direct **and** no prepared-statement errors | PASS → Phase 2A |
| Any Vitest test FAIL (especially 1.8, 1.10, 1.13) | FAIL → Phase 2B |
| pgbench shows > 15 % TPS degradation under pooling | FAIL → Phase 2B |
| `DISCARD ALL` does not run | FAIL → escalate |

### Scorecard

| Condition | Observed | Verdict |
|---|---|---|
| All Vitest tests PASS | **19/19** across Tasks 1.7 – 1.13, 1.16 | ✅ |
| pgbench pooled TPS ≥ 0.85 × direct | **0.999** | ✅ |
| pgbench < 15 % degradation | **0.1 %** | ✅ |
| `DISCARD ALL` fires | Δ 50 log lines over 40 user txns (>1:1) | ✅ |
| No "prepared statement does not exist / already exists" errors | 0 errors over 1.58 M parses + binds | ✅ |
| 100 × concurrent RLS isolation | 0/100 cross-contaminated | ✅ |
| `prisma migrate deploy` via DIRECT_URL works | 4/4 migrations applied | ✅ |

### **VERDICT: PASS → execute Phase 2A (transaction-mode rollout)**

This satisfies the user's explicit Q1 preference in plan §10 ("if no issue with Prisma, keep transaction mode"). Phase 2B (session-mode fallback) is **not** executed.

---

## 8. Known limitations & follow-ups

1. **k6 application-shape load was NOT run** (Task 1.15 — optional). If the orchestrator wants belt-and-braces evidence, run it before Phase 3 cutover using the committed `hope-shape.js`.

2. **Single-node rig** — the validation does not exercise Patroni failover or HAProxy routing. Those concerns belong to Phase 3 (production cutover smoke tests), not Phase 1.

3. **Local Apple Silicon hardware** — pgbench numbers were captured on a single-developer M-series machine. Production VMs (10.10.1.x) have different CPU/IO profiles; the 0.999 ratio should be re-measured against the staging cluster during Phase 3 prep, with a fresh report appended to this document.

4. **Rig PG runs with `log_statement = 'all'`** so Task 1.11 has authoritative telemetry. The pgbench script (`run-baseline.sh`) mutes this for the duration of the benchmark via `ALTER SYSTEM` to avoid skewing TPS. Production must keep `log_statement = 'none'` per `research/configs/postgres-ha/`.

---

## 9. Next steps (for the orchestrator)

1. Confirm verdict and unblock Phase 2A.
2. Phase 2A tasks (transaction-mode rollout) — see plan §2A.
3. Re-run `pnpm pgbv:test` against staging-grade hardware as part of Phase 3 prep; append the resulting numbers to §8 of this report.
