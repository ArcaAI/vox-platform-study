# PgBouncer (and Alternatives) in Front of PostgreSQL 17 + Prisma 7 — HOPE Knowledge Base

| Field | Value |
|---|---|
| **Document** | `research/architecture/system-config-multi-tenancy/03-pgbouncer-prisma.md` |
| **Last updated** | 2026-05-24 |
| **Audience** | Senior backend / SRE scoping multi-tenant connection-pool work |
| **Status** | Reference / opinion piece (no code changes) |
| **Stack assumed** | PostgreSQL 17, Prisma 7.5.x + `@prisma/adapter-pg` 7.5.x, NestJS 11, `node-pg` 8.20, ≤ 50 tenants by 2027 |
| **Related docs** | [`research/deployments/deploy-vm500-502-postgres-ha.md`](../../deployments/deploy-vm500-502-postgres-ha.md) (Patroni HA stack — PgBouncer is already deployed there as "optional") |

> **TL;DR for the impatient**
>
> 1. HOPE does **not need** a pooler today: ≤ 50 tenants × a handful of NestJS pods × Prisma's default pool size = far below PG-17's 100-connection ceiling. **Tune the adapter, don't deploy infrastructure.**
> 2. When you do introduce one (almost certainly as part of the Phase-2 RLS rollout), use **PgBouncer in `session` mode** unless you have hard evidence that connection count is the bottleneck.
> 3. The Patroni HA blueprint at `deploy-vm500-502-postgres-ha.md` **already ships a PgBouncer container** (`edoburu/pgbouncer:latest`, port 6432, `POOL_MODE=transaction`) — that mode is wrong for HOPE's RLS plans and must be revisited before being switched on.
> 4. In Prisma 7 the URL params `connection_limit` and `pool_timeout` **no longer work for relational databases** — pool sizing now lives on the `PrismaPg` adapter (`max`, `connectionTimeoutMillis`, `idleTimeoutMillis`). This is the single biggest footgun for teams upgrading from v6.
> 5. `?pgbouncer=true` on the URL is still meaningful — it disables Prisma's named-prepared-statement machinery, which is the right setting whenever the downstream pooler is in transaction mode without `max_prepared_statements`.

---

## 1. Why a pooler — when does HOPE actually need one?

### 1.1 The cost of unpooled connections

