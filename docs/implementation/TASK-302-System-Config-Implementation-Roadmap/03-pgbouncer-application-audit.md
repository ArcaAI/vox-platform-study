# PgBouncer Transaction-Mode App-Code Audit

| Field | Value |
|---|---|
| Ticket | TASK-302 Stream C, Phase 2A Task 2A.2.1 |
| Date | 2026-05-24 |
| Auditor | Stream C executor |
| Scope | All `*.ts` files outside `research/`, `docs/`, and the validation rig (`packages/database/tests/pgbouncer-validation/`) |
| Tool | Cursor's `Grep` (ripgrep), with the patterns mandated by plan §2A.2.1 |
| Result | **PASS** with one Minor advisory (test-helper non-LOCAL SET pair) |

---

## Findings

| # | Pattern | Hits | Files | Severity | Resolution |
|---|---|---|---|---|---|
| 1 | Non-LOCAL `SET <name> =` | 2 | `tests/helpers/db.helper.ts:56,69` | **Minor** | Test-only helper used in E2E setup/teardown. Runs against the test DB (Phase 1 rig or `apps/api`'s own test database), **not** the production pooler. Documented in §"Advisory" below; no code change made (rule: "don't improve adjacent code"). |
| 2 | `LISTEN` / `NOTIFY` | 0 | — | — | N/A |
| 3 | `pg_advisory_lock(` | 0 | — | — | N/A |
| 4 | `WITH HOLD` cursors | 0 | — | — | N/A |
| 5 | `CREATE TEMP TABLE` | 0 | — | — | N/A |
| 6 | SQL-level `PREPARE` / `DEALLOCATE` via `$queryRaw*` | 0 | — | — | N/A |

> All patterns scanned against the worktree at `feat/task-302-stream-c` HEAD `dd5d8c3`.

## Advisory — `tests/helpers/db.helper.ts`

```typescript
// Disable foreign key checks
await client.$executeRaw`SET session_replication_role = 'replica'`;
// ... TRUNCATE TABLE … CASCADE …
// Re-enable foreign key checks
await client.$executeRaw`SET session_replication_role = 'origin'`;
```

Both `SET` statements are session-scoped (no `LOCAL`). In transaction
mode, each `$executeRaw` call is its own transaction and pgbouncer is
free to return the backend to the pool between the three calls. If
this helper ever connects through the production pooler, the
`'replica'` setting can leak to whichever client grabs the same
backend next.

**Why this is not blocking the rollout**:

1. The helper is used by E2E test suites only. E2E tests target a
   dedicated test database, not the production pooler.
2. The companion `tests/helpers/db.helper.ts:setupTestDatabase()` and
   `resetDatabase()` are invoked by `tests/` setup scripts that use
   `process.env.DATABASE_URL` from the test environment (typically a
   direct PG connection to a containerised PG).
3. The two SETs are paired — even on leakage, the **next**
   `resetDatabase()` call corrects state.
4. Refactoring the helper to wrap the three statements in a single
   `$transaction(async tx => …)` would also be a behaviour change
   that the Karpathy rule ("touch only what you must") asks us not to
   make as part of the rollout. Flagged for a follow-up if/when tests
   are pointed at the pooler.

**Follow-up ticket (if E2E ever runs through pgbouncer)**: refactor
`resetDatabase` to wrap the SET-TRUNCATE-SET sequence in a single
`$transaction`. The current `TRUNCATE TABLE … CASCADE` in line 61 is
also a destructive DDL guarded only by the test-DB convention and would
need its own review under the workspace rule on DELETE/DROP/TRUNCATE.

## Verification command (reproducible)

```bash
# Audit (run from /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2-worktrees/stream-c)
rg -nt ts --pcre2 '(?<!LOCAL\s)\bSET\s+[a-zA-Z_]+\s*=' \
  --glob '!research/**' --glob '!docs/**' \
  --glob '!packages/database/tests/pgbouncer-validation/**'

rg -nt ts '\bLISTEN\b|\bNOTIFY\b'                       --glob '!research/**' --glob '!docs/**' --glob '!packages/database/tests/pgbouncer-validation/**'
rg -nt ts 'pg_advisory_lock\('                          --glob '!research/**' --glob '!docs/**' --glob '!packages/database/tests/pgbouncer-validation/**'
rg -nt ts --pcre2 '\bWITH\s+HOLD\b'                     --glob '!research/**' --glob '!docs/**' --glob '!packages/database/tests/pgbouncer-validation/**'
rg -nt ts --pcre2 'CREATE\s+TEMP(ORARY)?\s+TABLE'       --glob '!research/**' --glob '!docs/**' --glob '!packages/database/tests/pgbouncer-validation/**'
rg -nt ts '\$queryRaw.*\bPREPARE\b|\$queryRaw.*\bDEALLOCATE\b' --glob '!research/**' --glob '!docs/**' --glob '!packages/database/tests/pgbouncer-validation/**'
```

## Verdict

The HOPE app code (NestJS API + supporting TS packages) does **not**
contain any production-runtime statements that are unsafe under
PgBouncer transaction mode. Phase 2A may proceed. The one test-helper
finding is advisory only and tracked in this document.
