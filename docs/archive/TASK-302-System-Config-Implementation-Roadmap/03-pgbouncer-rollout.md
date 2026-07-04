# Plan: TASK-302 Stream C — PgBouncer Validation & Rollout

| Field | Value |
|---|---|
| **Document** | `docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md` |
| **Status** | Pending |
| **Created** | 2026-05-24 |
| **Stream** | C (PgBouncer + Prisma 7) |
| **Stack** | PostgreSQL 17 (PG 18 acceptable on existing HA), Prisma 7.5.x + `@prisma/adapter-pg` 7.5.x, NestJS 11, `node-pg` 8.20, ≤ 50 tenants by 2027 |
| **Source research** | [`research/architecture/system-config-multi-tenancy/03-pgbouncer-prisma.md`](../../../research/architecture/system-config-multi-tenancy/03-pgbouncer-prisma.md) |
| **HA baseline** | [`research/deployments/deploy-vm500-502-postgres-ha.md`](../../../research/deployments/deploy-vm500-502-postgres-ha.md), [`research/configs/postgres-ha/docker-compose.yml`](../../../research/configs/postgres-ha/docker-compose.yml) |
| **Required Skill** | [`executing-plans`](file:///Users/taphuynh/.cursor/skills/methodology/executing-plans/SKILL.md) — fresh subagent per task, mandatory `code-reviewer` gate between phases |
| **Estimated effort** | ~10–15 eng-days over ~2–3 calendar weeks (1 senior backend + 1 SRE) |

---

## Goal

Validate that **Prisma 7 (with `@prisma/adapter-pg`) operates correctly against PgBouncer in transaction mode** under HOPE's workload, then ship the validated configuration to production with a rollback path.

Three sequential outcomes:

1. **Phase 0 (today, no pooler)** — tune the `PrismaPg` adapter so that pool sizing matches HOPE's deployment shape and aligns with the eventual pooled topology.
2. **Phase 1 (go/no-go)** — build a reproducible validation rig that proves Prisma 7 ↔ PgBouncer 1.25 in **transaction mode** with `max_prepared_statements ≥ 200` and `server_reset_query_always = 1` is safe for HOPE's workload, RLS-readiness, soft-delete extension, and `$transaction`.
3. **Phase 2 + 3** — roll out **transaction mode** if validation passes (Phase 2A), or fall back to **session mode** if it fails (Phase 2B), then promote to production with staging soak + rollback rehearsal (Phase 3).

The plan resolves the existing drift between the research doc (recommends session mode in §6.1) and the existing HA blueprint (`POOL_MODE: transaction` in `research/configs/postgres-ha/docker-compose.yml` line 123).

---

## Cross-stream Dependencies

| Stream | Relationship | Touch point |
|---|---|---|
| **Stream A — Phase 0 Emergency Hotfix** (`01-phase-0-hotfix.md`) | **Hard dependency on completion** | `pgbouncer.ini` and `userlist.txt` must NEVER land in source control as plaintext. The Phase 0 gitleaks pre-commit hook + CI gate (Item 6) is the gating control; this plan ships `userlist.txt.example` only and references `userlist.txt` via a `.gitignore`'d path. |
| **Stream B — Vault Migration** (`02-vault-migration.md`) | **Sequenced after this stream** | `packages/database/src/client.ts` and `pgbouncer.ini` `auth_file` — ship PgBouncer first (cleanly tested), then layer Vault DB credentials on top. Stream B Phase 5 will introduce `auth_query` and Vault-rendered userlists; this plan deliberately keeps `auth_file` per the user's locked-in answer to Q2. |
| **Stream D — Optimistic Locking** (`04-optimistic-locking.md`) | Independent | None |
| Research doc `01-layered-resolution-migration.md` | **Out of scope (skipped per user)** | No plan; document remains as reference only. |

This plan can run **in parallel with Streams A and D** and **before Stream B Phase 5**.

---

## Architecture Overview

### Current state (today)

```
NestJS pod (× N)
└─ PrismaClient (PrismaPg adapter, default options — max=10, idleTimeoutMillis=10s)
        │
        │  TCP × ≤10 per pod, direct
        ▼
HAProxy VIP (10.10.1.250:5000) — R/W to Patroni primary
        │
        ▼
PostgreSQL 17/18 (Patroni primary, max_connections=200)
```

### Target state (Phase 2A — transaction mode, if validation passes)

```
NestJS pod (× N)
└─ PrismaClient (PrismaPg adapter, max=5, idleTimeoutMillis=300s)
        │
        │  TCP × 5 per pod, pooled
        ▼
PgBouncer (per node, transaction mode, default_pool_size=50,
           max_prepared_statements=200, server_reset_query_always=1)
        │
        │  TCP × ~50 multiplexed
        ▼
PostgreSQL 17/18 (Patroni primary, max_connections=200)

Migrations / DDL ──► DIRECT_URL ─► HAProxy R/W (bypasses PgBouncer; advisory locks needed)
```

### Fallback state (Phase 2B — session mode, only if Phase 1 fails)

Same topology, but PgBouncer with `pool_mode = session`, `default_pool_size = 50`, `min_pool_size = 5`, `reserve_pool_size = 10`. No `pgbouncer=true` URL flag needed; named prepared statements work natively.

The user's decisions (locked-in 2026-05-24) keep:

- **PgBouncer per node, beside HAProxy** (not behind it).
- **`auth_file` over `auth_query`** for now.
- **`DATABASE_URL` (pooled) + `DIRECT_URL` (direct)** split.

---

## Tech Stack

| Layer | Component | Version | Notes |
|---|---|---|---|
| Database | PostgreSQL | 17.x or 18.x | HA blueprint runs PG 18 in `timescale/timescaledb-ha:pg18-all-amd64`; same behavior applies. |
| Pooler | PgBouncer | **≥ 1.21** (pin to **1.25.0** or latest `edoburu/pgbouncer:1.25.0`) | 1.21 is the minimum version where `max_prepared_statements > 0` works in transaction mode. |
| Pooler image | `edoburu/pgbouncer:1.25.0` | — | HA blueprint already uses `edoburu/pgbouncer:latest` (line 116). Pin to a specific version. Bitnami `bitnami/pgbouncer:1.25.0` is the alternative; do **not** mix images in the same fleet. |
| Driver | `@prisma/adapter-pg` | 7.5.x | Owns pool sizing (the v6 URL params no longer apply). |
| Driver | `pg` (node-pg) | 8.20.x | Underlying TCP/connection pool. |
| ORM | Prisma | 7.5.x | Migration runner takes advisory locks; uses `DIRECT_URL` exclusively. |
| Monitoring | `prometheus-community/pgbouncer_exporter` | ≥ 0.10 | Exposes `cl_waiting`, `sv_active`, `maxwait_seconds`. |
| Load test | `pgbench` | bundled with PG | Baseline TPS. |
| Load test (optional) | `k6` | 0.50+ | Application-level shape (mirrors HOPE typical mix). |

---

## Decision Log

User-locked answers from `research/architecture/system-config-multi-tenancy/03-pgbouncer-prisma.md` §10, captured here verbatim and translated into design constraints.

| # | Question | **Answer (verbatim)** | Plan implication |
|---|---|---|---|
| 1 | Is the HA blueprint's `POOL_MODE: transaction` baseline still appropriate? | *"If it was set to transaction mode and there is no issue with Prisma then lets keep it as is."* | **Phase 1 must validate Prisma ↔ transaction-mode compatibility BEFORE any production change.** If validation passes → keep `POOL_MODE: transaction` and tune. If validation fails → escalate, switch to session mode (Phase 2B). |
| 2 | `auth_query` vs `auth_file`? | *"Keeps using the `auth_file` for now."* | Keep `auth_file = /etc/pgbouncer/userlist.txt`. Do **not** introduce `auth_query`. Stream B Phase 5 will revisit. |
| 3 | PgBouncer behind or beside HAProxy? | *"Keeps it as is."* (i.e. per-node, beside HAProxy) | Do not refactor topology. Each VM 500/501/502 runs `pgbouncer` next to `haproxy` (line 114–138 of `research/configs/postgres-ha/docker-compose.yml`). Apps point at all three PgBouncer endpoints via DNS RR or a separate VIP, not at a single VIP-fronted pooler. |
| 4 | Read-replica routing? | *"For now, referring these: `DATABASE_URL` (pooled), `DIRECT_URL` (direct)."* | Wire `DATABASE_URL` (pooled, port 6432) and `DIRECT_URL` (direct, port 5000 HAProxy R/W) into every consumer. `prisma.config.ts` uses `DIRECT_URL` for migrations. Read-replica splitting deferred (Appendix A). |
| 5 | >1000 active connections? | *"TBD"* | Out of scope. Documented as a future trigger (Appendix A). |

---

## Risks & Mitigations

| # | Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|---|
| R1 | Prisma 7's named-prepared-statement layer collides with PgBouncer transaction mode → `prepared statement "s1" does not exist` errors under load. | Medium | High | Phase 1 explicitly stress-tests this with 100 concurrent transactions; if it fails we fall to Phase 2B (session mode) or add `?pgbouncer=true`. |
| R2 | `DISCARD ALL` does not run between transactions → server-side state (search_path, GUCs) leaks across tenants. | Medium | Critical (cross-tenant) | `server_reset_query_always = 1` is mandatory in Phase 2A. Phase 1 explicitly tests `SET search_path` leakage. |
| R3 | Prisma's soft-delete client extension makes assumptions about session context that break under txn pooling. | Low | High | Phase 1 Task 1.9 tests the extension end-to-end via the pooler. |
| R4 | Prisma Migrate's advisory locks hang or are silently bypassed when run through the pooler. | High | Critical (corrupt schema) | `DIRECT_URL` is mandatory for migrations from Phase 0 onwards. `prisma.config.ts` enforces it. Phase 1 Task 1.12 verifies. |
| R5 | Existing application code uses non-`LOCAL` `SET`, `LISTEN`/`NOTIFY`, advisory locks, or temp tables that break in transaction mode. | Low (codebase grep is empty today) | High | Phase 2A.2 runs the audit and documents remediation. The current grep returned zero hits — risk is "future regression" more than "today's bug". |
| R6 | Connection budget math `pods × max ≤ 0.7 × PG max_connections` is exceeded during a deploy storm. | Medium | Medium | Phase 0 sets `PRISMA_PG_MAX = 5` (≤ 28 pods at PG 200). Phase 3 staging soak verifies under simulated rolling deploy. |
| R7 | PgBouncer at `edoburu/pgbouncer:latest` floats — a future image update silently downgrades PgBouncer < 1.21. | Medium | High | Pin to `edoburu/pgbouncer:1.25.0` (or the latest known-good tag) in Phase 2A.1. |
| R8 | TLS not enforced PgBouncer → PG → leaked credentials on a compromised node. | Low | High | `server_tls_sslmode = verify-full` in Phase 2A; Phase 3 sign-off includes `security-auditor` review. |
| R9 | Vault DB credentials (Stream B Phase 5) conflict with `auth_file` we ship in Stream C. | Medium | Medium | Stream B explicitly sequences **after** this stream. Cross-link in the Vault plan. |
| R10 | Drift between this plan and the existing HA blueprint persists (one says transaction, another says session). | High (already exists) | Medium | Phase 2A.1.2 / 2B.1.2 explicitly updates `deploy-vm500-502-postgres-ha.md` §10 with the chosen mode and ties it to this plan. |

---

## Team Allocation

| Role | Phase 0 | Phase 1 | Phase 2A/B | Phase 3 | Skills needed |
|---|---|---|---|---|---|
| Senior backend engineer | Lead | Lead | Lead | Co-lead | Prisma 7, NestJS, TypeScript, Vitest |
| SRE / Database admin | Reviewer | Lead | Lead | Lead | PgBouncer ops, Patroni, Prometheus, Postgres |
| `code-reviewer` subagent | Each gate | Each gate | Each gate | Each gate | — |
| `security-auditor` subagent | — | — | Phase 2A.1 sign-off | Phase 3 sign-off | TLS, `auth_file` permissions |
| `docs-manager` subagent | Phase 0.5 | Phase 1D | Phase 2A.6 / 2B.5 | Phase 3D | Markdown, runbook updates |

Subagent assignments are noted per-task as `**Agent**:` below. Use the [`executing-plans`](file:///Users/taphuynh/.cursor/skills/methodology/executing-plans/SKILL.md) skill — every implementation task runs in a **fresh subagent**, and every code-review gate is run by the `code-reviewer` subagent.

---

## Effort Estimate

| Phase | Eng-days | Calendar | Critical path |
|---|---|---|---|
| **Phase 0** — Adapter tuning | ~1 day | 1 day | Ship immediately; unblocks nothing but lowers production connection pressure. |
| **Phase 1** — Validation rig + decision | ~3–5 days | ~1 week | Hard gate. No Phase 2 work begins until 1.19 decision is recorded. |
| **Phase 2A** — Transaction-mode rollout | ~3 days | ~1 week | Conditional on Phase 1 PASS. |
| **Phase 2B** — Session-mode rollout (alt) | ~3 days | ~1 week | Conditional on Phase 1 FAIL. |
| **Phase 3** — Production cutover | ~5 days active + 7-day soak | ~2 weeks | Starts after Phase 2A or 2B sign-off. |
| **Total** | **~10–15 days** | **~2–3 weeks** | One senior backend + one SRE, working concurrently where possible. |

---

## Phase 0 — Prisma 7 adapter tuning (immediate, no pooler)

**Objective**: stop relying on Prisma 7's aggressive defaults (`max = 10`, `idleTimeoutMillis = 10s`) and pin the adapter to HOPE-appropriate values. Independent of PgBouncer — ships immediately.

**Budget rule**: `pods × max ≤ 0.7 × PG max_connections`. With `max_connections = 200` and `max = 5`, HOPE supports up to **28 simultaneous pods** before approaching the safe ceiling.

### Task 0.1 — Add `PRISMA_PG_MAX` and `DIRECT_URL` to `IAppConfig`

**Agent**: `database-admin`
**Files**:
- `packages/domains/src/interfaces/IAppConfig.ts`

**Steps** (TDD; ~5 min):

1. (RED) Add a Vitest unit test `packages/domains/src/interfaces/__tests__/IAppConfig.test.ts` asserting that the type now declares `PRISMA_PG_MAX?: number` and `DIRECT_URL?: string`. The compile-time check is the test.

2. (GREEN) Edit `packages/domains/src/interfaces/IAppConfig.ts`. After the existing `REDIS_PASS: string;` line (line 40) add:

   ```typescript
     //=========== DATABASE ============//
     /**
      * Optional override for the `PrismaPg` adapter's `max` pool size.
      * Defaults to 5 in `packages/database/src/client.ts`.
      * Budget rule: pods × PRISMA_PG_MAX ≤ 0.7 × PG max_connections.
      */
     PRISMA_PG_MAX?: number;

     /**
      * Direct (un-pooled) connection string.
      * Consumed exclusively by `prisma.config.ts` for migrations (advisory locks
      * do not survive PgBouncer transaction-mode swaps).
      */
     DIRECT_URL?: string;
   ```

3. Run `pnpm build --filter @arcaai/domains` and verify TypeScript compiles. Run `pnpm test:unit --filter @arcaai/domains` and verify the new test passes.

4. Commit: `feat(domains): add PRISMA_PG_MAX and DIRECT_URL to IAppConfig`.

### Task 0.2 — Update `PrismaPg` adapter options in `client.ts`

**Agent**: `database-admin`
**Files**:
- `packages/database/src/client.ts`

**Steps** (TDD; ~10 min):

1. (RED) Add a unit test `packages/database/src/__tests__/client-pool-options.test.ts` that mocks `PrismaPg`'s constructor and asserts the second-argument options object on `createPrismaClient()` contains `max`, `connectionTimeoutMillis`, `idleTimeoutMillis` derived from env / defaults.

2. (GREEN) Replace the `createPrismaClient()` body in `packages/database/src/client.ts` (lines 48–67):

   ```typescript
   function createPrismaClient() {
     const connectionString = process.env.DATABASE_URL;

     if (!connectionString) {
       throw new Error('DATABASE_URL environment variable is not set');
     }

     const max = Number(process.env.PRISMA_PG_MAX ?? 5);
     if (!Number.isFinite(max) || max <= 0) {
       throw new Error(
         `PRISMA_PG_MAX must be a positive integer; got ${process.env.PRISMA_PG_MAX}`,
       );
     }

     const adapter = new PrismaPg({
       connectionString,
       max,
       connectionTimeoutMillis: 5_000,
       idleTimeoutMillis: 300_000,
     });

     const prisma = new PrismaClient({
       adapter,
       log: process.env.NODE_ENV === 'development'
         ? ['query', 'error', 'warn']
         : ['error'],
     });

     return prisma;
   }
   ```

3. Run the new test (`pnpm test --filter @arcaai/database -- client-pool-options`) and observe RED → GREEN. Run the existing `client.test.ts` and `client-lifecycle.test.ts` — they must still pass (no regression in the mocked path).

4. Commit: `feat(database): explicit PrismaPg pool options (max=5, connTimeout=5s, idleTimeout=300s)`.

### Task 0.3 — Failing integration test verifying pool exhaustion behavior

**Agent**: `tester`
**Files**:
- `packages/database/src/integration/pool-exhaustion.integration.test.ts` (new)

**Steps** (TDD; ~30 min — longer because it stands up a real PG; explicitly accepted):

1. Add an integration test that:
   - Sets `PRISMA_PG_MAX=2` via `vi.stubEnv` BEFORE importing the client module.
   - Opens 2 long-running `$queryRaw` calls (1 s `pg_sleep`).
   - Asserts that the third concurrent call rejects within `connectionTimeoutMillis = 5_000` with the expected `pg` timeout error.

2. Verify the test fails against the previous default-configured client (RED).

3. Verify the test passes with the Task 0.2 changes (GREEN).

4. Add to the existing test infra: requires `pnpm docker:test:up && pnpm test:db:push` per `packages/database/src/integration/database-e2e.integration.test.ts` lines 12–14 conventions.

5. Commit: `test(database): integration test for PrismaPg max-pool exhaustion`.

### Task 0.4 — Set PG-side defensive timeouts via Patroni

**Agent**: `database-admin`
**Files**:
- `research/configs/postgres-ha/patroni/entrypoint.sh` (or the Patroni `bootstrap.dcs.postgresql.parameters` block — check the existing structure)

**Steps** (Infra task; ~30 min — accept longer; one-shot Patroni reload):

1. Set on the Patroni DCS config:

   ```yaml
   bootstrap:
     dcs:
       postgresql:
         parameters:
           idle_in_transaction_session_timeout: 30000   # 30 s, in ms
           statement_timeout: 60000                     # 60 s, in ms
   ```

   And via the runtime patch on a live cluster:

   ```bash
   patronictl -c /etc/patroni/patroni.yml edit-config \
     --set postgresql.parameters.idle_in_transaction_session_timeout=30000 \
     --set postgresql.parameters.statement_timeout=60000
   ```

2. Verify on the primary:

   ```bash
   psql -h 10.10.1.250 -p 5000 -U hope_app -d hope -c \
     "SHOW idle_in_transaction_session_timeout; SHOW statement_timeout;"
   ```

   Expected output:

   ```
    idle_in_transaction_session_timeout
   -------------------------------------
    30s
   (1 row)

    statement_timeout
   -------------------
    1min
   (1 row)
   ```

3. Document in `research/deployments/deploy-vm500-502-postgres-ha.md` §13 (Security Hardening) — add the two GUCs to the table.

4. Commit (separate PR if infra-only): `chore(ha): set idle_in_transaction_session_timeout=30s and statement_timeout=60s`.

### Task 0.5 — Document `PRISMA_PG_MAX` and `DIRECT_URL` in env templates

**Agent**: `docs-manager`
**Files**:
- `.env.example` (root)
- `apps/api/README.md`
- `packages/database/README.md` (if present; create otherwise — short)

**Steps** (~10 min):

1. Append to `.env.example`:

   ```bash
   # ── Prisma adapter pool (Phase 0 of TASK-302 Stream C) ──
   # Per-pod connection pool size. Default 5.
   # Budget rule: pods * PRISMA_PG_MAX <= 0.7 * PG max_connections
   PRISMA_PG_MAX=5

   # Direct (un-pooled) connection. Consumed only by Prisma Migrate.
   # Set this when DATABASE_URL points at PgBouncer (Phase 2A/2B).
   # DIRECT_URL=postgresql://hope_app:****@10.10.1.250:5000/hope?sslmode=require
   ```

2. Add a "Connection pool sizing" subsection to `apps/api/README.md`.

3. Commit: `docs: document PRISMA_PG_MAX and DIRECT_URL env vars`.

### Code Review Gate 0

**Agent**: `code-reviewer`
**Inputs**: diff of Tasks 0.1–0.5.

**Checklist**:
- [ ] `IAppConfig` declares `PRISMA_PG_MAX?: number` and `DIRECT_URL?: string`.
- [ ] `client.ts` reads `PRISMA_PG_MAX`, defaults to 5, validates as positive integer.
- [ ] `connectionTimeoutMillis = 5_000`, `idleTimeoutMillis = 300_000` are explicit literals.
- [ ] `client-pool-options.test.ts` exists and passes; `pool-exhaustion.integration.test.ts` exists and passes against real PG.
- [ ] Patroni GUCs applied and verified via `psql SHOW`.
- [ ] `.env.example` and `apps/api/README.md` updated.
- [ ] No new linter errors; `pnpm build --filter @arcaai/database` succeeds.
- [ ] Commits are atomic, conventional-commit style.

**Exit criterion**: Phase 0 is green; Phase 1 may begin.

---

## Phase 1 — Validation rig (Prisma 7 ↔ PgBouncer transaction mode)

**Objective**: empirically prove (or disprove) that Prisma 7 + `@prisma/adapter-pg` 7.5 + PgBouncer 1.25 in **transaction mode** with `max_prepared_statements = 200` and `server_reset_query_always = 1` is safe for HOPE.

**Hard gate**: nothing in Phase 2 starts until Task 1.19 records a documented PASS or FAIL decision.

### Section 1A — Docker Compose validation profile

#### Task 1.1 — Create the validation Compose stack

**Agent**: `pipeline-architect`
**Files**:
- `packages/database/tests/pgbouncer-validation/docker-compose.yml` (new)

**Steps** (Infra task; ~30 min — accept longer):

1. Write the Compose file (single-node PG + PgBouncer 1.25):

   ```yaml
   # packages/database/tests/pgbouncer-validation/docker-compose.yml
   # Single-node PG + PgBouncer 1.25 (transaction mode) for Prisma 7 compatibility validation.
   #
   # Ports:
   #   5532  → PostgreSQL (direct, mirrors DIRECT_URL)
   #   6532  → PgBouncer (pooled, mirrors DATABASE_URL)
   #
   # Usage (zsh):
   #   pnpm pgbouncer-validation:up
   #   pnpm pgbouncer-validation:test
   #   pnpm pgbouncer-validation:down

   name: hope-pgbouncer-validation

   networks:
     pgbv-net:
       driver: bridge

   volumes:
     pg-data:

   services:
     postgres:
       image: timescale/timescaledb-ha:pg18-all
       container_name: pgbv-postgres
       restart: unless-stopped
       environment:
         POSTGRES_DB: hope
         POSTGRES_USER: hope_app
         POSTGRES_PASSWORD: hope_app_local
       command: >
         postgres
         -c max_connections=200
         -c idle_in_transaction_session_timeout=30000
         -c statement_timeout=60000
         -c shared_buffers=128MB
         -c work_mem=8MB
         -c log_statement=none
         -c log_min_duration_statement=500
       ports:
         - '5532:5432'
       volumes:
         - pg-data:/var/lib/postgresql
       networks: [pgbv-net]
       healthcheck:
         test: ['CMD-SHELL', 'pg_isready -U hope_app -d hope']
         interval: 3s
         timeout: 3s
         retries: 20
         start_period: 5s

     pgbouncer:
       image: edoburu/pgbouncer:1.25.0
       container_name: pgbv-pgbouncer
       restart: unless-stopped
       depends_on:
         postgres:
           condition: service_healthy
       ports:
         - '6532:6432'
       environment:
         # ── upstream ──
         DB_HOST: postgres
         DB_PORT: 5432
         DB_USER: hope_app
         DB_PASSWORD: hope_app_local
         DB_NAME: hope
         # ── pool ──
         POOL_MODE: transaction
         DEFAULT_POOL_SIZE: 50
         MIN_POOL_SIZE: 5
         MAX_CLIENT_CONN: 500
         RESERVE_POOL_SIZE: 10
         RESERVE_POOL_TIMEOUT: 3
         # ── transaction-mode Prisma 7 requirements ──
         MAX_PREPARED_STATEMENTS: 200
         SERVER_RESET_QUERY: 'DISCARD ALL'
         SERVER_RESET_QUERY_ALWAYS: 1
         IGNORE_STARTUP_PARAMETERS: extra_float_digits,search_path
         # ── auth ──
         AUTH_TYPE: scram-sha-256
         # ── logging ──
         LOG_CONNECTIONS: 1
         LOG_DISCONNECTIONS: 1
         LOG_POOLER_ERRORS: 1
         VERBOSE: 0
         LISTEN_PORT: 6432
       networks: [pgbv-net]
       healthcheck:
         test:
           - CMD-SHELL
           - 'PGPASSWORD=hope_app_local psql -h 127.0.0.1 -p 6432 -U hope_app -d pgbouncer -c "SHOW POOLS" || exit 1'
         interval: 5s
         timeout: 3s
         retries: 10
         start_period: 5s
   ```

   > Note on the `edoburu` env-var names: this image translates env vars to `pgbouncer.ini` keys. Verify the exact spelling against `https://github.com/edoburu/docker-pgbouncer` for the pinned `1.25.0` tag; some versions used `DB_HOST` vs `DATABASE_URL`. If `1.25.0` requires `DATABASE_URL`-style, swap to:
   > ```yaml
   > DATABASE_URL: "postgres://hope_app:hope_app_local@postgres:5432/hope"
   > ```
   > and remove `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`. The functional config must match the research doc §6.1 baseline.

2. Verify `docker compose -f packages/database/tests/pgbouncer-validation/docker-compose.yml config` parses cleanly.

3. Commit: `chore(database): pgbouncer validation rig — single-node Compose`.

#### Task 1.2 — Confirm PgBouncer effective config

**Agent**: `database-admin`
**Files**: none (verification only)

**Steps** (~10 min):

1. Start the rig (`docker compose -f packages/database/tests/pgbouncer-validation/docker-compose.yml up -d`).

2. Connect to the PgBouncer admin console:

   ```bash
   PGPASSWORD=hope_app_local psql -h 127.0.0.1 -p 6532 -U hope_app -d pgbouncer -c 'SHOW CONFIG;' \
     | grep -E 'pool_mode|max_prepared_statements|server_reset_query|ignore_startup_parameters'
   ```

3. Expected (literal):

   ```
    pool_mode                          | transaction
    max_prepared_statements            | 200
    server_reset_query                 | DISCARD ALL
    server_reset_query_always          | 1
    ignore_startup_parameters          | extra_float_digits,search_path
   ```

4. If any value drifts, fix Task 1.1 and re-run before proceeding.

5. Document the captured output in `packages/database/tests/pgbouncer-validation/README.md` (Task 1.5).

#### Task 1.3 — Add `pnpm` scripts and env example

**Agent**: `pipeline-architect`
**Files**:
- root `package.json`
- `packages/database/tests/pgbouncer-validation/.env.example` (new)

**Steps** (~10 min):

1. Add to root `package.json` `scripts`:

   ```jsonc
   "pgbouncer-validation:up":   "docker compose -f packages/database/tests/pgbouncer-validation/docker-compose.yml up -d --wait",
   "pgbouncer-validation:down": "docker compose -f packages/database/tests/pgbouncer-validation/docker-compose.yml down -v",
   "pgbouncer-validation:logs": "docker compose -f packages/database/tests/pgbouncer-validation/docker-compose.yml logs -f",
   "pgbouncer-validation:test": "NODE_ENV=test DATABASE_URL='postgres://hope_app:hope_app_local@localhost:6532/hope?sslmode=disable' DIRECT_URL='postgres://hope_app:hope_app_local@localhost:5532/hope?sslmode=disable' vitest run packages/database/tests/integration"
   ```

2. Create `packages/database/tests/pgbouncer-validation/.env.example`:

   ```bash
   DATABASE_URL=postgres://hope_app:hope_app_local@localhost:6532/hope?sslmode=disable
   DIRECT_URL=postgres://hope_app:hope_app_local@localhost:5532/hope?sslmode=disable
   PRISMA_PG_MAX=5
   ```

3. Commit: `chore(database): pgbouncer validation pnpm scripts + env example`.

#### Task 1.4 — Bootstrap schema against the pooler

**Agent**: `database-admin`
**Files**: none

**Steps** (~10 min):

1. Apply migrations through `DIRECT_URL`:

   ```zsh
   export DATABASE_URL='postgres://hope_app:hope_app_local@localhost:6532/hope?sslmode=disable'
   export DIRECT_URL='postgres://hope_app:hope_app_local@localhost:5532/hope?sslmode=disable'
   pnpm --filter @arcaai/database db:migrate:deploy
   ```

   Expected tail:

   ```
   All migrations have been successfully applied.
   ```

2. Verify schema reachability through the pooler:

   ```zsh
   psql "$DATABASE_URL" -c "\dn core"
   ```

   Expected: `core | hope_app`.

#### Task 1.5 — Document the rig

**Agent**: `docs-manager`
**Files**:
- `packages/database/tests/pgbouncer-validation/README.md` (new)

**Steps** (~20 min — accept longer):

1. Author the rig README covering: purpose, prerequisites, start/stop, expected `SHOW CONFIG` output (Task 1.2), how to run the test suite (Tasks 1.6–1.13), how to capture the validation report.

2. Commit: `docs(database): document pgbouncer validation rig`.

### Section 1B — Vitest integration test suite

All tests live in `packages/database/tests/integration/pgbouncer-compat.test.ts` and execute against the rig from Section 1A. Each test is written **first** (RED) against the pooler with the current Phase 0 client wiring, then we observe whether it passes or fails — the **result is the validation evidence**.

> Note: the user's brief specifies `packages/database/tests/integration/pgbouncer-compat.test.ts` even though existing integration tests live at `packages/database/src/integration/`. Honor the user's path; it keeps the validation suite separate from the package's internal integration tests.

#### Task 1.6 — Set up the test harness

**Agent**: `tester`
**Files**:
- `packages/database/tests/integration/pgbouncer-compat.test.ts` (new)
- `packages/database/vitest.config.ts` (update — add a `pgbouncer-compat` project / pattern if needed)

**Steps** (~30 min — accept longer):

1. Harness scaffold:

   ```typescript
   // packages/database/tests/integration/pgbouncer-compat.test.ts
   import { afterAll, beforeAll, describe, expect, it } from 'vitest';
   import { PrismaPg } from '@prisma/adapter-pg';
   import { PrismaClient } from '../../src/generated/core-prisma-client/client.js';

   const POOLED_URL = process.env.DATABASE_URL!;
   const DIRECT_URL_ = process.env.DIRECT_URL!;

   const isPooled = (url: string) => /:6532\b/.test(url) || url.includes('pgbouncer');

   describe('PgBouncer transaction-mode compatibility (Prisma 7)', () => {
     let prisma: PrismaClient;

     beforeAll(async () => {
       expect(POOLED_URL, 'DATABASE_URL must point at pgbouncer (6532)').toMatch(/:6532\b/);
       expect(DIRECT_URL_, 'DIRECT_URL must point at direct PG (5532)').toMatch(/:5532\b/);

       const adapter = new PrismaPg({
         connectionString: POOLED_URL,
         max: 5,
         connectionTimeoutMillis: 5_000,
         idleTimeoutMillis: 300_000,
       });
       prisma = new PrismaClient({ adapter });
       await prisma.$connect();
     });

     afterAll(async () => {
       await prisma.$disconnect();
     });

     // 1.7 — 1.13 follow ...
   });
   ```

2. Run `pnpm pgbouncer-validation:test`; harness must connect (the `beforeAll` is itself a "does it talk to the pooler at all" test). Commit: `test(database): pgbouncer-compat harness`.

#### Task 1.7 — Test: basic SELECT through the pooler

**Agent**: `tester`
**Files**: same.

**Steps** (~5 min):

```typescript
it('SELECT 1 returns 1 through the pooler', async () => {
  const rows = await prisma.$queryRaw<{ result: number }[]>`SELECT 1::int AS result`;
  expect(rows[0]?.result).toBe(1);
});
```

Run; observe PASS. Commit: `test(database): pgbouncer-compat SELECT`.

#### Task 1.8 — Test: `$transaction` with `set_config('app.current_tenant_id', $1, true)`

**Agent**: `tester`
**Files**: same.

**Steps** (~15 min — RLS-readiness, the critical case):

```typescript
it('$transaction can SET LOCAL tenant context and read it back', async () => {
  const tenantId = '50000000-0000-0000-0000-000000000000';
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    const rows = await tx.$queryRaw<{ value: string | null }[]>`
      SELECT current_setting('app.current_tenant_id', true) AS value
    `;
    return rows[0]?.value;
  });
  expect(result).toBe(tenantId);
});

it('app.current_tenant_id does NOT leak to the next transaction', async () => {
  const tenantId = '50000000-0000-0000-0000-000000000000';
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
  });
  // After COMMIT, the value MUST be empty on the next backend pickup.
  // Run many quick reads to bounce across backends.
  for (let i = 0; i < 20; i++) {
    const rows = await prisma.$queryRaw<{ value: string | null }[]>`
      SELECT current_setting('app.current_tenant_id', true) AS value
    `;
    expect(rows[0]?.value ?? '').toBe('');
  }
});
```

Run; observe behavior. **This is the critical RLS test** — if the second `it` fails, transaction mode is unsafe for HOPE's planned RLS rollout, regardless of any other result.

Commit: `test(database): pgbouncer-compat $transaction + set_config(LOCAL)`.

#### Task 1.9 — Test: soft-delete extension survives the pooler

**Agent**: `tester`
**Files**: same; uses `getExtendedPrismaClient()` from `packages/database/src/client.ts`.

**Steps** (~15 min):

```typescript
it('soft-delete client extension filters DELETED rows through pgbouncer', async () => {
  const { getExtendedPrismaClient } = await import('../../src/client.js');
  const ext = getExtendedPrismaClient();
  // Seed a tenant row, soft-delete it, then findMany — must exclude it.
  const id = `aaaaaaaa-aaaa-aaaa-aaaa-${Date.now().toString().padStart(12, '0')}`;
  await prisma.$executeRaw`
    INSERT INTO core."Tenant" (id, "tenantId", code, name, "resourceStatus", "createdAt", "updatedAt")
    VALUES (${id}::uuid, '50000000-0000-0000-0000-000000000000'::uuid,
            'pgbv-soft-' || ${id.slice(-6)}, 'pgbv', 'DELETED', now(), now())
  `;
  const rows = await ext.tenant.findMany({ where: { id } });
  expect(rows.length).toBe(0); // soft-delete filter must hide it
});
```

Run; observe PASS. The Prisma client extension wires `query: $allModels.findMany` — confirm it survives the pooler's request lifecycle. Commit: `test(database): pgbouncer-compat soft-delete extension`.

#### Task 1.10 — Test: prepared-statement caching under concurrent load

**Agent**: `tester`
**Files**: same.

**Steps** (~15 min — the canonical "transaction mode + prepared statements" stress test):

```typescript
it('100 concurrent queries do not error with "prepared statement does not exist"', async () => {
  const errors: unknown[] = [];
  await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      try {
        // Mix queries so Prisma chooses different prepared-statement slots.
        if (i % 3 === 0) await prisma.$queryRaw`SELECT 1 + ${i}::int AS x`;
        else if (i % 3 === 1) await prisma.$queryRaw`SELECT now() AS x, ${i}::int AS i`;
        else await prisma.$queryRaw`SELECT pg_backend_pid() AS pid, ${i}::int AS i`;
      } catch (e) {
        errors.push(e);
      }
    }),
  );
  expect(errors.length, JSON.stringify(errors.map(String))).toBe(0);
});
```

Run with `PRISMA_PG_MAX=5` and `MAX_PREPARED_STATEMENTS=200`. **Expected outcomes**:
- All 100 succeed → transaction mode + `max_prepared_statements = 200` is **viable** (path to Phase 2A).
- Any `prepared statement "sN" does not exist` error → transaction mode is **broken** with the current settings; either raise `MAX_PREPARED_STATEMENTS` or fall back to session mode (Phase 2B).

Commit: `test(database): pgbouncer-compat 100x concurrent prepared statements`.

#### Task 1.11 — Test: `DISCARD ALL` runs between transactions

**Agent**: `tester`
**Files**: same.

**Steps** (~10 min — verifies `server_reset_query_always = 1`):

```typescript
it('search_path set inside a transaction does not leak to the next checkout', async () => {
  // Force backend pickup: open many sequential calls.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET search_path TO core, public`;
  });
  for (let i = 0; i < 10; i++) {
    const rows = await prisma.$queryRaw<{ search_path: string }[]>`SHOW search_path`;
    // Default for fresh backend is '"$user", public' (or similar).
    expect(rows[0]?.search_path).not.toMatch(/^core/);
  }
});
```

Run; PASS means `DISCARD ALL` is firing as expected. FAIL means `server_reset_query_always` is missing or PgBouncer < 1.21 silently ignores it. Commit: `test(database): pgbouncer-compat DISCARD ALL between txns`.

#### Task 1.12 — Test: Prisma Migrate via `DIRECT_URL`

**Agent**: `tester`
**Files**: same; spawns a child process.

**Steps** (~15 min):

```typescript
it('prisma migrate status uses DIRECT_URL (advisory lock acquires)', async () => {
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(
    'pnpm',
    ['--filter', '@arcaai/database', 'db:migrate:status'],
    {
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL!, DIRECT_URL: process.env.DIRECT_URL! },
      encoding: 'utf8',
    },
  );
  expect(res.status, res.stderr).toBe(0);
  expect(res.stdout).toMatch(/Database schema is up to date|migrations? have been applied/);
});
```

Run; PASS means `prisma.config.ts` is correctly using `DIRECT_URL` (Task 2A.4 will lock this in for production wiring; here we test the rig's wiring). Commit: `test(database): pgbouncer-compat prisma migrate via DIRECT_URL`.

#### Task 1.13 — Test: 100-row concurrent `$transaction` with `set_config`

**Agent**: `tester`
**Files**: same.

**Steps** (~15 min — combined RLS + concurrency):

```typescript
it('100 concurrent $transactions with set_config do not cross-leak tenants', async () => {
  const tenantIds = Array.from({ length: 100 }, (_, i) =>
    `10000000-0000-0000-0000-${(i + 1).toString().padStart(12, '0')}`,
  );
  const results = await Promise.all(
    tenantIds.map((tid) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tid}, true)`;
        const rows = await tx.$queryRaw<{ value: string }[]>`
          SELECT current_setting('app.current_tenant_id', true) AS value
        `;
        return rows[0]?.value;
      }),
    ),
  );
  results.forEach((seen, i) => expect(seen).toBe(tenantIds[i]));
});
```

Run; PASS means transaction-scoped tenant context works concurrently. Commit: `test(database): pgbouncer-compat 100x concurrent $transaction + set_config`.

### Section 1C — `pgbench` / k6 load test

#### Task 1.14 — Baseline `pgbench` (direct vs pooled)

**Agent**: `tester`
**Files**:
- `packages/database/tests/pgbouncer-validation/pgbench/init.sh` (new)
- `packages/database/tests/pgbouncer-validation/pgbench/run.sh` (new)

**Steps** (Infra task; ~40 min — accept longer):

1. Init script:

   ```bash
   #!/usr/bin/env zsh
   # packages/database/tests/pgbouncer-validation/pgbench/init.sh
   set -euo pipefail
   PGPASSWORD=hope_app_local pgbench -h 127.0.0.1 -p 5532 -U hope_app -i -s 10 hope
   ```

2. Run script:

   ```bash
   #!/usr/bin/env zsh
   # packages/database/tests/pgbouncer-validation/pgbench/run.sh
   set -euo pipefail
   echo '── Direct (port 5532) ──'
   PGPASSWORD=hope_app_local pgbench -h 127.0.0.1 -p 5532 -U hope_app \
     -c 50 -j 4 -T 60 -P 10 -M prepared hope
   echo '── Pooled  (port 6532) ──'
   PGPASSWORD=hope_app_local pgbench -h 127.0.0.1 -p 6532 -U hope_app \
     -c 50 -j 4 -T 60 -P 10 -M prepared hope
   ```

3. Capture output. Expected shape (numbers will vary by host):

   ```
   ── Direct ──
   number of clients: 50
   number of threads: 4
   duration: 60 s
   ...
   tps = 5421.234567 (without initial connection time)
   latency average = 9.224 ms

   ── Pooled ──
   number of clients: 50
   number of threads: 4
   duration: 60 s
   ...
   tps = 5103.456789 (without initial connection time)
   latency average = 9.802 ms
   ```

4. Accept criterion: pooled TPS within **15 %** of direct TPS, and **no errors** in either run. Failures (e.g., `prepared statement "..." does not exist`) flip the validation result.

5. Capture in `validation-report.md` (Task 1.18). Commit: `test(database): pgbench direct vs pooled baseline scripts`.

#### Task 1.15 — Application-shape k6 load (optional but recommended)

**Agent**: `tester`
**Files**:
- `packages/database/tests/pgbouncer-validation/k6/load.js` (new)

**Steps** (Infra task; ~60 min — accept longer):

1. k6 script that mirrors HOPE's typical mix: 80 % `Tenant.findFirst` + `GlobalSetting.findMany`, 20 % `$transaction` with `set_config + Tenant.findUnique`:

   ```javascript
   // packages/database/tests/pgbouncer-validation/k6/load.js
   import http from 'k6/http';
   import { check, sleep } from 'k6';

   export const options = {
     scenarios: {
       typical: {
         executor: 'ramping-vus',
         startVUs: 0,
         stages: [
           { duration: '30s', target: 50 },
           { duration: '2m', target: 100 },
           { duration: '30s', target: 0 },
         ],
       },
     },
     thresholds: {
       http_req_failed: ['rate<0.01'],
       http_req_duration: ['p(95)<200'],
     },
   };

   export default function () {
     // Hit the test harness HTTP endpoint that runs the typical Prisma mix.
     const res = http.get(__ENV.K6_TARGET ?? 'http://localhost:18080/typical');
     check(res, { 'status 200': (r) => r.status === 200 });
     sleep(0.1);
   }
   ```

   Pair with a tiny harness script that exposes `/typical` over the validation rig's Prisma client.

2. Run target: `p95 < 200 ms`, `error rate < 1 %`. Commit: `test(database): k6 typical-load script for pgbouncer validation`.

#### Task 1.16 — Capture `SHOW POOLS` under load

**Agent**: `tester`
**Files**: none (capture only).

**Steps** (~10 min):

1. During the k6 run, sample every 10 s:

   ```zsh
   PGPASSWORD=hope_app_local psql -h 127.0.0.1 -p 6532 -U hope_app -d pgbouncer -c 'SHOW POOLS;' \
     | tee -a /tmp/pgbouncer-show-pools.log
   ```

2. Expected sample under healthy 100-VU load:

   ```
    database | user     | cl_active | cl_waiting | cl_active_cancel_req | cl_waiting_cancel_req | sv_active | sv_active_cancel | sv_being_canceled | sv_idle | sv_used | sv_tested | sv_login | maxwait | maxwait_us | pool_mode
   ----------+----------+-----------+------------+----------------------+-----------------------+-----------+------------------+-------------------+---------+---------+-----------+----------+---------+------------+-----------
    hope     | hope_app |        87 |          0 |                    0 |                     0 |        47 |                0 |                 0 |       3 |       0 |         0 |        0 |       0 |          0 | transaction
   ```

3. **Healthy signals**: `cl_waiting = 0`, `maxwait = 0`, `sv_active ≤ default_pool_size`. **Unhealthy**: `cl_waiting > 0` sustained, `maxwait > 1000` µs trending up. Capture both in the report.

#### Task 1.17 — Add a CI matrix job for the validation rig

**Agent**: `cicd-manager`
**Files**:
- `.gitlab-ci.yml`

**Steps** (~30 min — accept longer):

1. Add a job that mirrors `pnpm pgbouncer-validation:up && pnpm pgbouncer-validation:test`, gated to MRs that touch:
   - `packages/database/src/client.ts`
   - `packages/database/tests/pgbouncer-validation/**`
   - `packages/database/tests/integration/pgbouncer-compat.test.ts`
   - `research/configs/postgres-ha/docker-compose.yml`

2. Sketch:

   ```yaml
   pgbouncer-validation:
     stage: test
     image: docker:27.3-cli
     services:
       - docker:27.3-dind
     variables:
       DOCKER_DRIVER: overlay2
       DOCKER_TLS_CERTDIR: ""
     before_script:
       - apk add --no-cache nodejs npm git
       - npm i -g pnpm@9
     script:
       - pnpm install --frozen-lockfile
       - pnpm pgbouncer-validation:up
       - pnpm pgbouncer-validation:test
     after_script:
       - pnpm pgbouncer-validation:logs > pgbouncer-validation.log || true
       - pnpm pgbouncer-validation:down || true
     artifacts:
       when: always
       paths: [pgbouncer-validation.log]
     rules:
       - changes:
           - packages/database/src/client.ts
           - packages/database/tests/pgbouncer-validation/**
           - packages/database/tests/integration/pgbouncer-compat.test.ts
           - research/configs/postgres-ha/docker-compose.yml
   ```

3. Commit: `ci: add pgbouncer-validation matrix job`.

#### Task 1.18 — Run the full suite and write the validation report

**Agent**: `tester`
**Files**:
- `docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-validation-report.md` (new)

**Steps** (Infra task; ~60 min — accept longer):

1. Run end-to-end: bring rig up, run Vitest suite (1.7–1.13), run pgbench (1.14), run k6 (1.15), capture `SHOW POOLS` (1.16).

2. Report template:

   ```markdown
   # PgBouncer Validation Report — Prisma 7 ↔ Transaction Mode

   | Field | Value |
   |---|---|
   | Captured | YYYY-MM-DD |
   | Operator | <name> |
   | PgBouncer | edoburu/pgbouncer:1.25.0 |
   | PG | timescaledb-ha:pg18-all |
   | Prisma | 7.5.x |

   ## Vitest results
   | Test | Result | Notes |
   |---|---|---|
   | 1.7 SELECT | PASS / FAIL | |
   | 1.8 $transaction + set_config + leak check | PASS / FAIL | |
   | 1.9 soft-delete extension | PASS / FAIL | |
   | 1.10 100x concurrent prepared statements | PASS / FAIL | error count |
   | 1.11 DISCARD ALL | PASS / FAIL | |
   | 1.12 Prisma Migrate via DIRECT_URL | PASS / FAIL | |
   | 1.13 100x concurrent $transaction RLS | PASS / FAIL | |

   ## pgbench (60s, c=50, j=4)
   |  | TPS | p95 latency | error count |
   |---|---|---|---|
   | Direct (5532) | | | |
   | Pooled (6532) | | | |

   ## k6 typical load
   - p95: <ms>
   - error rate: <%>
   - sustained VUs: 100 for 2 min

   ## SHOW POOLS at peak
   ```
   <paste captured rows>
   ```

   ## Verdict
   - [ ] PASS — proceed to Phase 2A (transaction mode)
   - [ ] FAIL — proceed to Phase 2B (session mode); failure mode: ___

   ## Sign-off
   - Backend lead: ___
   - SRE: ___
   - Date: ___
   ```

3. Commit: `docs(task-302): pgbouncer validation report (initial run)`.

### Section 1D — Decision gate

#### Task 1.19 — Record the Phase 2A vs 2B decision

**Agent**: `docs-manager` (with backend lead + SRE sign-off)

**Steps** (Decision-making; ~30 min):

1. Convene the backend lead + SRE. Walk through 1.18.

2. Apply the **PASS/FAIL rubric**:

   | Condition | Implication |
   |---|---|
   | All 7 Vitest tests PASS **and** pgbench pooled TPS ≥ 0.85 × direct **and** k6 error rate < 1 % | **PASS → Phase 2A** |
   | Any Vitest test FAIL (especially 1.8, 1.10, 1.13) | **FAIL → Phase 2B** |
   | pgbench shows > 15 % TPS degradation under pooling | **FAIL → Phase 2B** (re-evaluate after Phase 2B is in place; revisit pool sizing) |
   | k6 sustained `prepared statement does not exist` errors | **FAIL → Phase 2B** |
   | `DISCARD ALL` (1.11) does not run | **FAIL → escalate; do NOT proceed without `server_reset_query_always = 1` verified** |

3. Record decision in the validation report (1.18). If FAIL, also open a follow-up issue capturing the specific failure mode for future re-test.

4. Commit: `docs(task-302): record pgbouncer validation decision (Phase 2A|2B)`.

### Code Review Gate 1

**Agent**: `code-reviewer`
**Inputs**: diff of Tasks 1.1–1.19 + the validation report.

**Checklist**:
- [ ] Compose rig comes up cleanly; `SHOW CONFIG` matches expected values (1.2).
- [ ] All 7 Vitest tests are present and ran (1.7–1.13).
- [ ] `pgbench` baseline numbers captured (1.14).
- [ ] `k6` script present (1.15) — optional but ideal.
- [ ] CI matrix job exists and runs on relevant MRs (1.17).
- [ ] Validation report (1.18) is committed and signed off.
- [ ] Decision (1.19) is recorded and references the report's verdict.

**Exit criterion**: Phase 1 is green; **either Phase 2A or Phase 2B** begins (never both).

---

## Phase 2A — Transaction-mode rollout (conditional on Phase 1 PASS)

**Objective**: ship the validated transaction-mode configuration to the HA stack, wire `DATABASE_URL`/`DIRECT_URL` correctly, audit the app for unsafe statements, and stand up monitoring.

### Section 2A.1 — HA Compose updates

#### Task 2A.1.1 — Update `research/configs/postgres-ha/docker-compose.yml` PgBouncer service

**Agent**: `pipeline-architect`
**Files**:
- `research/configs/postgres-ha/docker-compose.yml`

**Exact line-by-line changes** (current file, lines 114–138):

| Line | Current | Replace with |
|---|---|---|
| 116 | `    image: edoburu/pgbouncer:latest` | `    image: edoburu/pgbouncer:1.25.0  # PgBouncer ≥ 1.21 required for max_prepared_statements` |
| 122 | `      DATABASE_URL: "postgres://postgres:${PG_PASSWORD}@127.0.0.1:5432/postgres"` | *(unchanged — keep `auth_file` posture; user decision Q2)* |
| 123 | `      POOL_MODE: transaction` | *(unchanged)* |
| 124 | `      MAX_CLIENT_CONN: 1000` | `      MAX_CLIENT_CONN: 500   # tuned per validation rig` |
| 125 | `      DEFAULT_POOL_SIZE: 25` | `      DEFAULT_POOL_SIZE: 50  # raised for HOPE projected scale (≤ 50 tenants)` |
| 126 | `      MIN_POOL_SIZE: 5` | *(unchanged)* |
| 127 | `      RESERVE_POOL_SIZE: 5` | `      RESERVE_POOL_SIZE: 10  # absorb deploy spikes` |
| 128 | `      RESERVE_POOL_TIMEOUT: 3` | *(unchanged)* |
| 129 | `      SERVER_LIFETIME: 3600` | *(unchanged)* |
| 130 | `      SERVER_IDLE_TIMEOUT: 600` | *(unchanged)* |
| 131 | `      LOG_CONNECTIONS: 1` | *(unchanged)* |
| 132 | `      LOG_DISCONNECTIONS: 1` | *(unchanged)* |
| 133 | `      LISTEN_PORT: 6432` | *(unchanged)* |

**New env vars to insert** (after line 133, before `depends_on:` on line 134):

```yaml
      # ── Prisma 7 transaction-mode requirements (Phase 2A, TASK-302) ──
      MAX_PREPARED_STATEMENTS: 200       # required for Prisma in txn mode (PgBouncer ≥ 1.21)
      SERVER_RESET_QUERY: 'DISCARD ALL'  # explicit (mirrors default)
      SERVER_RESET_QUERY_ALWAYS: 1       # force DISCARD ALL between transactions in txn mode
      IGNORE_STARTUP_PARAMETERS: extra_float_digits,search_path
      LOG_POOLER_ERRORS: 1
      AUTH_TYPE: scram-sha-256
```

**Steps**:

1. Apply the diff above. Verify `docker compose -f research/configs/postgres-ha/docker-compose.yml config` parses.

2. Commit: `feat(ha): transaction-mode PgBouncer tuning for Prisma 7 (MAX_PREPARED_STATEMENTS=200)`.

#### Task 2A.1.2 — Sync `research/deployments/deploy-vm500-502-postgres-ha.md`

**Agent**: `docs-manager`
**Files**:
- `research/deployments/deploy-vm500-502-postgres-ha.md` §2 (Component Versions table — bump PgBouncer to `1.25.0`) and §10 (Deploy PgBouncer Optional — update settings to match Task 2A.1.1 and remove "Optional" — PgBouncer is now an enabled component).

**Steps** (~20 min):

1. Update the Component Versions table row:

   ```
   | PgBouncer         | 1.25.0     | `edoburu/pgbouncer:1.25.0`                       |
   ```

2. Rewrite §10 to:
   - Drop "Optional" framing.
   - List the new env vars verbatim (mirror Task 2A.1.1).
   - Add a callout: *"Transaction mode + `MAX_PREPARED_STATEMENTS=200` is mandatory; do not change without re-running the validation rig in `packages/database/tests/pgbouncer-validation/`."*
   - Cross-link this plan (`docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md`).

3. Commit: `docs(ha): sync PgBouncer §10 with Phase 2A transaction-mode rollout`.

### Section 2A.2 — Application code audit

#### Task 2A.2.1 — Grep for transaction-mode-unsafe statements

**Agent**: `debugger`
**Files**: none (audit only).

**Steps** (~30 min):

1. Run the following greps from the workspace root (zsh):

   ```zsh
   # 1. Non-LOCAL SET statements
   rg -nt ts --pcre2 -- '(?<!LOCAL\s)\bSET\s+[a-zA-Z_]+\s*='
   # 2. LISTEN/NOTIFY
   rg -nt ts -- '\\bLISTEN\\b|\\bNOTIFY\\b'
   # 3. Session-scoped advisory locks
   rg -nt ts -- 'pg_advisory_lock\\('
   # 4. WITH HOLD cursors
   rg -nt ts --pcre2 -- '\\bWITH\\s+HOLD\\b'
   # 5. Temp tables
   rg -nt ts --pcre2 -- 'CREATE\\s+TEMP(ORARY)?\\s+TABLE'
   # 6. SQL-level PREPARE / DEALLOCATE
   rg -nt ts -- '\\$queryRaw.*\\bPREPARE\\b|\\$queryRaw.*\\bDEALLOCATE\\b'
   ```

2. **Expected today (per the pre-flight grep run for this plan)**: zero hits across `.ts` files outside `research/`.

3. Document the audit in a new file `docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-application-audit.md`:

   ```markdown
   # PgBouncer Transaction-Mode App-Code Audit

   | Pattern | Hits | Files | Resolution |
   |---|---|---|---|
   | Non-LOCAL SET | 0 | — | N/A |
   | LISTEN/NOTIFY | 0 | — | N/A |
   | pg_advisory_lock | 0 | — | N/A |
   | WITH HOLD | 0 | — | N/A |
   | CREATE TEMP TABLE | 0 | — | N/A |
   | PREPARE/DEALLOCATE | 0 | — | N/A |
   ```

   Update with real hits if any appear.

4. Commit: `docs(task-302): pgbouncer transaction-mode app-code audit`.

### Section 2A.3 — `DATABASE_URL` + `DIRECT_URL` wire-up

#### Task 2A.3.1 — Ensure `client.ts` reads `DATABASE_URL` (pooled) only

**Agent**: `database-admin`
**Files**:
- `packages/database/src/client.ts`

**Steps** (~10 min):

1. The existing logic already reads `DATABASE_URL` (line 49). No code change needed at runtime — `client.ts` should **never** read `DIRECT_URL` (migrations are the only consumer). Add a JSDoc note above `createPrismaClient` (around line 42):

   ```typescript
   /**
    * Create Prisma Client with PostgreSQL adapter.
    *
    * In Prisma 7, driver adapters own pool sizing — `connection_limit` URL params
    * are ignored. Pool size comes from `PRISMA_PG_MAX` (default 5).
    *
    * When DATABASE_URL points at PgBouncer (port 6432 in production), migrations
    * must use DIRECT_URL via prisma.config.ts to keep advisory locks intact.
    * @see docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-rollout.md
    */
   ```

2. Commit: `docs(database): clarify DATABASE_URL vs DIRECT_URL semantics in client.ts`.

#### Task 2A.3.2 — Update `prisma.config.ts` to prefer `DIRECT_URL`

**Agent**: `database-admin`
**Files**:
- `packages/database/prisma.config.ts`

**Steps** (TDD; ~15 min):

1. (RED) Add a Vitest unit test `packages/database/__tests__/prisma-config-direct-url.test.ts` that imports `prisma.config.ts`, stubs `process.env`, and asserts:
   - When `DIRECT_URL` is set, `datasource.url === process.env.DIRECT_URL`.
   - When `DIRECT_URL` is unset, `datasource.url === process.env.DATABASE_URL` (backwards-compat).

2. (GREEN) Edit `packages/database/prisma.config.ts` lines 31–47:

   ```typescript
   const databaseUrl = process.env.DATABASE_URL
   const directUrl = process.env.DIRECT_URL
   const migrationUrl = directUrl ?? databaseUrl

   if (!migrationUrl) {
     throw new Error(
       `DATABASE_URL (or DIRECT_URL) is not set. ` +
       `Environment: NODE_ENV=${nodeEnv}, CI=${isCI}. ` +
       (isCI
         ? `Ensure CI_DATABASE_URL is configured in GitLab CI/CD Variables.`
         : `Ensure .env.${nodeEnv === 'development' ? 'dev' : nodeEnv} exists at ${monorepoRoot} with DATABASE_URL defined.`)
     )
   }

   if (databaseUrl && directUrl && !directUrl.includes(':5432') && !directUrl.includes(':5000')) {
     // Soft warning: DIRECT_URL should target the direct PG port (5432 or HAProxy 5000),
     // not the pooler — Prisma Migrate's advisory locks break under transaction-mode pooling.
     console.warn(
       `[prisma.config] DIRECT_URL does not look direct (host:port suggests pooler). ` +
       `If this is intentional (session-mode pooler), ignore. Otherwise, set DIRECT_URL to PG port 5432/5000.`,
     )
   }

   export default defineConfig({
     schema: 'src/prisma/db_main',
     datasource: {
       url: migrationUrl,
     },
   })
   ```

3. Run the test → GREEN. Commit: `feat(database): prisma.config.ts prefers DIRECT_URL for migrations`.

#### Task 2A.3.3 — Update env templates + onboarding docs

**Agent**: `docs-manager`
**Files**:
- `.env.example`
- `.env.dev` (mark as `# DIRECT_URL=...` comment — do NOT hardcode credentials)
- `apps/api/README.md`
- `apps/api/.env.example`

**Steps** (~15 min):

1. In `.env.example`, replace the Phase 0 stub with the Phase 2A shape:

   ```bash
   # ── PostgreSQL + PgBouncer (Phase 2A of TASK-302 Stream C) ──
   # Pooled connection — port 6432 in production (PgBouncer transaction mode).
   DATABASE_URL=postgresql://hope_app:****@pgbouncer-vip:6432/hope?sslmode=require&schema=core

   # Direct (un-pooled) connection — port 5000 (HAProxy R/W) in production.
   # Required by Prisma Migrate (advisory locks need a stable backend).
   DIRECT_URL=postgresql://hope_app:****@pg-primary-vip:5000/hope?sslmode=require&schema=core

   # Prisma adapter pool size. Default 5.
   # Budget rule: pods * PRISMA_PG_MAX <= 0.7 * PG max_connections.
   PRISMA_PG_MAX=5
   ```

2. Add an "Operating with PgBouncer" subsection to `apps/api/README.md` that covers:
   - The `DATABASE_URL` vs `DIRECT_URL` split.
   - When to set `?pgbouncer=true` (only if `MAX_PREPARED_STATEMENTS = 0`; with `200` we leave it off and keep prepared-statement caching benefits).
   - Pre-warm guidance for production.

3. Commit: `docs: document DATABASE_URL + DIRECT_URL split for PgBouncer Phase 2A`.

### Section 2A.4 — `prisma.config.ts` migration routing

Covered by Task 2A.3.2. No separate task.

### Section 2A.5 — `pgbouncer_exporter` + Grafana

#### Task 2A.5.1 — Add `pgbouncer_exporter` to the HA stack

**Agent**: `pipeline-architect`
**Files**:
- `research/configs/postgres-ha/docker-compose.yml`

**Steps** (~20 min — append-only):

1. Append a new service alongside `postgres-exporter` (currently lines 140–153):

   ```yaml
     # ── Prometheus pgbouncer_exporter ──
     pgbouncer-exporter:
       image: prometheuscommunity/pgbouncer-exporter:v0.10.0
       container_name: pgbouncer-exporter
       hostname: pgbouncer-exporter-${NODE_NAME}
       restart: unless-stopped
       network_mode: host
       environment:
         PGBOUNCER_EXPORTER_HOST: 127.0.0.1
         PGBOUNCER_EXPORTER_PORT: 9127
         DATA_SOURCE_NAME: 'postgres://hope_metrics:${METRICS_PASSWORD}@127.0.0.1:6432/pgbouncer?sslmode=disable'
       depends_on:
         pgbouncer:
           condition: service_started
       profiles:
         - monitoring
   ```

2. Add the `hope_metrics` user to `pgbouncer.ini` `stats_users` (in `auth_file` / Patroni init seeds).

3. Commit: `feat(ha): add pgbouncer_exporter alongside postgres_exporter`.

#### Task 2A.5.2 — Add Prometheus scrape config

**Agent**: `pipeline-architect`
**Files**:
- `infrastructure/docker/configs/prometheus/prometheus.yml`

**Steps** (~10 min):

1. Add a scrape job:

   ```yaml
     - job_name: pgbouncer
       scrape_interval: 15s
       static_configs:
         - targets:
             - '10.10.1.200:9127'
             - '10.10.1.201:9127'
             - '10.10.1.202:9127'
           labels:
             cluster: hope-prod
   ```

2. Commit: `chore(monitoring): scrape pgbouncer_exporter on all HA nodes`.

#### Task 2A.5.3 — Grafana dashboard

**Agent**: `pipeline-architect`
**Files**:
- `infrastructure/docker/configs/grafana/dashboards/pgbouncer.json` (new — import community dashboard ID `13353` or hand-craft)

**Steps** (~30 min — accept longer):

1. Import the canonical PgBouncer dashboard from Grafana.com (ID 13353 or a current equivalent), commit the JSON to the repo, and add the panels HOPE specifically alerts on:
   - `pgbouncer_pools_client_waiting_connections` (cl_waiting)
   - `pgbouncer_pools_client_maxwait_seconds`
   - `pgbouncer_pools_server_active_connections` (sv_active)
   - `pgbouncer_pools_server_idle_connections`
   - `pgbouncer_stats_total_query_count` (rate)

2. Add alert rules in `infrastructure/docker/configs/prometheus/alerts.yml`:

   ```yaml
   groups:
     - name: pgbouncer.rules
       rules:
         - alert: PgBouncerClientWaiting
           expr: max(pgbouncer_pools_client_waiting_connections) > 0
           for: 1m
           labels: { severity: warning }
           annotations:
             summary: 'PgBouncer client waiting'
             description: 'Clients waiting >0 for 1 min — raise default_pool_size or fix slow queries.'
         - alert: PgBouncerMaxWaitHigh
           expr: max(pgbouncer_pools_client_maxwait_seconds) > 1
           for: 30s
           labels: { severity: page }
           annotations:
             summary: 'PgBouncer maxwait > 1 s'
         - alert: PgBouncerPoolSaturated
           expr: (pgbouncer_pools_server_active_connections / on(database,user) group_left() pgbouncer_pools_default_pool_size) > 0.9
           for: 5m
           labels: { severity: warning }
   ```

3. Commit: `feat(monitoring): grafana dashboard + prometheus alerts for pgbouncer`.

### Section 2A.6 — Smoke test suite

#### Task 2A.6.1 — Production smoke test script

**Agent**: `database-admin`
**Files**:
- `scripts/smoke-pgbouncer.sh` (new)

**Steps** (~30 min — Infra task; accept longer):

```bash
#!/usr/bin/env zsh
# scripts/smoke-pgbouncer.sh — Production smoke tests per research §8.3
set -euo pipefail

POOLED_HOST="${POOLED_HOST:?set POOLED_HOST (e.g., pgbouncer-vip)}"
POOLED_PORT="${POOLED_PORT:-6432}"
ADMIN_USER="${ADMIN_USER:-hope_admin}"
APP_USER="${APP_USER:-hope_app}"
DB="${DB:-hope}"

echo '── 1. Pooler accepts a connection & authenticates ──'
PGPASSWORD="$APP_PG_PASSWORD" psql "host=$POOLED_HOST port=$POOLED_PORT user=$APP_USER dbname=$DB sslmode=require" \
  -c 'SELECT version();'

echo '── 2. Pool stats are sane ──'
PGPASSWORD="$ADMIN_PG_PASSWORD" psql "host=$POOLED_HOST port=$POOLED_PORT user=$ADMIN_USER dbname=pgbouncer sslmode=require" \
  -c 'SHOW POOLS;'

echo '── 3. Prisma can run a real query through the pooler ──'
pnpm --filter @arcaai/api exec ts-node -e \
  "import {getPrismaClient} from '@arcaai/database';\
   getPrismaClient().tenant.count().then(c => console.log('tenants:', c)).then(() => process.exit(0));"

echo '── 4. Transaction-scoped tenant context works ──'
PGPASSWORD="$APP_PG_PASSWORD" psql "host=$POOLED_HOST port=$POOLED_PORT user=$APP_USER dbname=$DB sslmode=require" <<SQL
BEGIN;
SELECT set_config('app.current_tenant_id', '00000000-0000-0000-0000-000000000001', true);
SELECT current_setting('app.current_tenant_id', true) AS tenant;
COMMIT;
SQL

echo '── 5. Tenant context did NOT leak ──'
PGPASSWORD="$APP_PG_PASSWORD" psql "host=$POOLED_HOST port=$POOLED_PORT user=$APP_USER dbname=$DB sslmode=require" \
  -c "SELECT current_setting('app.current_tenant_id', true) AS leaked;"
echo 'expect "leaked" column empty/null on a fresh transaction'

echo '── Smoke tests OK ──'
```

Commit: `chore(ops): smoke test script for PgBouncer cutover`.

#### Task 2A.6.2 — CI job to run smoke tests against staging

**Agent**: `cicd-manager`
**Files**:
- `.gitlab-ci.yml`

**Steps** (~20 min — accept longer):

Add a manual / scheduled job that ssh-runs `scripts/smoke-pgbouncer.sh` against the staging pgbouncer endpoint. Commit: `ci: smoke-pgbouncer manual job for staging`.

### Code Review Gate 2A

**Agent**: `code-reviewer`
**Inputs**: diff of Tasks 2A.1–2A.6.

**Checklist**:
- [ ] `research/configs/postgres-ha/docker-compose.yml` lines 116, 124–125, 127, and new env block reflect the exact diffs in Task 2A.1.1.
- [ ] HA blueprint §2 and §10 are in sync (Task 2A.1.2).
- [ ] App-code audit ran clean (Task 2A.2.1) and the audit file is committed.
- [ ] `prisma.config.ts` prefers `DIRECT_URL` (Task 2A.3.2) and the test passes.
- [ ] `.env.example` and `apps/api/README.md` document both URLs (Task 2A.3.3).
- [ ] `pgbouncer_exporter` service is added (Task 2A.5.1), scraped (Task 2A.5.2), dashboard + alerts committed (Task 2A.5.3).
- [ ] Smoke script (`scripts/smoke-pgbouncer.sh`) is executable and CI-runnable.
- [ ] No new lint or build errors.
- [ ] `security-auditor` subagent has signed off on the `auth_file` permissions, `server_tls_sslmode=verify-full` (or documented exception), and that no credentials are committed.

**Exit criterion**: Phase 2A green; Phase 3 may begin.

---

## Phase 2B — Session-mode rollout (alternative, only if Phase 1 FAIL)

**Objective**: ship session-mode PgBouncer per the research doc §6.1 baseline. Differences from Phase 2A are tightly localized.

> **Important**: Phase 2B is **mutually exclusive** with Phase 2A. Do not implement both. Phase 1's recorded decision (Task 1.19) picks one.

### Section 2B.1 — HA Compose updates

#### Task 2B.1.1 — Switch the existing PgBouncer service to session mode

**Agent**: `pipeline-architect`
**Files**:
- `research/configs/postgres-ha/docker-compose.yml`

**Exact diffs** (current file, lines 114–138):

| Line | Current | Replace with |
|---|---|---|
| 116 | `    image: edoburu/pgbouncer:latest` | `    image: edoburu/pgbouncer:1.25.0` |
| 123 | `      POOL_MODE: transaction` | `      POOL_MODE: session` |
| 124 | `      MAX_CLIENT_CONN: 1000` | `      MAX_CLIENT_CONN: 500` |
| 125 | `      DEFAULT_POOL_SIZE: 25` | `      DEFAULT_POOL_SIZE: 50` |
| 126 | `      MIN_POOL_SIZE: 5` | *(unchanged)* |
| 127 | `      RESERVE_POOL_SIZE: 5` | `      RESERVE_POOL_SIZE: 10` |
| 128 | `      RESERVE_POOL_TIMEOUT: 3` | *(unchanged)* |

**New env vars** (insert after line 133):

```yaml
      # ── session-mode hygiene ──
      SERVER_RESET_QUERY: 'DISCARD ALL'  # runs between client checkouts
      IGNORE_STARTUP_PARAMETERS: extra_float_digits,search_path
      LOG_POOLER_ERRORS: 1
      AUTH_TYPE: scram-sha-256
      MAX_DB_CONNECTIONS: 80  # < PG max_connections - admin slots
```

**Do not set** `MAX_PREPARED_STATEMENTS` or `SERVER_RESET_QUERY_ALWAYS` in session mode — they are no-ops at best, sources of surprise at worst.

**Steps**:

1. Apply the diff. Commit: `feat(ha): session-mode PgBouncer per Phase 2B (Phase 1 validation failed)`.

#### Task 2B.1.2 — Sync HA blueprint

Same shape as Task 2A.1.2, with session-mode settings. Cross-link the Phase 1 failure report.

### Section 2B.2 — Skip application code audit

Session mode preserves session-level features (`SET`, `LISTEN`, `NOTIFY`, advisory locks, temp tables, `WITH HOLD` cursors, prepared statements). The grep audit is unnecessary. **Still** verify migrations use `DIRECT_URL` — see Section 2B.3.

### Section 2B.3 — `DATABASE_URL` + `DIRECT_URL` wire-up

Mirror Tasks 2A.3.1–2A.3.3 verbatim, with one omission: **do NOT** add `?pgbouncer=true` to `DATABASE_URL` in `.env.example` — session mode supports named prepared statements natively. The `prisma.config.ts` change (Task 2A.3.2) is identical and applies.

### Section 2B.4 — `pgbouncer_exporter` + Grafana

Same as Section 2A.5 — exporter is mode-agnostic. The Grafana alert thresholds (cl_waiting, maxwait) are identical.

### Section 2B.5 — Smoke test suite

Same as Section 2A.6.

### Code Review Gate 2B

**Agent**: `code-reviewer`
**Inputs**: diff of Tasks 2B.1–2B.5.

**Checklist**: same as Gate 2A except verify `POOL_MODE: session` and confirm `MAX_PREPARED_STATEMENTS` and `SERVER_RESET_QUERY_ALWAYS` are **absent** from the Compose env block.

**Exit criterion**: Phase 2B green; Phase 3 may begin.

---

## Phase 3 — Production deployment with rollback

**Objective**: cut staging over to PgBouncer (mode chosen by Phase 1), soak for one week, then promote to production with a rehearsed rollback. Use the chosen mode (Phase 2A or 2B) — the runbook below is mode-agnostic.

### Section 3A — Staging soak

#### Task 3A.1 — Deploy to staging

**Agent**: `database-admin`
**Files**: none (deployment).

**Steps** (~2 hours):

1. Set `DATABASE_URL` and `DIRECT_URL` in staging secrets (or env file) per Task 2A.3.3 / 2B.3.

2. Restart the staging PgBouncer profile:

   ```zsh
   ssh db0-staging 'cd ~/postgres-ha && docker compose --profile pgbouncer --profile monitoring up -d'
   ```

3. Rolling-restart API pods in staging.

4. Verify with `scripts/smoke-pgbouncer.sh`.

#### Task 3A.2 — 7-day soak

**Agent**: `database-admin` (monitoring; backend lead spot-checks)
**Files**:
- `docs/implementation/TASK-302-System-Config-Implementation-Roadmap/03-pgbouncer-soak-log.md` (new — daily log)

**Steps** (Infra task; 1 week elapsed, ~20 min/day active):

1. Daily checks:
   - `SHOW POOLS` (expect `cl_waiting = 0`, `maxwait_seconds = 0`).
   - Grafana p95 latency vs pre-cutover baseline.
   - Error log scan for `prepared statement does not exist`, `sorry, too many clients`, `P1017`.

2. Acceptance: **zero** of the above three error patterns over 7 days; p95 within 15 % of baseline.

3. Commit daily summary to the soak log.

### Section 3B — Pre-warm + rolling restart (production)

#### Task 3B.1 — Pre-warm PgBouncer pools

**Agent**: `database-admin`

**Steps** (~10 min):

1. With `min_pool_size = 5` already set, force pool population:

   ```zsh
   for n in pg-node1 pg-node2 pg-node3; do
     PGPASSWORD="$ADMIN_PG_PASSWORD" psql "host=$n port=6432 user=hope_admin dbname=pgbouncer sslmode=require" -c 'RELOAD;'
   done
   ```

2. Verify with `SHOW POOLS` — each (database, user) pair should show `sv_idle ≥ 5`.

#### Task 3B.2 — Rolling restart of API pods

**Agent**: `database-admin` + on-call SRE
**Files**: none.

**Steps** (~30 min):

1. Update production env (`DATABASE_URL` → pooled, `DIRECT_URL` → direct).

2. Rolling restart one API pod at a time:
   - Drain (LB de-register).
   - `docker compose restart api-gateway` (or systemd equivalent in `infrastructure/single-deployment/`).
   - Wait for health check.
   - Re-register.
   - Verify via `pgbouncer SHOW CLIENTS` that the new pod is connecting through the pooler.

3. Repeat for all pods.

### Section 3C — Rollback procedure rehearsal

#### Task 3C.1 — Dry-run rollback in staging

**Agent**: `database-admin`

**Steps** (~30 min — accept longer):

1. In staging, flip `DATABASE_URL` back to the HAProxy R/W direct endpoint (`pg-primary-vip:5000`). Keep `DIRECT_URL` unchanged.

2. Rolling restart staging API pods.

3. Verify with `scripts/smoke-pgbouncer.sh` — step 1 now connects to PG directly; step 2 (`SHOW POOLS`) hits a dormant pgbouncer (`cl_active = 0`).

4. Flip back to pooled `DATABASE_URL` (we don't leave staging in rollback state).

5. Document the rehearsal in the soak log.

**Per research §8.2**: this is config-only — **no schema change required**. Rollback time ≤ 5 minutes for a rolling restart.

### Section 3D — Production cutover

#### Task 3D.1 — Schedule + announce

**Agent**: `project-manager` (or backend lead)

**Steps** (~30 min):

1. Pick a low-traffic maintenance window.

2. Announce in #engineering and to stakeholders 48 h ahead. Include rollback plan and on-call contact.

#### Task 3D.2 — Cutover

**Agent**: `database-admin` + on-call SRE

**Steps** (~30 min active):

1. Execute Tasks 3B.1 → 3B.2 against production.

2. Run `scripts/smoke-pgbouncer.sh` against production.

3. Spot-check Grafana for 30 min post-cutover.

#### Task 3D.3 — 24h post-cutover monitoring

**Agent**: `database-admin` + on-call SRE

**Steps** (Infra task; 24h elapsed):

1. Hourly Grafana checks; page-out on the alert rules from Task 2A.5.3.

2. After 24 h with no incident, declare cutover stable.

#### Task 3D.4 — Sign-off

**Agent**: `docs-manager` (records); `database-admin` + SRE (approvers)

**Steps** (~15 min):

1. Append to this plan's "Change History":

   ```markdown
   - **YYYY-MM-DD** — Phase 3 cutover completed; mode = transaction|session; 24h soak clean; signed off by <DBA> and <SRE>.
   ```

2. Close TASK-302 Stream C in the ticket tracker.

3. Open follow-up tickets per Appendix A as priorities dictate.

### Final Code Review Gate

**Agent**: `code-reviewer` + `database-admin` + on-call SRE (joint sign-off)
**Inputs**: full TASK-302 Stream C diff + soak log + smoke results.

**Checklist**:
- [ ] Phase 0, 1, 2A or 2B, 3 are all green.
- [ ] HA blueprint, this plan, and the validation report are mutually consistent (no drift).
- [ ] All smoke tests pass against production.
- [ ] 24h post-cutover monitoring is clean.
- [ ] Rollback was rehearsed in staging.
- [ ] `security-auditor` has signed off on TLS, `auth_file` permissions, and that no credentials are committed.
- [ ] All commits follow the project's commit-message convention.
- [ ] Cross-stream dependency note (Stream B Phase 5 — Vault DB creds) is updated to "this stream is unblocked".

**Exit criterion**: TASK-302 Stream C is **Completed**.

---

## Appendix A — Future Triggers (out of scope here)

| Trigger | Action when fired | Reference |
|---|---|---|
| **Vault DB credentials land (Stream B Phase 5)** | Migrate `auth_file` → `auth_query` against a Vault-rendered userlist. Tracked separately. | `research/architecture/system-config-multi-tenancy/02-secrets-cloud-kms-migration.md` |
| **Read traffic > 5 × write traffic** | Add a second `DATABASE_URL_RO` (or upgrade to pgcat for native R/W splitting). Application code needs splitting hooks first. | Research doc §10 Q4 |
| **Active connections > 1000 sustained** | Evaluate pgcat (multi-threaded) or scale to multiple PgBouncer processes per node. | Research doc §10 Q5 (TBD) |
| **`auth_query` rollout** | Replace `userlist.txt` with a `SECURITY DEFINER` function in `pgbouncer` role. | Research doc §10 Q2 (deferred per user) |
| **Adopt Prisma 8 (when released)** | Re-validate the entire Phase 1 rig — adapter semantics may change. | — |
| **Add a second pooler tier** (e.g., for batch/ETL) | Use the existing session-mode profile on a separate port. | Research doc §7.3 |

---

## Appendix B — Detailed monitoring runbook

### Healthy steady state

| Metric | Healthy | Investigate |
|---|---|---|
| `cl_active` (clients with active backend) | < 80 % of `default_pool_size` | > 90 % sustained |
| `cl_waiting` | 0 | > 0 for > 1 min |
| `maxwait_seconds` | 0 | > 1 |
| `sv_active` | < `default_pool_size` | = `default_pool_size` sustained |
| `sv_idle` | ≥ `min_pool_size` | 0 sustained |
| `pg_stat_activity` count | < 0.8 × `max_connections` | > 0.9 × `max_connections` |
| App p95 latency | within 15 % of pre-cutover baseline | > 30 % regression |

### Common queries

```sql
-- From inside the pgbouncer admin DB (psql -h ... -p 6432 -U hope_admin pgbouncer):
SHOW POOLS;       -- per (database, user) pool status
SHOW STATS;       -- cumulative counters
SHOW CLIENTS;     -- inbound connections (one row per client)
SHOW SERVERS;     -- outbound backends (one row per PG conn)
SHOW CONFIG;      -- effective config (verify env-var translation)
RELOAD;           -- re-read pgbouncer.ini without dropping clients
PAUSE <db>;       -- drain (use for safe maintenance)
RESUME <db>;
```

```sql
-- From inside the application DB (port 5432 / 5000), classic operator:
SELECT pid, usename, application_name, state, wait_event_type, wait_event,
       query_start, now() - query_start AS elapsed, query
FROM pg_stat_activity
WHERE datname = 'hope' AND state != 'idle'
ORDER BY query_start NULLS LAST;
```

### Page-out signals

| Alert (from Task 2A.5.3) | Page severity | First-response |
|---|---|---|
| `PgBouncerClientWaiting` | warning | Check `SHOW POOLS` for the busy (db,user); raise `default_pool_size` or kill long queries. |
| `PgBouncerMaxWaitHigh` | page | A query is pinning a backend. Find via `pg_stat_activity`; consider cancel. |
| `PgBouncerPoolSaturated` | warning | Sustained → scale `default_pool_size`. Spike → expected during traffic peak. |

---

## Appendix C — Decision tree: when to revisit

```
Did the validation rig (Phase 1) PASS?
│
├─ YES → Phase 2A (transaction mode)
│        │
│        └─ Did production 24h soak (3D.3) succeed?
│           │
│           ├─ YES → Stream C COMPLETE. Re-validate when:
│           │       • Prisma major version bumps
│           │       • PgBouncer version bumps
│           │       • Application code adds SET (no LOCAL), LISTEN, NOTIFY,
│           │         pg_advisory_lock, WITH HOLD, or CREATE TEMP TABLE
│           │
│           └─ NO  → Roll back per §3C; analyze with `debugger`; either re-run
│                   Phase 1 with a tighter test or fall to Phase 2B.
│
└─ NO  → Phase 2B (session mode)
         │
         └─ Did production 24h soak succeed?
            │
            ├─ YES → Stream C COMPLETE. Re-evaluate transaction mode when:
            │       • Active connections approach 200 (PG ceiling)
            │       • Prisma releases a version that explicitly improves
            │         transaction-mode compatibility (track upstream)
            │       • Tenant count grows past ~150 (re-evaluate budget math)
            │
            └─ NO  → Roll back; pgcat is the next escalation target.
```

---

## Change History

- **2026-05-24** — Plan authored by `planner` subagent. Anchors: research doc §10 user-locked answers (transaction mode kept iff Prisma validation passes; `auth_file` kept; PgBouncer per-node; `DATABASE_URL` + `DIRECT_URL` split). Status: Pending. No source code modified.