Every PostgreSQL backend connection is a **separate OS process** (PG's process-per-connection model has not changed in 17). Empirical numbers consistently cited across 2024–2026 benchmarks:

| Cost item | Typical value |
|---|---|
| Memory per idle backend | 5–10 MB RSS |
| File descriptors per backend | 3–5 |
| Cost to spawn a new backend | 1–3 ms + the fork() cost |
| PG-17 default `max_connections` | 100 |
| Practical safe ceiling on bare-metal PG | 200–500 (above that, context-switch overhead causes p99 latency to spike 3–5× — see [how2.sh][how2]) |

The widely quoted "1,000 connections breaks PG" rule still holds in v17. The fix is **not** to crank `max_connections` to 2,000 — it is to either lower the application-side pool or insert a pooler.

### 1.2 Symptoms that say "you need a pooler now"

Treat any of these as a stop-the-line signal:

1. `pg_stat_activity` regularly shows > 70 % of `max_connections` in `idle` or `idle in transaction`.
2. Application logs show `sorry, too many clients already` (SQLSTATE `53300`) or Prisma's `P1017 server closed the connection`.
3. p99 query latency climbs while QPS stays flat — usually a sign of CPU spent on context switches.
4. Autoscaling NestJS pods occasionally trip over each other: a deploy or HPA event briefly doubles pod count and Postgres rejects new connections.
5. You start running serverless workers (Cloud Run, Lambda) that each open a fresh Prisma client.

### 1.3 HOPE-specific threshold math

HOPE today: `P` pods × `C` Prisma connections per pod ≤ PG `max_connections`.

| `P` (pods) | `C` (Prisma `max`) | Total | Headroom vs 100 `max_connections` |
|---|---|---|---|
| 4 | 10 (Prisma 7 default) | 40 | 60 — comfortable |
| 8 | 10 | 80 | 20 — tight; one rolling deploy will fail |
| 10 | 10 | 100 | 0 — broken |
| 4 | 20 | 80 | 20 — tight |
| 20 | 5 | 100 | 0 — broken |

**Conclusion:** with `max_connections = 200` on the Patroni primary and **explicit** `max = 5–10` on the `PrismaPg` adapter, HOPE can run 20 NestJS pods without a pooler. The pooler buys ops complexity that, at this scale, only pays off when (a) you autoscale aggressively, (b) you adopt RLS and want session-level state, or (c) you want a single failover point in front of the Patroni primary VIP.

### 1.4 Cheap alternatives before reaching for PgBouncer

- **Raise PG `max_connections`** to 200–300 *and* lower Prisma's adapter `max`. Cheapest possible fix; works up to several hundred connections.
- **`pg_cron` / pgBackRest workloads on a separate role** — keep their connections out of the application budget by setting per-role `CONNECTION LIMIT`s (PG 17 ALTER ROLE … CONNECTION LIMIT).
- **Postgres 17's built-in `transaction_timeout` / `idle_in_transaction_session_timeout`** — kills leaked connections without needing a pooler. Set `idle_in_transaction_session_timeout = '30s'` as a defensive default.
- ❌ **There is no native `pg_bouncer` extension.** PgBouncer is a separate daemon. (The `pgcat` and `Supavisor` projects are the modern alternatives — see §4.)

---

## 2. PgBouncer pooling modes — the critical decision

From the [PgBouncer config docs][pgb-config] and [usage docs][pgb-usage]:

### 2.1 Session mode (`pool_mode = session`, default)

A backend connection is bound to one client from connect to disconnect.

- **Every session-level feature works**: `SET`, `SET LOCAL`, `LISTEN`/`NOTIFY`, advisory locks, `WITH HOLD` cursors, temp tables, named prepared statements (both protocol-level and SQL `PREPARE`).
- `server_reset_query` (default `DISCARD ALL`) runs between clients.
- **Connection multiplexing benefit is small** — you mostly avoid `fork()` cost; you don't shrink the connection count.
- **Right choice when** you want PgBouncer as a *connection broker* (failover, auth indirection, RLS via session GUC) more than as a multiplexer.

### 2.2 Transaction mode (`pool_mode = transaction`)

Backend connection is released to the pool on `COMMIT` / `ROLLBACK`.

- **Massive multiplexing**: thousands of clients onto ~25–50 backends. This is the mode that "lets PG scale to 10k clients."
- **Breaks the following** *unless* you wrap them in an explicit transaction:

  | Feature | Behaviour under transaction mode |
  |---|---|
  | `SET key = val` (no `LOCAL`) | **DANGEROUS** — value persists on the backend and leaks to the next client (the [MVP Factory RLS post][mvpf-rls] calls this "a data breach waiting to happen") |
  | `SET LOCAL key = val` inside `BEGIN…COMMIT` | Safe — scoped to the transaction |
  | Named prepared statements (protocol level) | **Broken in PgBouncer ≤ 1.20**; **fixed in PgBouncer 1.21+** if you set `max_prepared_statements > 0` ([Crunchy Data blog][crunchy-ps]) |
  | SQL-level `PREPARE` / `DEALLOCATE` | Still broken even in 1.21+ — only the *protocol-level* extended query path is supported |
  | `LISTEN` / `NOTIFY` | Broken — channel registration vanishes between transactions |
  | Session-scoped advisory locks (`pg_advisory_lock`) | Broken (will deadlock — locks survive transaction but connection moves) |
  | Transaction-scoped advisory locks (`pg_advisory_xact_lock`) | Safe |
  | Temp tables | Broken (per-session) |
  | Cursors `WITH HOLD` | Broken |
  | `server_reset_query` (e.g. `DISCARD ALL`) | **Does not run** between transactions by default; must set `server_reset_query_always = 1` ([db-news mental model][db-news]) |

### 2.3 Statement mode (`pool_mode = statement`)

Released after every statement. **Multi-statement transactions are disallowed.** Effectively nothing in a real ORM works. Skip.

### 2.4 Recommendation matrix

| Workload | Mode | Why |
|---|---|---|
| Long-lived NestJS pods, < 200 total connections, want RLS via session GUC | **session** | Simplest; preserves all session features |
| Serverless / many transient clients | **transaction** + `max_prepared_statements ≥ 100` + `pgbouncer=true` | Only way to compress thousands of clients onto tens of backends |
| Migration runner / cron / `pg_dump` | **session** (or direct connection bypassing the pooler) | Long transactions, advisory locks |
| Anything that uses `LISTEN`/`NOTIFY` (e.g. `pg_notify` for cache invalidation) | **session** or direct | `NOTIFY` requires a stable backend |

---

## 3. Prisma 7 + `@prisma/adapter-pg` compatibility

### 3.1 The big v6 → v7 change you cannot miss

In Prisma 6, you tuned the pool via URL params (`?connection_limit=5&pool_timeout=10`). **In Prisma 7, those parameters are ignored for relational drivers.** Driver adapters are mandatory, and pool sizing now belongs to the underlying driver (`pg`):

| Behaviour | v6 URL param | v6 default | **v7 `PrismaPg` field** | **v7 default** |
|---|---|---|---|---|
| Pool size | `connection_limit` | `cpus * 2 + 1` | `max` | **`10`** |
| Acquire timeout | `pool_timeout` | `10 s` | `connectionTimeoutMillis` | **`0` (none)** |
| Connect timeout | `connect_timeout` | `5 s` | `connectionTimeoutMillis` | **`0` (none)** |
| Idle timeout | `max_idle_connection_lifetime` | `300 s` | `idleTimeoutMillis` | **`10 s`** |
| Connection max age | `max_connection_lifetime` | `0` | `maxLifetimeSeconds` | `0` |

Source: [Prisma docs — Connection pool][prisma-pool] (v7 section).

**The v7 default `idleTimeoutMillis = 10s` is aggressive** — under bursty traffic the pool keeps tearing down and rebuilding connections, which both spikes p99 and defeats any downstream pooler's "warm pool" assumption. Set it explicitly.

### 3.2 The `?pgbouncer=true` URL flag

This flag is still honoured in v7 and has one effect: **it disables Prisma's named-prepared-statement caching** on the client side. You want it whenever the downstream pooler is in transaction mode *and* does not have `max_prepared_statements > 0`. With PgBouncer 1.21+ and `max_prepared_statements = 100` (or higher), you can leave `?pgbouncer=true` off and benefit from prepared-statement caching. Source: [Prisma — Configure with PgBouncer][prisma-pgb].

### 3.3 Does Prisma's pool duplicate PgBouncer's?

Yes, deliberately. The two layers serve different jobs:

```
┌──────────────────────────────────────────────────────────────┐
│  NestJS pod                                                  │
│  ┌──────────────────┐                                        │
│  │ PrismaClient     │  ← in-process pool of TCP sockets      │
│  │  (PrismaPg max=5)│    to PgBouncer (cheap, fast checkout) │
│  └────────┬─────────┘                                        │
└───────────┼──────────────────────────────────────────────────┘
            │
            ▼ TCP × 5 per pod
┌──────────────────────────────────────────────────────────────┐
│ PgBouncer (default_pool_size=50, max_client_conn=500)        │
│  ← multiplexes onto a small set of real PG backends          │
└────────┬─────────────────────────────────────────────────────┘
         │
         ▼ TCP × ~25
┌──────────────────────────────────────────────────────────────┐
│ PostgreSQL 17 (max_connections=200)                          │
└──────────────────────────────────────────────────────────────┘
```

The Prisma-side pool exists to amortise the cost of TCP setup and handshake *to PgBouncer*. Make it small (3–5 in serverful, 1 in serverless).

### 3.4 Recommended `DATABASE_URL` shapes

**Without a pooler (today):**

```text
DATABASE_URL="postgresql://hope_app:****@pg-primary-vip:5000/hope?sslmode=require&schema=core"
```

(`5000` is the HAProxy R/W port from the HA blueprint.)

**With PgBouncer in session mode (recommended Phase-2 target):**

```text
DATABASE_URL="postgresql://hope_app:****@pgbouncer-vip:6432/hope?sslmode=require&schema=core"
DIRECT_URL="postgresql://hope_app:****@pg-primary-vip:5000/hope?sslmode=require&schema=core"
```

No `pgbouncer=true` needed in session mode — prepared statements work natively.

**With PgBouncer in transaction mode (only if you must):**

```text
DATABASE_URL="postgresql://hope_app:****@pgbouncer-vip:6432/hope?sslmode=require&schema=core&pgbouncer=true"
DIRECT_URL="postgresql://hope_app:****@pg-primary-vip:5000/hope?sslmode=require&schema=core"
```

`DIRECT_URL` is consumed by `prisma.config.ts` for migrations and introspection (which require a real session connection — Prisma Migrate uses advisory locks).

### 3.5 What `connection_limit=1` is good for

It only matters for the **legacy** Prisma engine path. In Prisma 7 + `adapter-pg` it is ignored. The correct equivalent is:

```typescript
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
  max: 1,                       // serverless: 1 connection per Lambda
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

export const prisma = new PrismaClient({ adapter });
```

In a serverful NestJS pod, use `max = 5` (3–10 is a reasonable band).

---

## 4. Alternatives to PgBouncer in 2025-2026

Drawn from the [PgConf.EU 2024 pooler comparison][pgconf24], the [PkgPulse 2026 guide][pkgpulse], and the [Gold Lapel "You Don't Need Redis"][goldlapel] chapter:

| Pooler | Language / Process | Modes | Multi-threaded? | Prepared stmts in txn mode | Notes |
|---|---|---|---|---|---|
| **PgBouncer 1.25** | C, single-process | session / transaction / statement | No (per process; run multiple) | **Yes** since 1.21 (`max_prepared_statements`) | Industry standard. ~2 MB RAM / 1000 clients. Smallest blast radius. |
| **pgcat** | Rust, multi-threaded | session / transaction | Yes | Yes | Adds read/write splitting and sharding. Drop-in wire-compatible with PgBouncer. Best step *up* from PgBouncer when you outgrow a single process. |
| **Supavisor** | Elixir / BEAM, distributed | session (port 5432) / transaction (port 6543) | Yes | Limited (transaction-mode lacks full prepared-statement support per [Tembo 2024 benchmarks][goldlapel]) | Designed for "1M connections, thousands of tenants per pool." Heavy: ~700 % CPU at 100 clients in Tembo benchmark. Only worthwhile if you are Supabase or building a Supabase-shaped platform. |
| **PgPool-II** | C, multi-process | session / transaction | Yes | Yes | Bundles failover + load balancing + query cache + replication. Configuration is famously baroque. Avoid unless you specifically need its replication. |
| **Odyssey** | C, multi-threaded | session / transaction | Yes | Yes | Yandex-built, mature, but ecosystem is thin outside Russia. |
| **No pooler — tune PG only** | — | — | — | — | Cheapest. Works until connection count exceeds ~150. |

### Decision matrix for HOPE

| Criterion (1–5, 5 best) | Weight | No-pooler | PgBouncer (session) | PgBouncer (txn) | pgcat | Supavisor |
|---|---:|---:|---:|---:|---:|---:|
| Operational simplicity | 3 | 5 | 4 | 3 | 3 | 1 |
| RLS compatibility (Phase-2) | 3 | 5 | 5 | 3 | 4 | 3 |
| Connection-count scalability | 2 | 1 | 2 | 5 | 5 | 5 |
| Read-replica routing (Phase-3?) | 1 | 1 | 1 | 1 | 5 | 4 |
| Prisma 7 maturity | 2 | 5 | 5 | 4 | 3 | 3 |
| **Weighted total** | | **35** | **39** | **34** | **33** | **24** |

**Winner: PgBouncer in session mode**, with pgcat as the upgrade path if/when HOPE needs read-replica routing.

---

## 5. RLS — the deal-breaker for transaction-mode pooling

This section ties to the multi-tenancy audit, which recommends RLS for Phase 2.

### 5.1 The pattern that works in *both* modes

```typescript
// Pattern A: transaction-scoped tenant context (safe in any pool mode)
await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
  // `true` = local to transaction → resets on COMMIT/ROLLBACK
  return tx.user.findMany();                  // RLS-filtered
});
```

`set_config(key, value, true)` is the function form of `SET LOCAL key = value`; the third argument `true` scopes the setting to the current transaction. Source: [PostgreSQL docs][pg-setconfig], [MVP Factory RLS guide][mvpf-rls].

### 5.2 The pattern that *only* works in session mode

```typescript
// Pattern B: session-scoped tenant context
// In session pool mode this is safe (each backend serves one client).
// In transaction pool mode this LEAKS THE TENANT TO THE NEXT CLIENT.
await prisma.$executeRaw`SET app.current_tenant_id = ${tenantId}`;
return prisma.user.findMany();
```

If you ever ship this pattern with PgBouncer in transaction mode you have built a cross-tenant data exfiltration channel. The MVP Factory post is blunt: *"a single `false` is a latent breach."*

### 5.3 The trap nobody warns you about

Prisma's auto-batching can split what looks like one transaction into multiple statements outside an explicit transaction block. **Always use `$transaction()` for the `set_config` + queries pair.** A NestJS interceptor can centralise this:

```typescript
// pseudo-code; do NOT copy verbatim
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly cls: ClsService, private readonly prisma: PrismaService) {}
  intercept(_ctx: ExecutionContext, next: CallHandler) {
    const tenantId = this.cls.get('tenantId');
    return from(
      this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
        // Bind `tx` into AsyncLocalStorage so downstream code uses the wrapped client
        return this.cls.run({ tx, tenantId }, () => firstValueFrom(next.handle()));
      })
    );
  }
}
```

### 5.4 Why HOPE should pick session-mode pooling

1. **Set-once-per-checkout** — set `app.current_tenant_id` in PgBouncer's `connect_query` or at the start of each NestJS request, never worry about transaction scope.
2. **Prisma Migrate works unchanged** — no need to split `DATABASE_URL` vs `DIRECT_URL` for the migration runner.
3. **Future-proofs `LISTEN`/`NOTIFY`** — if you eventually add cache-invalidation pub/sub on PG channels, session mode is the only choice.
4. **Scale loss is theoretical** — at 50 tenants × 5 pods × 5 connections = 125 backends, well under PG's safe ceiling.

---

## 6. Configuration recipes (for the future implementation)

### 6.1 `pgbouncer.ini` — recommended HOPE baseline

```ini
[databases]
hope = host=pg-primary-vip port=5432 dbname=hope auth_user=hope_app

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432

; ── Pooling ────────────────────────────────────────────────
pool_mode = session                ; See §5: simplest with RLS
default_pool_size = 50             ; ≥ (peak_concurrent_requests) for session mode
min_pool_size = 5                  ; Warm pool to absorb cold-start bursts
reserve_pool_size = 10             ; Emergency pool when default is exhausted
reserve_pool_timeout = 3           ; ...granted after waiting 3s
max_client_conn = 500              ; Hard cap on inbound TCP connections
max_db_connections = 80            ; Total backends to PG (< max_connections - admin slots)

; ── Hygiene ────────────────────────────────────────────────
server_reset_query = DISCARD ALL   ; Runs between session-mode checkouts
server_reset_query_always = 0      ; Default; only run in session mode
server_idle_timeout = 600          ; Recycle idle backends after 10 min
server_lifetime = 3600             ; Force-recycle backends hourly
client_idle_timeout = 0            ; Don't kill idle clients (Prisma manages this)
query_wait_timeout = 30            ; Fail fast if pool exhausted

; ── Protocol / startup ─────────────────────────────────────
ignore_startup_parameters = extra_float_digits,search_path
; ↑ Required for `pg` driver (Prisma's adapter sends these)

; ── Auth ───────────────────────────────────────────────────
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
auth_user = hope_app               ; Used for auth_query lookups

; ── Admin ──────────────────────────────────────────────────
admin_users = hope_admin
stats_users = hope_metrics

; ── TLS to upstream PG ─────────────────────────────────────
server_tls_sslmode = verify-full
server_tls_ca_file = /etc/ssl/certs/ca-certificates.crt

; ── Logging ────────────────────────────────────────────────
log_connections = 1
log_disconnections = 1
log_pooler_errors = 1
verbose = 0
```

**If you decide on transaction mode** (e.g. you outgrow session at scale), change three things:

```ini
pool_mode = transaction
max_prepared_statements = 200      ; Required for Prisma in txn mode (PgBouncer ≥ 1.21)
server_reset_query_always = 1      ; Force DISCARD ALL between transactions
```

…and add `?pgbouncer=true` to `DATABASE_URL` only if you keep `max_prepared_statements = 0`.

### 6.2 `docker-compose.yml` snippet

The Patroni HA setup (`research/configs/postgres-ha/docker-compose.yml`) already declares a PgBouncer service. For a single-node dev/stage environment, the minimal Compose addition is:

```yaml
services:
  pgbouncer:
    image: bitnami/pgbouncer:1.25.0      # Pin the version
    container_name: pgbouncer
    restart: unless-stopped
    ports:
      - "6432:6432"
    environment:
      POSTGRESQL_HOST: postgres
      POSTGRESQL_PORT: 5432
      POSTGRESQL_USERNAME: hope_app
      POSTGRESQL_PASSWORD: ${PG_PASSWORD}
      POSTGRESQL_DATABASE: hope
      PGBOUNCER_PORT: 6432
      PGBOUNCER_POOL_MODE: session       # See §5
      PGBOUNCER_DEFAULT_POOL_SIZE: 50
      PGBOUNCER_MAX_CLIENT_CONN: 500
      PGBOUNCER_IGNORE_STARTUP_PARAMETERS: extra_float_digits,search_path
      PGBOUNCER_AUTH_TYPE: scram-sha-256
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "PGPASSWORD=$$POSTGRESQL_PASSWORD psql -h 127.0.0.1 -p 6432 -U $$POSTGRESQL_USERNAME -d pgbouncer -c 'SHOW POOLS' || exit 1"]
      interval: 10s
      timeout: 3s
      retries: 5
```

> **Drift warning:** the existing HA `docker-compose.yml` pins `edoburu/pgbouncer:latest` and sets `POOL_MODE: transaction` with `DEFAULT_POOL_SIZE: 25`. Both choices need to be revisited before enabling the `pgbouncer` profile in production — see §10.

---

## 7. Monitoring & ops

### 7.1 Admin console essentials

Connect with `psql -h pgbouncer -p 6432 -U hope_admin pgbouncer`:

| Command | What it tells you |
|---|---|
| `SHOW POOLS` | Per (database, user) pair: `cl_active`, `cl_waiting`, `sv_active`, `sv_idle`, `sv_used`, `maxwait` |
| `SHOW STATS` | Cumulative request / transaction / query counters per database |
| `SHOW CLIENTS` | One row per inbound client connection |
| `SHOW SERVERS` | One row per outbound backend connection |
| `SHOW CONFIG` | Effective config (useful when debugging Docker env-var translation) |
| `RELOAD` | Re-read `pgbouncer.ini` without dropping clients |
| `PAUSE` / `RESUME` | Drain for upgrades |

### 7.2 Prometheus scraping

Use the official [`prometheus-community/pgbouncer_exporter`][pgb-exporter] (Go, port `9127`). The crucial metrics:

| Metric | Alert when | Meaning |
|---|---|---|
| `pgbouncer_pools_client_waiting_connections` (`cl_waiting`) | `> 0` for > 1 min | Clients are queueing → raise `default_pool_size` or fix slow queries |
| `pgbouncer_pools_client_maxwait_seconds` | `> 1s` | Oldest waiter has waited too long → pool saturated |
| `pgbouncer_pools_server_active_connections` (`sv_active`) | `>= default_pool_size` sustained | Pool is fully utilised → consider raising or sharding |
| `pgbouncer_pools_server_idle_connections` (`sv_idle`) | `= 0` consistently | No spare capacity |
| `pgbouncer_stats_waiting_duration_microseconds_total` | derivative > 0 trending up | Aggregate queue time growing |
| PG-side: `pg_stat_activity` `count(*)` | `> 0.8 × max_connections` | Pool sizing wrong or leak |

The Patroni HA stack already runs `postgres_exporter` on port 9187 — add `pgbouncer_exporter` next to it on each PG node.

### 7.3 Thundering-herd mitigations

- **`reserve_pool_size`** absorbs short spikes (PgBouncer grants extra backends after `reserve_pool_timeout` seconds of pressure).
- **`min_pool_size`** keeps warm backends ready — eliminates the "first request after idle" cold start.
- **Application-side jitter** on retries (NestJS's `RetryInterceptor` with exponential backoff + 100–500 ms jitter).
- **PG-side**: `idle_in_transaction_session_timeout = '30s'` and `statement_timeout = '60s'` as last-resort circuit breakers.

---

## 8. Failure modes & rollback

### 8.1 Breaking-change checklist (introducing PgBouncer)

Before flipping `DATABASE_URL` over to the pooler:

- [ ] Verify all migrations use `DIRECT_URL`, not `DATABASE_URL` (`prisma.config.ts`).
- [ ] Grep for `SET ` (no `LOCAL`) in application code — any match needs review.
- [ ] Grep for `LISTEN`, `NOTIFY`, `pg_advisory_lock`, `WITH HOLD`, `CREATE TEMP TABLE` — these only work in session mode.
- [ ] Confirm `ignore_startup_parameters` includes every GUC Prisma sends (`extra_float_digits`, `search_path` minimum).
- [ ] Set `idleTimeoutMillis` on `PrismaPg` to ≥ `server_idle_timeout` / 2 to avoid simultaneous timeouts.
- [ ] Pre-warm PgBouncer (`min_pool_size`) before first traffic.
- [ ] Load-test with `pgbench` through the pooler at 2× expected peak.

### 8.2 Rollback procedure

PgBouncer is a TCP-level proxy with no schema dependencies, so rollback is a config-only operation:

1. Update `DATABASE_URL` in NestJS env to point at the HAProxy R/W VIP (`pg-primary-vip:5000`) directly.
2. Rolling restart of API pods (Prisma re-resolves on boot).
3. Optionally `docker compose --profile pgbouncer down` on the HA nodes.
4. Verify with `psql 'host=pg-primary-vip port=5000 user=hope_app dbname=hope sslmode=require' -c 'SELECT 1'`.

No data is at risk; no migration is needed.

### 8.3 Smoke tests

```bash
# 1. Pooler accepts connection and authenticates
psql 'host=pgbouncer-vip port=6432 user=hope_app dbname=hope' -c 'SELECT version();'

# 2. Pool stats are sane
psql 'host=pgbouncer-vip port=6432 user=hope_admin dbname=pgbouncer' -c 'SHOW POOLS;'

# 3. Prisma can run a real query through the pooler
pnpm --filter @arcaai/api exec ts-node -e \
  "import {getPrismaClient} from '@arcaai/database'; \
   getPrismaClient().tenant.count().then(c => console.log('tenants', c));"

# 4. RLS check (Phase 2)
psql 'host=pgbouncer-vip port=6432 user=hope_app dbname=hope' <<SQL
BEGIN;
SELECT set_config('app.current_tenant_id', '00000000-0000-0000-0000-000000000001', true);
SELECT count(*) FROM core."User";  -- Should be tenant-1 only
COMMIT;
SQL
```

---

## 9. HOPE-specific recommendation

### Phase 1 — today, no pooler

- **Action**: explicit pool sizing on `PrismaPg`. Edit `packages/database/src/client.ts`:

  ```typescript
  const adapter = new PrismaPg({
    connectionString,
    max: Number(process.env.PRISMA_PG_MAX ?? 5),
    connectionTimeoutMillis: 5_000,    // Restore v6-like fast fail
    idleTimeoutMillis: 300_000,        // Restore v6-like 5-min idle
  });
  ```
- **Budget**: `pods × max ≤ 0.7 × PG max_connections` (i.e. with `max_connections = 200`, ≤ 28 pods at `max = 5`).
- **Set** `idle_in_transaction_session_timeout = '30s'` on PG.
- **Skip** the `pgbouncer` Compose profile in the HA blueprint for now.

### Phase 2 — RLS rollout

- Introduce PgBouncer **in session mode** (config in §6.1) on the same nodes as Patroni.
- Update `DATABASE_URL` to point at the PgBouncer VIP (`pgbouncer-vip:6432`); keep `DIRECT_URL` pointed at HAProxy for migrations.
- Implement the `TenantContextInterceptor` pattern from §5.3 (transaction-scoped `set_config`).
- Add Grafana dashboard for `pgbouncer_exporter` metrics.

### Phase 3 — only if growth justifies

- If you ever exceed ~500 active backends or need read-replica splitting: evaluate **pgcat**, not Supavisor (Supavisor's overhead is only worth it for SaaS pooler-as-a-service scenarios).
- If you adopt sharding (tenant → physical DB): revisit pgcat for its native sharding support.

### Anti-patterns to avoid

- Transaction-mode pooling without `max_prepared_statements > 0` *and* `?pgbouncer=true` — you'll get cryptic "prepared statement does not exist" errors under load.
- Setting `connection_limit` on the URL and expecting it to work in Prisma 7 — silently ignored.
- Sharing a PgBouncer between OLTP and OLAP / batch workloads — long transactions exhaust the pool.
- Using `SET app.current_tenant_id` (no `LOCAL`) anywhere near a transaction-mode pooler.
- Running Prisma migrations through PgBouncer — the migration runner takes advisory locks that don't survive transaction-mode connection swaps.

---

## 10. Open questions / decisions to revisit

1. **Is the HA blueprint's `POOL_MODE: transaction` baseline still appropriate?** The deployment doc `research/deployments/deploy-vm500-502-postgres-ha.md` ships PgBouncer pre-configured for transaction mode (`DEFAULT_POOL_SIZE: 25`, `MAX_CLIENT_CONN: 1000`). This conflicts with the RLS recommendation here. **Action**: review the HA Compose file, either (a) switch to `session` mode and document why, or (b) keep transaction mode but add `max_prepared_statements = 200` and `server_reset_query_always = 1`, plus update HOPE's NestJS code to use only transaction-scoped tenant context. Decision owner: data-layer + SRE.
Answer: If it was set to transaction mode and there is no issue with Prisma then lets keep it as is.
2. **Where does `auth_query` live?** The HA blueprint uses `auth_file` with a static `userlist.txt`. With Vault / OIDC-issued PG credentials on the horizon, switch to `auth_query` against a small SECURITY DEFINER function — out of scope for this doc but tracked as a follow-up.
Answer: Keeps using the `auth_file` for now.
3. **Does PgBouncer go behind or beside HAProxy?** Today the HA blueprint puts PgBouncer per-node *next to* HAProxy. Putting PgBouncer *behind* HAProxy (HAProxy → PgBouncer → PG) gives a single VIP but loses some failover granularity. The current "PgBouncer per node, point apps at all three" is operationally simpler — keep it.
Answer: Keeps it as is.
4. **Read-replica routing**: if/when Patroni replicas are added to the connection plan, do we route reads via HAProxy port 5001 with a separate `DATABASE_URL_RO` (no Prisma support today, needs application-side splitting) or via pgcat? Defer until read traffic > 5× write.
Answer: For now, referring these:
```
# Pooled — routes through the connection pooler
DATABASE_URL="postgres://USER:PASSWORD@<load-balancer>:<port>/?sslmode=require"
# Direct — connects straight to the database
DIRECT_URL="postgres://USER:PASSWORD@<without-load-balancer>:5432/?sslmode=require"
```
5. **If HOPE ever exceeds ~1000 active connections** (very unlikely at < 50 tenants) — revisit transaction-mode pooling with `max_prepared_statements` and `pgcat` for multi-threading.
Answer: TBD

---

## 11. References

### Primary documentation

- **PgBouncer config reference**: <https://www.pgbouncer.org/config.html> — authoritative `[pgbouncer]` directives, kept current with 1.25.
- **PgBouncer usage / pool modes**: <https://github.com/pgbouncer/pgbouncer/blob/master/doc/usage.md>
- **PgBouncer 1.25 (PIGSTY mirror)**: <https://pigsty.io/docs/pgbouncer/> — readable explanation of every setting.
- **PostgreSQL 17 max_connections / GUCs**: <https://www.postgresql.org/docs/17/runtime-config-connection.html>
- **Prisma — Configure with PgBouncer**: <https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/pgbouncer>
- **Prisma — Connection pool (v7)**: <https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/connection-pool>
- **Prisma — PostgreSQL database connector**: <https://www.prisma.io/docs/orm/core-concepts/supported-databases/postgresql>

### Background reading (2024–2026)

- Crunchy Data, *Prepared Statements in Transaction Mode for PgBouncer* (2024): <https://www.crunchydata.com/blog/prepared-statements-in-transaction-mode-for-pgbouncer>
- pganalyze, *PgBouncer 1.21 adds prepared statement support* (2024): <https://pganalyze.com/blog/5mins-postgres-pgbouncer-prepared-statements-transaction-mode>
- db-news, *The Mental Model for PgBouncer Pool Modes* (2025): <https://db-news.com/the-mental-model-for-pgbouncer-pool-modes>
- MVP Factory, *Row-Level Security in PostgreSQL: SaaS Tenant Isolation Without Query Changes* (2025): <https://mvpfactory.io/blog/row-level-security-in-postgresql-multi-tenant-data-isolation-for-your-saas/>
- MVP Factory, *PostgreSQL Connection Pooling for Mobile Backends at Scale* (2025): <https://mvpfactory.io/blog/postgresql-connection-pooling-strategies-that-actually-scale/>
- Steezr, *Postgres RLS for Multi-Tenant Django* (2025): <https://www.steezr.com/en/blog/postgres-row-level-security-multitenant-django-6>
- techinterview.org, *Tenant Isolation Low-Level Design: RLS + Connection Pool Limits* (2025): <https://www.techinterview.org/post/3233468628/lld-tenant-isolation/>
- how2.sh, *How to Optimize Connection Pool SLOs for High-Scale Systems* (2025): <https://how2.sh/posts/how-to-optimize-connection-pool-slo-controls-for-high-scale-systems/>
- Michał Drozd, *Connection Pool Sizing with Little's Law* (2025): <https://www.michal-drozd.com/en/blog/connection-pool-littles-law/>
- PkgPulse, *PgBouncer vs pgcat vs Supavisor 2026*: <https://www.pkgpulse.com/guides/pgbouncer-vs-pgcat-vs-supavisor-postgresql-connection-2026>
- Gold Lapel, *You Don't Need Redis — Sorting Out the Connection Poolers* (2025): <https://goldlapel.com/books/you-dont-need-redis/pgbouncer-alternative-comparison>
- PostgreSQL Europe Conference 2024, *Comparing Connection Poolers for PostgreSQL* (slides): <https://www.postgresql.eu/events/pgconfeu2024/sessions/session/5846/slides/547/comparing_poolers.pdf>
- Supabase Docs, *Supavisor FAQ*: <https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI>
- Medium / Jeyaram Ayyalusamy, *PostgreSQL 17 Database Administration: Mastering max_connections* (2024): <https://medium.com/@jramcloud1/postgresql-17-database-administration-mastering-max-connections-and-connection-management-a8c28db60aad>

### Tooling

- `prometheus-community/pgbouncer_exporter`: <https://github.com/prometheus-community/pgbouncer_exporter>
- `pgcat`: <https://github.com/postgresml/pgcat>
- `supavisor`: <https://github.com/supabase/supavisor>

### Internal HOPE references

- Patroni HA deployment plan with optional PgBouncer profile: [`research/deployments/deploy-vm500-502-postgres-ha.md`](../../deployments/deploy-vm500-502-postgres-ha.md)
- HA Compose file (current `POOL_MODE=transaction` baseline): [`research/configs/postgres-ha/docker-compose.yml`](../../configs/postgres-ha/docker-compose.yml)
- Prisma client wiring: [`packages/database/src/client.ts`](../../../../packages/database/src/client.ts)

[pgb-config]: https://github.com/pgbouncer/pgbouncer/blob/master/doc/config.md
[pgb-usage]: https://github.com/pgbouncer/pgbouncer/blob/master/doc/usage.md
[pgb-exporter]: https://github.com/prometheus-community/pgbouncer_exporter
[prisma-pool]: https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/connection-pool
[prisma-pgb]: https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/pgbouncer
[crunchy-ps]: https://www.crunchydata.com/blog/prepared-statements-in-transaction-mode-for-pgbouncer
[db-news]: https://db-news.com/the-mental-model-for-pgbouncer-pool-modes
[mvpf-rls]: https://mvpfactory.io/blog/row-level-security-in-postgresql-multi-tenant-data-isolation-for-your-saas/
[pgconf24]: https://www.postgresql.eu/events/pgconfeu2024/sessions/session/5846/slides/547/comparing_poolers.pdf
[pkgpulse]: https://www.pkgpulse.com/guides/pgbouncer-vs-pgcat-vs-supavisor-postgresql-connection-2026
[goldlapel]: https://goldlapel.com/books/you-dont-need-redis/pgbouncer-alternative-comparison
[how2]: https://how2.sh/posts/how-to-optimize-connection-pool-slo-controls-for-high-scale-systems/
[pg-setconfig]: https://www.postgresql.org/docs/17/functions-admin.html#FUNCTIONS-ADMIN-SET
