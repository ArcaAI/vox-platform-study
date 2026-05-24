# PgBouncer Validation Rig

> **Stream C / Phase 1 of [TASK-302 — System Config Implementation Roadmap](../../../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md).**
> Single-node PostgreSQL + PgBouncer (transaction mode) for verifying Prisma 7's compatibility with the pooler under HOPE's workload.

The rig is intentionally **isolated** from `infrastructure/docker/` (dev) and
`docker-compose.test.yml` (E2E test) infra so it can be brought up and torn down
independently while other agents iterate on the rest of the monorepo.

---

## What this validates

| Concern | How |
|---|---|
| Prisma 7 + `@prisma/adapter-pg` survives transaction-mode pooling | `pgbv:test` runs Vitest cases that exercise pooled connections |
| `$transaction` + `set_config('app.tenant_id', …, true)` (transaction-scoped, i.e. RLS) leaks across transactions | Soft-delete extension still applies, RLS GUC does not leak (Task 1.8, 1.13) |
| Long-running prepared-statement budget under load | 100× concurrent prepared statements within `MAX_PREPARED_STATEMENTS=200` (Task 1.10) |
| `DISCARD ALL` reset between txns is observable | `SHOW STATS` snapshot before/after (Task 1.11) |
| Prisma Migrate (advisory locks) fails through pooler, succeeds through `DIRECT_URL` | Task 1.12 |
| Performance: pooled TPS within 10–15% of direct on read/write mix | `pgbench` baseline (Task 1.14) |

A PASS/FAIL verdict against the rubric in
[03-pgbouncer-rollout.md §1 — Validation Rig](../../../../docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md)
is recorded in Task 1.19 and determines whether Phase 2A (transaction-mode
rollout, preferred) or Phase 2B (session-mode fallback) is executed.

---

## Image pinning notes

| Component | Tag | Why |
|---|---|---|
| `timescale/timescaledb-ha:pg18-all` | multi-arch (arm64 + amd64) | Matches the HA blueprint at `research/configs/postgres-ha/` |
| `edoburu/pgbouncer:v1.25.1-p0` | latest 1.25.x | The originally-spec'd `1.25.0` tag is not published; `v1.25.1-p0` is the lowest 1.25.x tag and satisfies the `max_prepared_statements` (PgBouncer ≥ 1.21) requirement |

The plan referred to `edoburu/pgbouncer:1.25.0`; the actual published tag we
pin to is documented here for traceability.

---

## Networking + ports

| Port | Service | Connection string env var |
|---|---|---|
| `5532` (host) → `5432` (container) | PostgreSQL — direct | `DIRECT_URL` |
| `6532` (host) → `6432` (container) | PgBouncer — pooled | `DATABASE_URL` |

Both ports are intentionally offset from the dev (`5432`) and E2E test (`5433`)
ports so the rig can co-exist with those stacks.

---

## Workflow

```zsh
# 1. Boot the stack
pnpm pgbv:up

# 2. (one-off) Push the Prisma schema through the pooler
pnpm pgbv:push

# 3. Run the Vitest validation suite (once it exists — Task 1.6+)
pnpm pgbv:test

# 4. Inspect PgBouncer state ad-hoc
pnpm pgbv:show:config
pnpm pgbv:show:pools
pnpm pgbv:show:stats

# 5. Tear down (drops volume so next `:up` is clean)
pnpm pgbv:down
```

The connection strings live in `./.env` (copy `./.env.example`); `dotenv-cli`
loads them when `pnpm pgbv:test` runs.

---

## `pgbouncer.ini` keys (effective config)

Captured from `SHOW CONFIG;` after `pgbv:up`:

```text
pool_mode                 = transaction
default_pool_size         = 50
min_pool_size             = 5
max_client_conn           = 500
reserve_pool_size         = 10
reserve_pool_timeout      = 3
max_prepared_statements   = 200
server_reset_query        = DISCARD ALL
server_reset_query_always = 1
ignore_startup_parameters = extra_float_digits,search_path
auth_type                 = scram-sha-256
admin_users               = hope_app
stats_users               = hope_app
listen_addr               = 0.0.0.0
listen_port               = 6432
log_connections           = 1
log_disconnections        = 1
log_pooler_errors         = 1
```

These are set via the `edoburu` image's env-var schema (URL-form
`DATABASE_URL` for upstream, NOT individual `DB_HOST`/`DB_PORT`/etc. — that
was a misread of the image in the original plan).

---

## PostgreSQL GUCs applied

The rig mirrors the defensive timeouts shipped in Phase 0 (Task 0.4) so that
the validation surface matches production behaviour:

```text
idle_in_transaction_session_timeout = 30s   (PG GUC; kills sticky txns)
statement_timeout                   = 1min  (PG GUC; bounds runaway queries)
max_connections                     = 200   (matches Patroni blueprint)
```

These are set via `command:` overrides on the `postgres` service, not via the
Patroni entrypoint (the rig is single-node by design).

---

## Cleanup

`pnpm pgbv:down` removes the named volume `pg-data`, so subsequent
`pnpm pgbv:up` always starts from an empty database.
