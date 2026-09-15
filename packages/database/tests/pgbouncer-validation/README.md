# PgBouncer Validation Rig

A single-node PostgreSQL + PgBouncer (transaction mode) stack for verifying Prisma 7's
compatibility with a connection pooler under HOPE's workload. It is intentionally **isolated**
from `infrastructure/docker/` (dev) and the E2E test compose file so it can be brought up and torn
down independently of the rest of the local stack.

The rig predates, and is independent of, the current cluster's storage posture: the k3s deployment
today runs Postgres in-cluster with NO pooler in front of it (`.claude/rules/09-infrastructure-devops.md`).
This rig stays useful for any FUTURE pooled deployment, or for testing Prisma/pooler interaction in
isolation; it is not evidence of what the current cluster runs.

## Layout

| Path | What it holds |
|---|---|
| `docker-compose.yml` | The isolated Postgres + PgBouncer stack |
| `.env.example` | Template for `.env` (copy it; `dotenv-cli` loads the copy for `pgbv:*` scripts) |
| `vitest.config.ts` | Config for the `pgbv:test` Vitest suite |
| `__tests__/` | 8 numbered Vitest specs — basic select, RLS/GUC leak, soft-delete extension, prepared statements, `DISCARD ALL`, Prisma Migrate through the pooler, concurrent RLS, `SHOW POOLS` under load |
| `_helpers/clients.ts` | Shared pooled/direct client factories for the specs |
| `pgbench/` | `run-baseline.sh` and recorded `.out` baseline results (TPC-B-style pooled-vs-direct comparison) |
| `k6/` | Optional application-shape load test — see its own README |

## Commands

All are root `pnpm` aliases:

| Command | Effect |
|---|---|
| `pnpm pgbv:up` | Boot the stack (`docker compose up -d`) |
| `pnpm pgbv:push` | One-off: push the Prisma schema through the pooler |
| `pnpm pgbv:test` | Run the Vitest validation suite |
| `pnpm pgbv:show:config` / `:pools` / `:stats` | `psql` against PgBouncer's admin database (`SHOW CONFIG`/`SHOW POOLS`/`SHOW STATS`) |
| `pnpm pgbv:pgbench` | Run the pgbench baseline (`pgbench/run-baseline.sh`) |
| `pnpm pgbv:down` | Tear down and remove the named volume — next `:up` starts from an empty database |
| `pnpm pgbv:logs` / `pnpm pgbv:ps` | Compose log/status helpers |

## How it works

### What this validates

| Concern | How |
|---|---|
| Prisma 7 + `@prisma/adapter-pg` survives transaction-mode pooling | `pgbv:test` exercises pooled connections |
| `$transaction` + `set_config('app.tenant_id', ..., true)` (transaction-scoped RLS GUC) does not leak across transactions | Soft-delete extension still applies; the GUC does not leak |
| Long-running prepared-statement budget under load | Concurrent prepared statements within `MAX_PREPARED_STATEMENTS=200` |
| `DISCARD ALL` reset between transactions is observable | `SHOW STATS` snapshot before/after |
| Prisma Migrate (advisory locks) fails through the pooler, succeeds through `DIRECT_URL` | Dedicated spec |
| Performance: pooled TPS within the target ratio of direct on a read/write mix | `pgbench` baseline — recorded result: pooled/direct = 0.999 against a >= 0.85 target |

### Networking and ports

| Port | Service | Connection string env var |
|---|---|---|
| `5532` (host) -> `5432` (container) | PostgreSQL, direct | `DIRECT_URL` |
| `6532` (host) -> `6432` (container) | PgBouncer, pooled | `DATABASE_URL` |

Both ports are intentionally offset from the dev (`5432`) and E2E test (`5433`) ports so the rig can
co-exist with those stacks.

### Image pinning

| Component | Tag | Why |
|---|---|---|
| `timescale/timescaledb-ha:pg18-all` | multi-arch (arm64 + amd64) | |
| `edoburu/pgbouncer:v1.25.2-p0` | latest 1.25.x | Satisfies `max_prepared_statements` (PgBouncer >= 1.21). Configured via the image's URL-form `DATABASE_URL` env var for the upstream, not individual `DB_HOST`/`DB_PORT` vars |

### Effective PgBouncer config (`SHOW CONFIG` after `pgbv:up`)

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
listen_addr               = 0.0.0.0
listen_port               = 6432
```

### PostgreSQL GUCs applied

Set via `command:` overrides on the `postgres` compose service (the rig is single-node by design,
not via a Patroni entrypoint):

```text
idle_in_transaction_session_timeout = 30s
statement_timeout                   = 1min
max_connections                     = 200
```

## Gotchas

- `pnpm pgbv:down` removes the named volume — the next `pnpm pgbv:up` always starts from an empty
  database.
- Connection strings live in `./.env` (copy `.env.example` first); `dotenv-cli` loads them for
  `pgbv:push`/`pgbv:test`.

## Related

- [`@arcaai/database` README](../../README.md) — connection pooling section, `PRISMA_PG_MAX`
- [`02-database-prisma.md`](../../../../.claude/rules/02-database-prisma.md) — migration workflow
- [`09-infrastructure-devops.md`](../../../../.claude/rules/09-infrastructure-devops.md) — current cluster storage posture (no pooler)
- [k6 load test README](k6/README.md)
